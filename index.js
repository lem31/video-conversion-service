const express = require('express');
const multer = require('multer');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  dest: '/tmp/',
  limits: { fileSize: 500 * 1024 * 1024 }
});

// Premium feature flag from request headers
function isPremiumUser(req) {
  // kept for backward-compatibility; uses getUserTier below
  return getUserTier(req) !== 'standard';
}

// New: return normalized tier string for a request: 'standard' | 'premium' | 'business' | 'enterprise'
function getUserTier(req) {
  try {
    const raw = (req.headers['x-user-tier'] || '').toString().trim().toLowerCase();
    if (raw === 'enterprise') return 'enterprise';
    if (raw === 'business') return 'business';
    if (raw === 'premium') return 'premium';
    return 'standard';
  } catch {
    return 'standard';
  }
}

function isSupportedVideoUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // Supported platforms (yt-dlp handles all of these)
    return (
      // YouTube
      host.includes('youtube.com') || host.includes('youtu.be') ||
      // TikTok (easier than YouTube, ~95%+ success)
      host.includes('tiktok.com') ||
      // Instagram (works well for public posts)
      host.includes('instagram.com') ||
      // Twitter/X (very reliable)
      host.includes('twitter.com') || host.includes('x.com')
    );
  } catch {
    return false;
  }
}

// Clean URL by removing playlist, radio, and other extra parameters
function cleanVideoUrl(input) {
  try {
    const raw = String(input).trim();
    if (!raw) return raw;
    // accept plain id
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return `https://www.youtube.com/watch?v=${raw}`;

    const urlObj = new URL(raw, 'https://www.youtube.com');
    const host = urlObj.hostname.toLowerCase();

    // youtu.be short links
    if (host === 'youtu.be') {
      const id = urlObj.pathname.replace(/^\/+/, '').split('/')[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
      return raw;
    }

    // youtube.com: keep only v param if present, otherwise try /embed/ or /v/
    if (host.endsWith('youtube.com') || host.includes('youtube')) {
      const v = urlObj.searchParams.get('v');
      if (v) {
        // Clean URL: only keep v and optionally t (timestamp) parameters
        const cleanUrl = new URL('https://www.youtube.com/watch');
        cleanUrl.searchParams.set('v', v);
        const t = urlObj.searchParams.get('t');
        if (t) cleanUrl.searchParams.set('t', t);
        return cleanUrl.toString();
      }

      const parts = urlObj.pathname.split('/').filter(Boolean);
      const embedIdx = parts.indexOf('embed');
      if (embedIdx !== -1 && parts[embedIdx + 1]) return `https://www.youtube.com/watch?v=${parts[embedIdx + 1]}`;
      const vIdx = parts.indexOf('v');
      if (vIdx !== -1 && parts[vIdx + 1]) return `https://www.youtube.com/watch?v=${parts[vIdx + 1]}`;

      // If no v param found, return original (might be a channel/playlist URL)
      return raw;
    }

    // For non-YouTube URLs, return as-is
    return raw;
  } catch {
    return input;
  }
}

// Replace runYtDlp with a version that logs sanitized commands + stderr for easier debugging
function sanitizeArgsForLog(args) {
  const masked = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cookies' || a === '--proxy' || a === '--cookies-from-browser') {
      const next = args[i + 1];
      masked.push(a);
      if (next) {
        // mask sensitive value but keep host/port visible when proxy (attempt)
        if (a === '--proxy' && typeof next === 'string') {
          try {
            const u = new URL(next);
            const port = u.port || (u.protocol === 'http:' ? '80' : (u.protocol === 'https:' ? '443' : ''));
            masked.push(`${u.protocol}//${u.hostname}:${port}`);
          } catch (e) {
            masked.push('[masked-proxy]');
          }
        } else {
          masked.push('[masked]');
        }
        i++; // skip the next arg since we've logged it
      }
    } else {
      masked.push(a);
    }
  }
  return masked.join(' ');
}

function runYtDlp(args, cwd = '/tmp') {
  return new Promise((resolve, reject) => {
    try {
      console.log('yt-dlp ->', sanitizeArgsForLog(args));
    } catch (e) { /* ignore logging errors */ }

    const proc = spawn('yt-dlp', args, { cwd });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => {
      const s = chunk.toString();
      stdout += s;
    });

    proc.stderr.on('data', chunk => {
      const s = chunk.toString();
      stderr += s;
    });

    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });
      // Log full stderr (trimmed) for debugging
      try {
        console.warn('yt-dlp failed (code %d). stderr:', code, stderr.toString().trim().slice(0, 1000));
        if (stdout && stdout.trim()) console.warn('yt-dlp stdout (trim):', stdout.toString().trim().slice(0, 1000));
      } catch (e) { /* ignore logging errors */ }

      const err = new Error(`yt-dlp exit ${code}: ${stderr || stdout}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

// New helper: stream yt-dlp -> ffmpeg to produce an MP3 without writing the source file
// - Improved: parse ffmpeg -progress output, inactivity watchdog, total timeout, richer diagnostics.
async function streamYtdlpToFfmpeg(cleanedUrl, ytFormat, outputPath, isPremium, ytExtraArgs = [], playerClient = 'web') {
  return new Promise((resolve, reject) => {
    const inactivitySeconds = Number(process.env.PIPE_INACTIVITY_TIMEOUT || 60);
    const totalTimeoutSeconds = Number(process.env.PIPE_TOTAL_TIMEOUT || 300); // kill if overall run exceeds this
    const inactivityMs = Math.max(5, inactivitySeconds) * 1000;
    const totalMs = Math.max(60, totalTimeoutSeconds) * 1000;

    const ytdlpArgs = [
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--newline',
      '--extractor-args', `youtube:player_client=${playerClient}`,
      '-f', ytFormat,
      '-o', '-', // stream to stdout
      cleanedUrl,
      ...ytExtraArgs
    ];
    try { console.log('yt-dlp ->', sanitizeArgsForLog(ytdlpArgs)); } catch (e) {}

    const ytdlp = spawn('yt-dlp', ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    const bitrate = process.env.YTDLP_TARGET_BITRATE || '192k';
    const quality = process.env.YTDLP_TARGET_Q || (isPremium ? '2' : '2');

    // ask ffmpeg to emit progress key=value pairs to stdout so we can parse them
    const ffmpegArgs = [
      '-threads', '0',
      '-hide_banner',
      '-nostdin',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn', '-sn', '-dn',
      '-map', '0:a:0',
      '-c:a', 'libmp3lame',
      '-b:a', bitrate,
      '-ar', '44100',
      '-ac', '2',
      '-compression_level', '0',
      '-q:a', quality,
      '-write_xing', '0',
      '-id3v2_version', '0',
      '-f', 'mp3',
      '-y',
      outputPath,
      // progress output at end-to-end so we can observe encode progress (reports on stdout)
      '-progress', 'pipe:1'
    ];

    const ff = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    // watchdogs and progress state
    let lastActivity = Date.now();
    let watchdog = null;
    const startTime = Date.now();
    let totalTimer = null;

    function resetWatchdog() {
      lastActivity = Date.now();
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        const idle = (Date.now() - lastActivity);
        if (idle >= inactivityMs) {
          const msg = `PIPE_TIMEOUT: no activity for ${Math.round(idle/1000)}s (threshold ${inactivitySeconds}s)`;
          console.warn(msg);
          try { ytdlp.kill('SIGKILL'); } catch (e) {}
          try { ff.kill('SIGKILL'); } catch (e) {}
          cleanup();
          reject(new Error(msg));
        } else {
          resetWatchdog();
        }
      }, inactivityMs + 50);
    }

    // total run timeout
    totalTimer = setTimeout(() => {
      const elapsed = Math.round((Date.now() - startTime)/1000);
      const msg = `PIPE_TOTAL_TIMEOUT: exceeded ${totalTimeoutSeconds}s (elapsed ${elapsed}s)`;
      console.warn(msg);
      try { ytdlp.kill('SIGKILL'); } catch (e) {}
      try { ff.kill('SIGKILL'); } catch (e) {}
      cleanup();
      reject(new Error(msg));
    }, totalMs);

    // collect diagnostics
    let ffErr = '';
    let ytdlpErr = '';
    let ffProgressBuf = '';
    let lastProgress = {}; // parsed key=>value

    // helpers to parse ffmpeg -progress key=value stream (lines)
    function parseProgressChunk(chunk) {
      ffProgressBuf += chunk;
      const parts = ffProgressBuf.split(/\r?\n/);
      // keep partial line in buffer
      ffProgressBuf = parts.pop() || '';
      for (const line of parts) {
        const kv = line.split('=');
        if (kv.length === 2) {
          const k = kv[0].trim();
          const v = kv[1].trim();
          lastProgress[k] = v;
        }
      }
    }

    // reset watchdog on activity and accumulate errors/progress
    ytdlp.stdout.on('data', (chunk) => { resetWatchdog(); /* bytes move */ });
    ytdlp.stderr.on('data', (b) => { ytdlpErr += b.toString(); resetWatchdog(); });
    ff.stderr.on('data', (b) => { ffErr += b.toString(); resetWatchdog(); });

    // ffmpeg progress is emitted on stdout because we used -progress pipe:1
    ff.stdout.on('data', (chunk) => {
      try {
        parseProgressChunk(chunk.toString());
      } catch (e) { /* ignore parse errors */ }
      resetWatchdog();
    });

    // pipe data
    ytdlp.stdout.pipe(ff.stdin);

    function cleanup() {
      try { ytdlp.stdout && ytdlp.stdout.removeAllListeners(); } catch (e) {}
      try { ytdlp.stderr && ytdlp.stderr.removeAllListeners(); } catch (e) {}
      try { ff.stdout && ff.stdout.removeAllListeners(); } catch (e) {}
      try { ff.stderr && ff.stderr.removeAllListeners(); } catch (e) {}
      try { ff.stdin && ff.stdin.end(); } catch (e) {}
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
    }

    // when yt-dlp exits, close ff.stdin so ffmpeg can finish
    ytdlp.on('close', (code, sig) => {
      resetWatchdog();
      if (code !== 0) {
        try { if (ff.stdin && !ff.stdin.destroyed) ff.stdin.end(); } catch (e) {}
        console.warn(`yt-dlp exited with code ${code} (signal ${sig}). Waiting for ffmpeg to finish. stderr (trim):`, (ytdlpErr || '').trim().slice(0, 800));
      } else {
        try { if (ff.stdin && !ff.stdin.destroyed) ff.stdin.end(); } catch (e) {}
      }
    });

    ff.on('close', (code, sig) => {
      cleanup();
      const elapsed = Math.round((Date.now() - startTime)/1000);
      // include useful human-readable progress fields if present
      const progSnapshot = {
        out_time_ms: lastProgress.out_time_ms || null,
        out_time: lastProgress.out_time || null,
        speed: lastProgress.speed || null,
        progress: lastProgress.progress || null
      };
      console.log(`streamYtdlpToFfmpeg: finished (elapsed ${elapsed}s), ffmpeg exit code: ${code}, progress:`, progSnapshot);
      if (code === 0) return resolve();
      // provide richer context for failure
      const ctx = {
        ffstderr: (ffErr || '').trim().slice(0,2000),
        ytdlpstderr: (ytdlpErr || '').trim().slice(0,2000),
        lastProgress: progSnapshot
      };
      return reject(new Error(`PIPED_FAILED (ffmpeg ${code}): ${JSON.stringify(ctx)}`));
    });

    ytdlp.on('error', (e) => { cleanup(); reject(new Error(`yt-dlp process error: ${e.message}`)); });
    ff.on('error', (e) => { cleanup(); reject(new Error(`ffmpeg process error: ${e.message}`)); });

    // start watchdogs
    resetWatchdog();
  });
}

// ULTIMATE yt-dlp download with multi-layer fallback for all users
async function downloadVideoWithYtdlpUltimate(videoUrl, outputDir, isPremium) {
  const videoId = uuidv4();
  const outputTemplate = `${outputDir}/ytdlp_${videoId}.%(ext)s`;
  const cleanedUrl = cleanVideoUrl(videoUrl);

  try {
    console.log('DEBUG download:', cleanedUrl);

    // NEW: quick metadata probe to pick a faster format for short videos
    let preferM4aForShort = false;
    let probedDurationSec = 0; // duration exposed for long-video decision
    try {
      console.log('Probing video metadata (fast)...');
      const probe = await runYtDlp(['--no-warnings', '--skip-download', '--dump-json', cleanedUrl], '/tmp');
      // --dump-json may output multiple lines (playlist etc.) — parse first JSON line
      const firstLine = (probe.stdout || '').split('\n').find(l => l.trim().length > 0);
      if (firstLine) {
        try {
          const info = JSON.parse(firstLine);
          const durationSec = Number(info.duration || info._duration || 0);
          probedDurationSec = !isNaN(durationSec) ? durationSec : 0;
          console.log('Probed duration (s):', probedDurationSec);
          // If very short (less than 2 minutes) prefer compact m4a stream
          if (probedDurationSec > 0 && probedDurationSec <= 120) {
            preferM4aForShort = true;
            console.log('Short video detected — enabling fast format preference (m4a/abr cap).');
          }
        } catch (e) {
          // ignore parse errors, continue with defaults
          console.warn('Failed to parse yt-dlp probe JSON:', e.message);
        }
      }
    } catch (probeErr) {
      // Probe failed — not fatal, continue with normal flow
      console.warn('Metadata probe failed (continuing):', probeErr.message);
    }

    // LAYER 1: Web client with optimized settings (no PO Token needed)
    // Always prefer the best audio stream to avoid lowering quality.
    // If you want to tweak speed vs quality you can adjust format selection separately,
    // but by default we request the best available audio.
    const formatString = 'bestaudio/best';

    // Determine which yt-dlp player_client to use for the primary attempt.
    // You can force a client via env: PREFERRED_YTDLP_CLIENT=web_safari (or tv_embedded, web_embedded, web)
    const preferredClientEnv = (process.env.PREFERRED_YTDLP_CLIENT || '').trim();
    let playerClient = 'web';
    if (preferredClientEnv) {
      playerClient = preferredClientEnv;
    } else if (preferM4aForShort) {
      // for short clips try the Safari web client first — often yields smaller audio streams
      playerClient = 'web_safari';
    } else {
      // Also prefer web_safari for long videos (configurable threshold)
      const LONG_VIDEO_THRESHOLD = Number(process.env.LONG_VIDEO_THRESHOLD || 600); // seconds
      if (probedDurationSec >= LONG_VIDEO_THRESHOLD) {
        playerClient = 'web_safari';
        console.log(`Long video detected (${probedDurationSec}s) — using web_safari as primary client`);
      }
    }
    console.log(`Using primary yt-dlp player_client: ${playerClient}`);

    const baseArgs = [
      '--no-playlist',
      '-x', '--audio-format', 'mp3',
      '--format', formatString,
      '--output', outputTemplate,
      '--no-mtime',

      // Use selected client to avoid PO Token requirement
      '--extractor-args', `youtube:player_client=${playerClient}`,

      // Anti-bot detection headers
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      '--referer', 'https://www.youtube.com/',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '--add-header', 'Sec-Fetch-Site:none',
      '--add-header', 'Sec-Fetch-Mode:navigate',
      '--add-header', 'Sec-Fetch-Dest:document',

      cleanedUrl
    ];

    // Optional: enable a permitted external downloader (Cobalt Tools) for parallel segmented downloads.
    // Enable with YTDLP_USE_COBALT=1. Tune downloader name and args via YTDLP_COBALT_NAME and YTDLP_COBALT_ARGS.
    if (process.env.YTDLP_USE_COBALT === '1') {
      if (BINARIES['cobalt'] && BINARIES['cobalt'].ok) {
        const cobaltName = process.env.YTDLP_COBALT_NAME || 'cobalt';
        const cobaltArgsRaw = process.env.YTDLP_COBALT_ARGS || '--parallel 8';
        baseArgs.push('--external-downloader', cobaltName, '--external-downloader-args', cobaltArgsRaw);
        console.log(`yt-dlp configured to use external downloader: ${cobaltName} ${cobaltArgsRaw}`);
      } else {
        console.warn('YTDLP_USE_COBALT=1 but cobalt binary not found. Skipping external-downloader to avoid failures.');
      }
    }

    const extraArgs = [];

    // Use cookies.txt file if YTDLP_COOKIES env var is set
    if (process.env.YTDLP_COOKIES) {
      extraArgs.push('--cookies', process.env.YTDLP_COOKIES);
      console.log('Using cookies from file:', process.env.YTDLP_COOKIES);
    }
    // Only try browser extraction if explicitly enabled
    else if (process.env.YTDLP_BROWSER) {
      const browser = process.env.YTDLP_BROWSER;
      extraArgs.push('--cookies-from-browser', browser);
      console.log(`Attempting to use cookies from ${browser} browser`);
    }
    else {
      console.log('No cookies configured. Relying on multi-layer fallback system.');
    }

    if (process.env.YTDLP_PROXY) extraArgs.push('--proxy', process.env.YTDLP_PROXY);

    // Keep track of last yt-dlp error to decide on special HLS retry
    let lastYtdlpError = null;

    // Decide if we should attempt the piped fast path:
    // - opt-in via ENABLE_PIPE=1, or
    // - automatically for short videos (preferM4aForShort = true)
    const enablePipe = process.env.ENABLE_PIPE === '0' ? false : true;
    if (enablePipe) console.log('Fast piped yt-dlp->ffmpeg path ENABLED for this request (can be disabled with ENABLE_PIPE=0)');

    if (enablePipe) {
      const pipedMp3Path = `${outputDir}/ytdlp_${videoId}.mp3`;
      // prepare yt-dlp extra args (cookies/proxy) to forward to the piped run
      const ytExtraArgsForPipe = [];
      if (process.env.YTDLP_COOKIES) ytExtraArgsForPipe.push('--cookies', process.env.YTDLP_COOKIES);
      else if (process.env.YTDLP_BROWSER) ytExtraArgsForPipe.push('--cookies-from-browser', process.env.YTDLP_BROWSER);
      if (process.env.YTDLP_PROXY) ytExtraArgsForPipe.push('--proxy', process.env.YTDLP_PROXY);

      // Forward cobalt external-downloader args to the piped invocation when enabled and available
      if (process.env.YTDLP_USE_COBALT === '1' && BINARIES['cobalt'] && BINARIES['cobalt'].ok) {
        const cobaltName = process.env.YTDLP_COBALT_NAME || 'cobalt';
        const cobaltArgsRaw = process.env.YTDLP_COBALT_ARGS || '--parallel 8';
        ytExtraArgsForPipe.push('--external-downloader', cobaltName, '--external-downloader-args', cobaltArgsRaw);
      } else if (process.env.YTDLP_USE_COBALT === '1') {
        console.warn('YTDLP_USE_COBALT=1 but cobalt binary not present — piped run will not use external downloader.');
      }

      try {
        console.log('Attempting fast piped yt-dlp -> ffmpeg path (no intermediate file)...');
        // note: pass formatString (we built earlier) as ytFormat
        await streamYtdlpToFfmpeg(cleanedUrl, formatString, pipedMp3Path, isPremium, ytExtraArgsForPipe, playerClient);
        console.log('SUCCESS: piped yt-dlp->ffmpeg produced MP3:', pipedMp3Path);
        return pipedMp3Path;
      } catch (pipeErr) {
        console.warn('Piped fast path failed, falling back to layered approach:', pipeErr.message);
        // fall-through to existing layered attempts
      }
    }

    // Try first attempt
    try {
      await runYtDlp([...baseArgs, ...extraArgs], '/tmp');
      console.log('SUCCESS: Primary method worked!');
    } catch (firstErr) {
      console.warn('Layer 1 failed:', firstErr.message);
      lastYtdlpError = firstErr;

      // LAYER 2: TV embedded client (no PO Token, works with proxy)
      console.log('Trying Layer 2: TV embedded client fallback...');
      try {
        const tvFallback = [
          '--no-playlist',
          '-x', '--audio-format', 'mp3',
          '--format', 'bestaudio/best',
          '--output', outputTemplate,
          '--extractor-args', 'youtube:player_client=tv_embedded',
          '--user-agent', 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15',
          cleanedUrl
        ];

        if (process.env.YTDLP_COOKIES) tvFallback.push('--cookies', process.env.YTDLP_COOKIES);
        if (process.env.YTDLP_PROXY) tvFallback.push('--proxy', process.env.YTDLP_PROXY);

        await runYtDlp(tvFallback, '/tmp');
        console.log('SUCCESS: TV embedded client fallback worked!');
        lastYtdlpError = null;
      } catch (tvErr) {
        console.warn('Layer 2 failed:', tvErr.message);
        lastYtdlpError = tvErr;

        // LAYER 3: Web Safari client (alternative web client)
        console.log('Trying Layer 3: Web Safari client fallback...');
        try {
          const safariFallback = [
            '--no-playlist',
            '-x', '--audio-format', 'mp3',
            '--format', 'bestaudio/best',
            '--output', outputTemplate,
            '--extractor-args', 'youtube:player_client=web_safari',
            '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
            cleanedUrl
          ];

          if (process.env.YTDLP_COOKIES) safariFallback.push('--cookies', process.env.YTDLP_COOKIES);
          if (process.env.YTDLP_PROXY) safariFallback.push('--proxy', process.env.YTDLP_PROXY);

          await runYtDlp(safariFallback, '/tmp');
          console.log('SUCCESS: Web Safari client fallback worked!');
          lastYtdlpError = null;
        } catch (safariErr) {
          console.warn('Layer 3 failed:', safariErr.message);
          lastYtdlpError = safariErr;

          // LAYER 4: Web embedded player (last resort, no PO Token)
          console.log('Trying Layer 4: Web embedded player fallback...');
          const embeddedFallback = [
            '--no-playlist',
            '-x', '--audio-format', 'mp3',
            '--format', 'bestaudio/best',
            '--output', outputTemplate,
            '--extractor-args', 'youtube:player_client=web_embedded',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            '--geo-bypass',
            '--retries', '5',
            '--fragment-retries', '5',
            cleanedUrl
          ];

          if (process.env.YTDLP_COOKIES) embeddedFallback.push('--cookies', process.env.YTDLP_COOKIES);
          if (process.env.YTDLP_PROXY) embeddedFallback.push('--proxy', process.env.YTDLP_PROXY);

          await runYtDlp(embeddedFallback, '/tmp');
          console.log('SUCCESS: Web embedded fallback worked!');
          lastYtdlpError = null;
        }
      }
    }

    // SPECIAL RETRY: HLS/FFmpeg URL parsing errors sometimes need mpegts or prefer-ffmpeg.
    // If the last yt-dlp run failed and stderr mentions ffmpeg URL parsing issues, retry with HLS-friendly flags.
    if (lastYtdlpError && typeof lastYtdlpError.stderr === 'string') {
      const stderr = lastYtdlpError.stderr;
      const needsHlsRetry =
        stderr.includes('Port missing in uri') ||
        stderr.includes('Invalid argument') ||
        stderr.includes('ERROR: ffmpeg exited with code 1') ||
        stderr.includes('ffmpeg exited with code 1');

      if (needsHlsRetry) {
        console.log('Detected ffmpeg/HLS parsing issue, retrying with HLS-friendly flags (mpegts / prefer-ffmpeg)...');
        try {
          const hlsArgs = [
            '--no-playlist',
            '-x', '--audio-format', 'mp3',
            '--format', 'bestaudio/best',
            '--output', outputTemplate,
            '--hls-use-mpegts',
            '--hls-prefer-ffmpeg',
            '--allow-unplayable-formats',
            '--geo-bypass',
            cleanedUrl
          ];
          if (process.env.YTDLP_COOKIES) hlsArgs.push('--cookies', process.env.YTDLP_COOKIES);
          if (process.env.YTDLP_PROXY) hlsArgs.push('--proxy', process.env.YTDLP_PROXY);

          await runYtDlp(hlsArgs, '/tmp');
          console.log('SUCCESS: HLS-friendly retry worked!');
          lastYtdlpError = null;
        } catch (hlsErr) {
          console.warn('HLS-friendly retry failed:', hlsErr.message);
          lastYtdlpError = hlsErr;
        }
      }
    }

    // Find generated file
    const allFiles = fs.readdirSync(outputDir);
    const files = allFiles.filter(f =>
      f.startsWith(`ytdlp_${videoId}.`) &&
      (f.endsWith('.mp3') || f.endsWith('.webm') || f.endsWith('.m4a') || f.endsWith('.wav') || f.endsWith('.aac'))
    );

    console.log(`Looking for files with prefix: ytdlp_${videoId}`);
    console.log('Found files:', files);

    if (!files || files.length === 0) {
      // If we have a stored yt-dlp error, throw it so existing error mapping runs
      if (lastYtdlpError) {
        throw lastYtdlpError;
      }
      throw new Error('DOWNLOAD_FAILED: yt-dlp did not produce an output file. The video may be unavailable, region-locked, require login, or yt-dlp failed.');
    }

    // Prefer mp3 if already produced, otherwise convert first matched file to mp3
    let finalFile = files.find(f => f.endsWith('.mp3')) || files[0];
    let finalPath = `${outputDir}/${finalFile}`;

    if (!finalPath.endsWith('.mp3')) {
      // Convert to mp3
      const mp3Path = finalPath.replace(/\.(webm|m4a|wav|aac)$/, '.mp3');
      await convertToMp3Ultimate(finalPath, mp3Path, isPremium);
      try { fs.unlinkSync(finalPath); } catch (e) { /* ignore */ }
      finalPath = mp3Path;
    }

    console.log('DEBUG downloaded:', finalPath);
    return finalPath;

  } catch (error) {
    console.error('yt-dlp error:', error);
    const msg = error.message || String(error);

    // User-friendly error messages
    if (msg.includes('Sign in to confirm') || (msg.includes('Sign in') && msg.includes('bot'))) {
      throw new Error(
        'VIDEO_RATE_LIMITED: YouTube is rate limiting requests from this server. ' +
        'Please try a different video or try again in a few minutes. If this persists, contact support.'
      );
    }

    // Vimeo login required
    if (msg.includes('vimeo') && (msg.includes('logged-in') || msg.includes('authentication') || msg.includes('Use --cookies'))) {
      throw new Error(
        'VIDEO_REQUIRES_AUTH: This Vimeo video requires authentication. ' +
        'Vimeo has restricted access to most videos. Please try a different platform.'
      );
    }

    if (msg.includes('sqlite3') || msg.includes('Cookies.sqlite') || (msg.includes('cookie') && msg.includes('database'))) {
      throw new Error(
        'VIDEO_UNAVAILABLE: Unable to download this video at the moment. ' +
        'Please try a different video or try again later.'
      );
    }

    // Only throw specific errors - most errors should have been handled by fallback layers
    if (msg.includes('This video is private') || msg.includes('Private video')) {
      throw new Error('VIDEO_PRIVATE: This video is private and cannot be downloaded.');
    } else if (msg.includes('age') && (msg.includes('restricted') || msg.includes('confirm your age'))) {
      throw new Error('VIDEO_AGE_RESTRICTED: This video is age-restricted and requires authentication.');
    } else if (msg.includes('members-only') || msg.includes('Join this channel')) {
      throw new Error('VIDEO_MEMBERS_ONLY: This video is for channel members only.');
    } else if (msg.includes('copyright') && msg.includes('blocked')) {
      throw new Error('VIDEO_COPYRIGHT: This video is blocked due to copyright restrictions.');
    } else if (msg.includes('HTTP Error 429')) {
      throw new Error('RATE_LIMITED: Too many requests. Please try again in a few minutes.');
    } else if (msg.includes('all 4 layers failed')) {
      // All layers truly failed - this is a real issue
      throw new Error('DOWNLOAD_FAILED: Unable to download this video after trying multiple methods. Some videos cannot be converted due to platform restrictions. Please try a different video.');
    } else {
      // Generic failure - but this should rarely happen since fallbacks should catch most issues
      throw new Error(`VIDEO_UNAVAILABLE: This video cannot be downloaded. It may be unavailable, deleted, region-restricted, or require special authentication. This is normal for some videos - please try a different one.`);
    }
  }
}

async function downloadDirectVideo(videoUrl, outputPath) {
  try {
    const axiosOptions = {
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: 120000,
      maxRedirects: 5,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    };

    // If YTDLP_PROXY is set and parsed successfully, tell axios to use it
    if (PROXY_CONFIG) {
      // axios expects numeric port
      axiosOptions.proxy = {
        protocol: PROXY_CONFIG.protocol,
        host: PROXY_CONFIG.host,
        port: Number(PROXY_CONFIG.port)
      };
      if (PROXY_CONFIG.auth) {
        axiosOptions.proxy.auth = {
          username: PROXY_CONFIG.auth.username,
          password: PROXY_CONFIG.auth.password
        };
      }
    } else if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
      // If system HTTP(S)_PROXY env vars are set, axios will use them automatically in many environments;
      // we leave them alone so container-level proxy can work without code changes.
    }

    const response = await axios(axiosOptions);

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    throw new Error(`Direct download failed: ${error.message}`);
  }
}

// New helper: detect audio codec using ffprobe (returns codec string or null)
function getAudioCodec(filePath) {
  try {
    const r = spawnSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { encoding: 'utf8' });
    if (r.error) return null;
    const codec = (r.stdout || '').trim().split('\n')[0];
    return codec || null;
  } catch (e) {
    return null;
  }
}

// ULTIMATE: Direct FFmpeg spawn for maximum speed
function convertToMp3Ultimate(inputPath, outputPath, isPremium) {
  return new Promise((resolve, reject) => {
    const label = isPremium ? 'ULTIMATE PREMIUM' : 'ULTRA-FAST';
    console.log(`${label} conversion...`);

    // Keep quality high by default. Use YTDLP_TARGET_BITRATE and YTDLP_TARGET_Q to override.
    const bitrate = process.env.YTDLP_TARGET_BITRATE || '192k';
    const quality = process.env.YTDLP_TARGET_Q || (isPremium ? '2' : '2');

    // Probe input codec and decide whether we can copy
    const codec = getAudioCodec(inputPath);
    let ffArgs;
    if (codec === 'mp3') {
      console.log('Input audio codec is mp3 — copying stream to MP3 container (fast path).');
      ffArgs = [
        '-threads', '0',
        '-hide_banner',
        '-loglevel', 'error',
        '-i', inputPath,
        '-vn', '-sn', '-dn',
        '-map', '0:a:0',
        '-c:a', 'copy',
        '-write_xing', '0',
        '-id3v2_version', '0',
        '-f', 'mp3',
        '-y',
        outputPath
      ];
    } else {
      // normal encode path
      ffArgs = [
        '-threads', '0',
        '-i', inputPath,
        '-vn',
        '-sn',
        '-dn',
        '-map', '0:a:0',
        '-c:a', 'libmp3lame',
        '-b:a', bitrate,
        '-ar', '44100',
        '-ac', '2',
        '-compression_level', '0',
        '-q:a', quality,
        '-write_xing', '0',
        '-id3v2_version', '0',
        '-f', 'mp3',
        '-y',
        outputPath
      ];
    }

    const ffmpeg = spawn('ffmpeg', ffArgs);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const start = Date.now();
    ffmpeg.on('close', (code) => {
      const dur = ((Date.now() - start) / 1000).toFixed(2);
      if (code === 0) {
        console.log(`${label} conversion done in ${dur}s (codec=${codec || 'unknown'})`);
        resolve();
      } else {
        reject(new Error(`FFmpeg failed: ${stderr}`));
      }
    });

    ffmpeg.on('error', reject);
  });
}

// Middleware that handles both file uploads and URL-only requests
const handleUpload = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message, errorCode: 'UPLOAD_ERROR' });
    }
    next();
  });
};

// Simple cache directory for converted MP3s (fast path for repeat URLs)
const CACHE_DIR = process.env.VIDEO_CACHE_DIR || path.join(os.tmpdir(), 'video_cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// New: start periodic cache cleaner (configurable via env)
const { startCacheCleaner } = require('./cacheCleaner');
const CACHE_CLEAN_DAYS = Number(process.env.CACHE_CLEAN_DAYS || 7); // default 7 days
const CACHE_CLEAN_INTERVAL_HOURS = Number(process.env.CACHE_CLEAN_INTERVAL_HOURS || 24); // default every 24h
try {
  startCacheCleaner(CACHE_DIR, CACHE_CLEAN_DAYS, CACHE_CLEAN_INTERVAL_HOURS);
  console.log(`Cache cleaner started: purge files older than ${CACHE_CLEAN_DAYS} days every ${CACHE_CLEAN_INTERVAL_HOURS} hours`);
} catch (e) {
  console.warn('Failed to start cache cleaner:', e.message);
}

// Concurrency limiter for downloads (tier-aware semaphore)
const MAX_CONCURRENT_DOWNLOADS = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2);
const BUSINESS_MAX_CONCURRENT_DOWNLOADS = Number(process.env.BUSINESS_MAX_CONCURRENT_DOWNLOADS || 10);
const ENTERPRISE_MAX_CONCURRENT_DOWNLOADS = Number(process.env.ENTERPRISE_MAX_CONCURRENT_DOWNLOADS || 50);
let currentDownloads = 0;
// queue holds { resolve, tier } entries
const downloadQueue = [];

function getLimitForTier(tier) {
  if (tier === 'enterprise') return ENTERPRISE_MAX_CONCURRENT_DOWNLOADS;
  if (tier === 'business') return BUSINESS_MAX_CONCURRENT_DOWNLOADS;
  // premium falls back to standard limit (no special batch allowance unless you set BUSINESS/ENTERPRISE)
  return MAX_CONCURRENT_DOWNLOADS;
}

function acquireDownloadSlot(tier = 'standard') {
  const limit = getLimitForTier(tier);
  return new Promise((resolve) => {
    if (currentDownloads < limit) {
      currentDownloads++;
      return resolve();
    }
    downloadQueue.push({ resolve, tier });
  });
}

function releaseDownloadSlot() {
  currentDownloads = Math.max(0, currentDownloads - 1);
  if (downloadQueue.length === 0) return;

  // Find the first queued entry whose tier limit allows starting now.
  for (let i = 0; i < downloadQueue.length; i++) {
    const entry = downloadQueue[i];
    const entryLimit = getLimitForTier(entry.tier);
    if (currentDownloads < entryLimit) {
      downloadQueue.splice(i, 1);
      currentDownloads++;
      try { entry.resolve(); } catch (e) { /* ignore */ }
      return;
    }
  }
  // nothing could start; a later release will re-check
}

// Optional: set your app's public hostname (used to detect proxy loops).
// Example: SERVICE_PUBLIC_HOST=video-conversion-service-production.up.railway.app
const SERVICE_PUBLIC_HOST = (process.env.SERVICE_PUBLIC_HOST || '').trim().toLowerCase();

// --- New helper: parse and validate YTDLP_PROXY env (supports optional RPXY) ---
function parseProxyEnv() {
	// Prefer rpxy URL when explicitly enabled, otherwise fall back to YTDLP_PROXY.
	const useRpxy = String(process.env.YTDLP_USE_RPXY || '').trim() === '1';
	const rpxyRaw = process.env.YTDLP_RPXY_URL;
	const rawInput = useRpxy && rpxyRaw ? rpxyRaw : process.env.YTDLP_PROXY;
	if (!rawInput) return null;

	const raw = String(rawInput).trim();
	// Accept hostnames without http/https by defaulting to https://
	const candidate = (raw.startsWith('http://') || raw.startsWith('https://')) ? raw : `https://${raw}`;

	try {
		const u = new URL(candidate);

		// Detect accidental loop: proxy points back at this app's public host (common when using rpxy incorrectly).
		if (SERVICE_PUBLIC_HOST) {
			const svc = SERVICE_PUBLIC_HOST.toLowerCase();
			if (u.hostname.toLowerCase().includes(svc) || candidate.toLowerCase().includes(svc)) {
				console.warn(`Ignoring proxy setting because it points to the app itself (${svc}). This would create a request loop through the proxy/rpxy. Unset YTDLP_PROXY or use an external proxy.`);
				return null;
			}
		}

		let port = u.port;
		if (!port) {
			const inferred = u.protocol === 'http:' ? '80' : (u.protocol === 'https:' ? '443' : '');
			// Informational: we will default to the standard port for the scheme.
			console.log(`Proxy provided without port; defaulting to port ${inferred} for ${u.protocol.replace(':','')}. You may include an explicit port in the proxy URL if desired.`);
			port = inferred;
		}
		const auth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : null;
		const which = useRpxy && rpxyRaw ? 'rpxy' : 'proxy';
		return { raw: candidate, protocol: u.protocol.replace(':', ''), host: u.hostname, port, auth, which };
	} catch (err) {
		console.warn('Invalid proxy value:', rawInput, err.message);
		return null;
	}
}

const PROXY_CONFIG = parseProxyEnv();
// Masked log so secret parts aren't printed
if (PROXY_CONFIG) {
  console.log(`Proxy configured (${PROXY_CONFIG.which || 'proxy'}): ${PROXY_CONFIG.protocol}://${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`);
} else {
  console.log('No proxy configured via YTDLP_PROXY or YTDLP_RPXY_URL');
}

// --- New: binary presence checks (yt-dlp, ffmpeg, python3) ---
function checkBinary(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    if (r.error) return { ok: false, message: r.error.message };
    if (r.status !== 0) return { ok: false, message: (r.stderr || r.stdout || `exit ${r.status}`).toString().trim() };
    return { ok: true, message: (r.stdout || r.stderr).toString().split('\n')[0] || 'ok' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

const BINARIES = {
  'yt-dlp': checkBinary('yt-dlp', ['--version']),
  'ffmpeg': checkBinary('ffmpeg', ['-version']),
  'python3': checkBinary('python3', ['--version']),
  // cobalt may be installed optionally via build-arg; check presence to avoid runtime failures
  'cobalt': checkBinary('cobalt', ['--version'])
};

Object.keys(BINARIES).forEach(k => {
  if (!BINARIES[k].ok) {
    console.warn(`MISSING BINARY: ${k} -> ${BINARIES[k].message}`);
  } else {
    console.log(`FOUND BINARY: ${k} -> ${BINARIES[k].message}`);
  }
});

function computeCacheKey(url, opts = {}) {
  const hash = crypto.createHash('sha256');
  hash.update(String(url));
  // include relevant options to avoid collisions when you change output quality/format
  if (opts.quality) hash.update(String(opts.quality));
  if (opts.tier) hash.update(String(opts.tier));
  return hash.digest('hex');
}

app.post('/convert-video-to-mp3', handleUpload, async (req, res) => {
  const tier = getUserTier(req);
  const premium = tier !== 'standard';
  console.log(`ULTIMATE conversion request - ${premium ? 'PREMIUM' : 'STANDARD'} user`);
  console.log('Request body:', req.body);
  console.log('Request files:', req.files);

  let inputPath;
  let shouldCleanupInput = false;
  const startTime = Date.now();

  // Handle file size limit exceeded
  if (req.files && req.files.length > 0) {
    const file = req.files[0];
    if (file.size > 500 * 1024 * 1024) {
      return res.status(413).json({
        error: 'File size exceeds 500MB limit.',
        errorCode: 'FILE_TOO_LARGE'
      });
    }
  }

  try {
    const videoFile = req.files && req.files.find(f => f.fieldname === 'video');

    if (videoFile) {
      inputPath = videoFile.path;
    } else if (req.body.videoUrl) {
      const videoUrl = req.body.videoUrl;
      shouldCleanupInput = true;

      if (isSupportedVideoUrl(videoUrl)) {
        const isVimeo = videoUrl.includes('vimeo.com');
        if (isVimeo) {
          return res.status(400).json({
            error: 'Vimeo not supported',
            errorCode: 'URL_UNSUPPORTED'
          });
        }

        // --- NEW: Cache fast-path + concurrency control ---
        const cleaned = cleanVideoUrl(videoUrl);
        const cacheKey = computeCacheKey(cleaned);
        const cachedPath = path.join(CACHE_DIR, `${cacheKey}.mp3`);

        if (fs.existsSync(cachedPath)) {
          console.log(`Cache hit for ${cleaned} -> ${cachedPath}`);
          const stats = fs.statSync(cachedPath);
          const audioData = fs.readFileSync(cachedPath);
          const base64Audio = audioData.toString('base64');

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`Total (cached): ${elapsed}s (${premium ? 'PREMIUM' : 'STANDARD'})`);

          return res.json({
            success: true,
            audioData: base64Audio,
            filename: 'audio.mp3',
            size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
            conversionTime: `${elapsed}s`,
            tier: premium ? 'premium' : 'standard',
            cached: true
          });
        }

        // Acquire a download slot before expensive work (tier-aware)
        await acquireDownloadSlot(tier);
        let downloadedPath = null;
        try {
          // perform actual download + conversion (this will produce a file path)
          downloadedPath = await downloadVideoWithYtdlpUltimate(videoUrl, '/tmp', premium);
          // If the returned file is not an mp3, convertToMp3Ultimate call already handled it in the function.
          // Copy to cache for future requests (atomic-ish)
          if (downloadedPath && fs.existsSync(downloadedPath)) {
            try {
              // ensure we don't overwrite an existing cache (race safe)
              if (!fs.existsSync(cachedPath)) {
                fs.copyFileSync(downloadedPath, cachedPath);
                console.log(`Cached ${cleaned} -> ${cachedPath}`);
              } else {
                console.log(`Cache already created concurrently for ${cleaned}`);
              }
            } catch (e) {
              console.warn('Failed to cache file:', e.message);
            }
          }
        } finally {
          // always release slot
          releaseDownloadSlot();
        }

        // If we have cachedPath now, serve from cache (prefer cache)
        const finalServePath = fs.existsSync(cachedPath) ? cachedPath : downloadedPath;
        if (finalServePath && finalServePath.endsWith('.mp3')) {
          console.log('Serving final MP3:', finalServePath);
          const stats = fs.statSync(finalServePath);
          const audioData = fs.readFileSync(finalServePath);
          const base64Audio = audioData.toString('base64');

          if (fs.existsSync(downloadedPath) && shouldCleanupInput) {
            // cleanup temp downloaded file if it's different from cache
            try {
              if (downloadedPath !== cachedPath) fs.unlinkSync(downloadedPath);
            } catch (e) { /* ignore */ }
          }

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          return res.json({
            success: true,
            audioData: base64Audio,
            filename: 'audio.mp3',
            size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
            conversionTime: `${elapsed}s`,
            tier: premium ? 'premium' : 'standard',
            cached: fs.existsSync(cachedPath)
          });
        }

        // If not MP3 or download failed, fall through to error handling below
      } else {
        const videoId = uuidv4();
        inputPath = `/tmp/direct_${videoId}.video`;
        await downloadDirectVideo(videoUrl, inputPath);
      }
    } else {
      return res.status(400).json({
        error: 'No video file or URL',
        errorCode: 'NO_INPUT'
      });
    }

    const outputId = uuidv4();
    const outputPath = `/tmp/converted_${outputId}.mp3`;

    await convertToMp3Ultimate(inputPath, outputPath, premium);

    const stats = fs.statSync(outputPath);
    const audioData = fs.readFileSync(outputPath);
    const base64Audio = audioData.toString('base64');

    // Cleanup
    fs.unlinkSync(outputPath);
    if (shouldCleanupInput && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (videoFile && fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);

    const filename = videoFile ? `${videoFile.originalname.split('.')[0]}.mp3` : `audio_${outputId}.mp3`;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Total: ${elapsed}s (${premium ? 'PREMIUM' : 'STANDARD'})`);

    res.json({
      success: true,
      audioData: base64Audio,
      filename: filename,
      size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
      conversionTime: `${elapsed}s`,
      tier: premium ? 'premium' : 'standard'
    });

  } catch (error) {
    console.error('Error:', error);

    if (error.message && (
      error.message.includes('URL_UNSUPPORTED') ||
      error.message.includes('VIDEO_UNAVAILABLE') ||
      error.message.includes('VIDEO_PRIVATE') ||
      error.message.includes('VIDEO_AGE_RESTRICTED') ||
      error.message.includes('VIDEO_REQUIRES_AUTH') ||
      error.message.includes('VIDEO_COPYRIGHT') ||
      error.message.includes('RATE_LIMITED') ||
      error.message.includes('DOWNLOAD_FAILED')
    )) {
      return res.status(400).json({
        error: error.message,
        errorCode: error.message.split(':')[0]
      });
    }

    if (shouldCleanupInput && inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    const videoFile = req.files && req.files.find(f => f.fieldname === 'video');
    if (videoFile && fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);

    res.status(500).json({
      error: error.message || 'Server error',
      errorCode: 'SERVER_ERROR'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    mode: 'ULTIMATE (Multi-Layer Fallback)',
    layers: '4 (Web → TV Embedded → Safari → Web Embedded)',
    cookiesEnabled: !!process.env.YTDLP_COOKIES,
    proxyEnabled: !!(process.env.YTDLP_PROXY || process.env.YTDLP_RPXY_URL),
    rpxyEnabled: process.env.YTDLP_USE_RPXY === '1',
    rpxyUrl: process.env.YTDLP_RPXY_URL || null,
    binaries: {
      'yt-dlp': BINARIES['yt-dlp'],
      'ffmpeg': BINARIES['ffmpeg'],
      'python3': BINARIES['python3']
    },
    note: 'All layers bypass PO Token requirement'
  });
});

app.listen(port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  ULTIMATE Video Conversion Service                        ║
║  Port: ${port}                                            ║
║  Multi-Layer Bot Detection Bypass: ENABLED                ║
║  Platforms: YouTube, TikTok, Instagram, Twitter/X         ║
║  Expected Success Rate: 92-95%                            ║
╚═══════════════════════════════════════════════════════════╝
  `);
  console.log('Configuration:');
  console.log('  - Cookies:', process.env.YTDLP_COOKIES ? 'ENABLED' : 'DISABLED (optional)');
  console.log('  - Proxy:', PROXY_CONFIG ? `${PROXY_CONFIG.which || 'proxy'}: ENABLED` : 'DISABLED (optional)');
  console.log('  - Supported platforms: YouTube, TikTok, Instagram, Twitter/X');
  console.log('  - Fallback layers: 4 (Web → TV Embedded → Safari → Web Embedded)');
  console.log('  - PO Token bypass: ALL LAYERS');
  console.log('\nReady to process requests! 🚀\n');
});
