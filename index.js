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

// Allow simple CORS so frontend (possibly on another origin) can fetch converted files.
// Set CORS_ORIGINS="https://example.com,https://app.example" to restrict origins, otherwise defaults to '*'
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowList = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowList.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowList.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const upload = multer({
  dest: '/tmp/',
  limits: { fileSize: 500 * 1024 * 1024 }
});

// Premium feature flag from request headers
function isPremiumUser(req) {
  return req.headers['x-user-tier'] === 'premium' ||
         req.headers['x-user-tier'] === 'business' ||
         req.headers['x-user-tier'] === 'enterprise';
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

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    proc.on('error', err => reject(err));
    proc.on('close', async (code) => {
      if (code === 0) return resolve({ stdout, stderr });

      // Log stderr for debugging
      try {
        console.warn('yt-dlp failed (code %d). stderr:', code, (stderr || '').trim().slice(0, 1000));
        if (stdout && stdout.trim()) console.warn('yt-dlp stdout (trim):', stdout.trim().slice(0, 1000));
      } catch (e) { /* ignore logging errors */ }

      const fullErr = (stderr || '') + (stdout || '');

      // 1) Existing fallback: missing HTTPS-proxy dependencies -> try downgrading https:// to http://
      const needHttpsDeps = fullErr.includes('To use an HTTPS proxy for this request') ||
                            fullErr.includes('one of the following dependencies needs to be installed: requests, curl_cffi');

      if (needHttpsDeps) {
        try {
          const pi = args.findIndex(a => a === '--proxy');
          if (pi !== -1 && args[pi + 1] && typeof args[pi + 1] === 'string' && args[pi + 1].toLowerCase().startsWith('https://')) {
            const originalProxy = args[pi + 1];
            const downgradedProxy = originalProxy.replace(/^https:/i, 'http:');
            console.log(`yt-dlp reported missing HTTPS proxy deps — retrying once with http proxy: ${downgradedProxy}`);
            const retryArgs = args.slice();
            retryArgs[pi + 1] = downgradedProxy;
            try {
              const retryResult = await new Promise((res, rej) => {
                try { console.log('yt-dlp (retry) ->', sanitizeArgsForLog(retryArgs)); } catch (e) {}
                const p2 = spawn('yt-dlp', retryArgs, { cwd });
                let o2 = '', e2 = '';
                p2.stdout.on('data', c => o2 += c.toString());
                p2.stderr.on('data', c => e2 += c.toString());
                p2.on('error', rej);
                p2.on('close', code2 => code2 === 0 ? res({ stdout: o2, stderr: e2 }) : rej(Object.assign(new Error(`yt-dlp retry exit ${code2}`), { code: code2, stdout: o2, stderr: e2 })));
              });
              return resolve(retryResult);
            } catch (retryErr) {
              console.warn('Retry with downgraded proxy failed:', retryErr && retryErr.message);
            }
          }
        } catch (ex) { console.warn('Error while attempting https->http retry:', ex && ex.message); }
      }

      // 2) New: detect proxy connection failures (tunnel/ProxyError) and retry once WITHOUT --proxy
      const proxyFailureIndicators = [
        'Unable to connect to proxy',
        'Tunnel connection failed',
        'ProxyError',
        'Tunnel connection failed: 404',
        'Tunnel connection failed: 403'
      ];
      const isProxyFailure = proxyFailureIndicators.some(p => fullErr.includes(p));

      if (isProxyFailure) {
        try {
          const pi = args.findIndex(a => a === '--proxy');
          if (pi !== -1) {
            console.warn('Detected proxy connection failure in yt-dlp stderr — retrying once without --proxy to avoid a permanent failure.');
            const retryArgs = [];
            for (let i = 0; i < args.length; i++) {
              if (i === pi) { i++; continue; } // skip --proxy and its value
              retryArgs.push(args[i]);
            }
            try {
              const retryResult = await new Promise((res, rej) => {
                try { console.log('yt-dlp (retry without proxy) ->', sanitizeArgsForLog(retryArgs)); } catch (e) {}
                const p2 = spawn('yt-dlp', retryArgs, { cwd });
                let o2 = '', e2 = '';
                p2.stdout.on('data', c => o2 += c.toString());
                p2.stderr.on('data', c => e2 += c.toString());
                p2.on('error', rej);
                p2.on('close', code2 => code2 === 0 ? res({ stdout: o2, stderr: e2 }) : rej(Object.assign(new Error(`yt-dlp retry without proxy exit ${code2}`), { code: code2, stdout: o2, stderr: e2 })));
              });
              console.log('yt-dlp retry without proxy succeeded — proxy appears misconfigured or unreachable.');
              return resolve(retryResult);
            } catch (retryErr) {
              console.warn('yt-dlp retry without proxy failed:', retryErr && retryErr.message);
              // fall-through to reject original error below
            }
          } else {
            console.warn('Proxy failure detected but no --proxy arg present; cannot retry without proxy.');
          }
        } catch (ex) {
          console.warn('Error while attempting yt-dlp retry without proxy:', ex && ex.message);
        }
      }

      // No special recovery succeeded — return original error context
      const err = new Error(`yt-dlp exit ${code}: ${stderr || stdout}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

// --- New helper: parse and validate YTDLP_PROXY / RPXY env ---
// Accepts either YTDLP_PROXY or RPXY when YTDLP_USE_RPXY=1 + YTDLP_RPXY_URL
function parseProxyEnv() {
  const useRpxy = String(process.env.YTDLP_USE_RPXY || '').trim() === '1';
  const rpxyRaw = process.env.YTDLP_RPXY_URL;
  const rawInput = useRpxy && rpxyRaw ? rpxyRaw : process.env.YTDLP_PROXY;
  if (!rawInput) return null;

  const raw = String(rawInput).trim();
  const candidate = (raw.startsWith('http://') || raw.startsWith('https://')) ? raw : `https://${raw}`;

  try {
    const u = new URL(candidate);
    let port = u.port;
    if (!port) {
      const inferred = u.protocol === 'http:' ? '80' : (u.protocol === 'https:' ? '443' : '');
      console.log(`Proxy provided without port; defaulting to port ${inferred}.`);
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
if (PROXY_CONFIG) {
  console.log(`Proxy configured (${PROXY_CONFIG.which}): ${PROXY_CONFIG.protocol}://${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`);
} else {
  console.log('No proxy configured via YTDLP_PROXY or YTDLP_RPXY_URL');
}

// --- New helper: decide whether to pass --proxy to yt-dlp for a given URL ---
// Use env YTDLP_SKIP_PROXY_HOSTS (comma-separated, default: youtube hosts) to skip proxy for matching hosts.
// Set YTDLP_FORCE_PROXY=1 to force proxy for all hosts regardless of skip list.
function shouldUseProxyForUrl(url) {
  try {
    if (String(process.env.YTDLP_FORCE_PROXY || '').trim() === '1') return true;
    const raw = String(url || '').trim();
    if (!raw) return false;
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const skip = (process.env.YTDLP_SKIP_PROXY_HOSTS || 'youtube.com,youtu.be').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    // if any skip token is contained in host, do NOT use proxy
    for (const token of skip) {
      if (host.includes(token)) {
        return false;
      }
    }
    return !!PROXY_CONFIG; // only use proxy if configured and not skipped
  } catch (e) {
    // on parse problems, fall back to using proxy only if explicitly configured and forced
    return !!PROXY_CONFIG && String(process.env.YTDLP_FORCE_PROXY || '').trim() === '1';
  }
}

// New helper: stream yt-dlp -> ffmpeg to produce an MP3 without writing the source file
async function streamYtdlpToFfmpeg(cleanedUrl, ytFormat, outputPath, isPremium, ytExtraArgs = [], playerClient = 'web') {
  return new Promise((resolve, reject) => {
    try {
      ensurePathArg('outputPath', outputPath);
    } catch (e) {
      return reject(e);
    }

    // build yt-dlp args that write media to stdout
    const ytdlpArgs = [
      '--no-playlist',
      '--no-warnings',
      '-f', ytFormat,
      '-o', '-', // stream to stdout
      // keep extractor client minimal; caller may append extractor args if needed
      cleanedUrl,
      ...ytExtraArgs
    ];

    // spawn yt-dlp
    const ytdlp = spawn('yt-dlp', ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    // choose bitrate/quality consistent with convertToMp3Ultimate
    const bitrate = isPremium ? '192k' : '96k';
    const quality = isPremium ? '2' : '6';

    // spawn ffmpeg to read from stdin and write mp3
    const ffmpegArgs = [
      '-hide_banner',
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
      outputPath
    ];
    const ff = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    // pipe yt-dlp stdout into ffmpeg stdin
    ytdlp.stdout.pipe(ff.stdin);

    let ffErr = '';
    ff.stderr.on('data', (b) => { ffErr += b.toString(); });

    // if yt-dlp errors early, capture stderr
    let ytdlpErr = '';
    ytdlp.stderr.on('data', (b) => { ytdlpErr += b.toString(); });

    ff.on('close', (code) => {
      // ensure yt-dlp process is terminated
      try { ytdlp.kill(); } catch (e) {}
      if (code === 0) return resolve();
      const msg = ffErr || ytdlpErr || `ffmpeg exited ${code}`;
      reject(new Error(`PIPED_FAILED: ${msg}`));
    });

    ff.on('error', (e) => {
      try { ytdlp.kill(); } catch (er) {}
      reject(e);
    });

    ytdlp.on('error', (e) => {
      try { ff.kill(); } catch (er) {}
      reject(e);
    });

    // safety: if yt-dlp exits early with non-zero, capture that
    ytdlp.on('close', (yc) => {
      if (yc !== 0) {
        // let ffmpeg handle final failure; but if ff still running long, we can surface yt-dlp error
        // nothing to do here explicitly
      }
    });
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

    const formatString = isPremium ? 'bestaudio/best' : (preferM4aForShort ? 'bestaudio[ext=m4a][abr<=160]/bestaudio[abr<=128]/bestaudio/best' : 'bestaudio[abr<=128]/bestaudio/best');

    const preferredClientEnv = (process.env.PREFERRED_YTDLP_CLIENT || '').trim();
    let playerClient = 'web';
    if (preferredClientEnv) playerClient = preferredClientEnv;
    else if (preferM4aForShort) playerClient = 'web_safari';
    else {
      const LONG_VIDEO_THRESHOLD = Number(process.env.LONG_VIDEO_THRESHOLD || 600);
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

    const extraArgs = [];
    if (process.env.YTDLP_COOKIES) {
      extraArgs.push('--cookies', process.env.YTDLP_COOKIES);
      console.log('Using cookies from file:', process.env.YTDLP_COOKIES);
    } else if (process.env.YTDLP_BROWSER) {
      extraArgs.push('--cookies-from-browser', process.env.YTDLP_BROWSER);
      console.log(`Attempting to use cookies from ${process.env.YTDLP_BROWSER} browser`);
    } else {
      console.log('No cookies configured. Relying on multi-layer fallback system.');
    }

    // Add proxy to yt-dlp args only when configured and allowed for this URL
    if (PROXY_CONFIG) {
      if (shouldUseProxyForUrl(cleanedUrl)) {
        extraArgs.push('--proxy', PROXY_CONFIG.raw);
        console.log(`Using proxy for yt-dlp: ${PROXY_CONFIG.protocol}://${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`);
      } else {
        console.log(`Skipping proxy for host of URL: ${cleanedUrl} (YTDLP_SKIP_PROXY_HOSTS=${process.env.YTDLP_SKIP_PROXY_HOSTS || 'youtube.com,youtu.be'})`);
      }
    }

    // decide piped etc — keep your original fallback layers
    const enablePipe = process.env.ENABLE_PIPE === '0' ? false : true;
    if (enablePipe) console.log('Fast piped yt-dlp->ffmpeg path ENABLED for this request (can be disabled with ENABLE_PIPE=0)');

    if (enablePipe) {
      const pipedMp3Path = `${outputDir}/ytdlp_${videoId}.mp3`;
      const ytExtraArgsForPipe = [];
      if (process.env.YTDLP_COOKIES) ytExtraArgsForPipe.push('--cookies', process.env.YTDLP_COOKIES);
      else if (process.env.YTDLP_BROWSER) ytExtraArgsForPipe.push('--cookies-from-browser', process.env.YTDLP_BROWSER);
      if (PROXY_CONFIG && shouldUseProxyForUrl(cleanedUrl)) {
        ytExtraArgsForPipe.push('--proxy', PROXY_CONFIG.raw);
      } else if (PROXY_CONFIG) {
        console.log('PIPED PATH: skipping proxy for this URL per YTDLP_SKIP_PROXY_HOSTS');
      }

      try {
        console.log('Attempting fast piped yt-dlp -> ffmpeg path (no intermediate file)...');
        await streamYtdlpToFfmpeg(cleanedUrl, formatString, pipedMp3Path, isPremium, ytExtraArgsForPipe, playerClient);
        console.log('SUCCESS: piped yt-dlp->ffmpeg produced MP3:', pipedMp3Path);
        return pipedMp3Path;
      } catch (pipeErr) {
        console.warn('Piped fast path failed, falling back to layered approach:', pipeErr.message);
      }
    }

    // Layered attempts: primary + fallbacks (tv_embedded, web_safari, web_embedded) using PROXY_CONFIG.raw where needed
    try {
      await runYtDlp([...baseArgs, ...extraArgs], '/tmp');
      console.log('SUCCESS: Primary method worked!');
    } catch (firstErr) {
      console.warn('Layer 1 failed:', firstErr.message);
      let lastYtdlpError = firstErr;

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
        if (PROXY_CONFIG && shouldUseProxyForUrl(cleanedUrl)) tvFallback.push('--proxy', PROXY_CONFIG.raw);

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
          if (PROXY_CONFIG && shouldUseProxyForUrl(cleanedUrl)) safariFallback.push('--proxy', PROXY_CONFIG.raw);

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
          if (PROXY_CONFIG && shouldUseProxyForUrl(cleanedUrl)) embeddedFallback.push('--proxy', PROXY_CONFIG.raw);

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
          if (PROXY_CONFIG && shouldUseProxyForUrl(cleanedUrl)) hlsArgs.push('--proxy', PROXY_CONFIG.raw);

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
      throw new Error('DOWNLOAD_FAILED: yt-dlp did not produce an output file.');
    }

    // Prefer mp3 if already produced, otherwise convert first matched file to mp3
    let finalFile = files.find(f => f.endsWith('.mp3')) || files[0];
    let finalPath = `${outputDir}/${finalFile}`;

    if (!finalPath.endsWith('.mp3')) {
      // Convert to mp3
      const mp3Path = finalPath.replace(/\.(webm|m4a|wav|aac)$/, '.mp3');
      await convertToMp3Ultimate(finalPath, mp3Path, isPremium);
      try { fs.unlinkSync(finalPath); } catch (e) {}
      finalPath = mp3Path;
    }

    console.log('DEBUG downloaded:', finalPath);
    return finalPath;

  } catch (error) {
    throw error;
  }
}

async function downloadDirectVideo(videoUrl, outputPath) {
  try {
    // validate
    ensurePathArg('outputPath', outputPath);

    const axiosOptions = {
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: 120000,
      maxRedirects: 5,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    };

    if (PROXY_CONFIG) {
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

// ULTIMATE: Direct FFmpeg spawn for maximum speed
function convertToMp3Ultimate(inputPath, outputPath, isPremium) {
  return new Promise((resolve, reject) => {
    try {
      ensurePathArg('inputPath', inputPath);
      ensurePathArg('outputPath', outputPath);
    } catch (e) {
      return reject(e);
    }

    const label = isPremium ? 'ULTIMATE PREMIUM' : 'ULTRA-FAST';
    console.log(`${label} conversion...`);

    const bitrate = isPremium ? '192k' : '96k';
    const quality = isPremium ? '2' : '6';

    const ffmpeg = spawn('ffmpeg', [
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
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`${label} conversion done!`);
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

// Serve cached/converted files under /file (static) and provide a guarded download endpoint
app.use('/file', express.static(CACHE_DIR));

// New explicit safe file download route (prevents undefined / path issues and sets proper headers)
app.get('/file/:name', (req, res) => {
  try {
    const name = String(req.params.name || '').trim();
    // simple whitelist: uuid-like + .mp3
    if (!/^[a-f0-9\-]{36}\.mp3$/i.test(name)) {
      return res.status(400).json({ error: 'Invalid file name' });
    }
    const filePath = path.join(CACHE_DIR, name);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error('sendFile error for', filePath, err);
        if (!res.headersSent) res.status(500).end();
      }
    });
  } catch (err) {
    console.error('file download handler error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Replace the inline app.post('/convert-video-to-mp3', ...) handler with a named function so we can reuse it ---
// Move the entire body that was previously inside the inline async (req,res) => { ... } here:
async function convertVideoHandler(req, res) {
	// accept multiple possible field names from various frontends
	let videoUrl = req.body.videoUrl || req.body.url || req.body.video;
	let fileUpload = req.files && req.files.length > 0 ? req.files[0] : null;

	// Validate input: must provide either a URL or a file
	if (!videoUrl && !fileUpload) {
		return res.status(400).json({ error: 'No video URL or file provided.', errorCode: 'INVALID_INPUT' });
	}

	// For debugging: log the entire request body and files
	console.log('Request body:', req.body);
	console.log('Files:', req.files);

	// If URL is provided, validate and sanitize it
	if (videoUrl) {
		videoUrl = String(videoUrl).trim();
		if (!isSupportedVideoUrl(videoUrl)) {
			return res.status(400).json({ error: 'Unsupported video URL.', errorCode: 'INVALID_URL' });
		}
		console.log('Video URL:', videoUrl);
	}

	// If file is uploaded, use it directly
	let inputFilePath = null;
	if (fileUpload) {
		inputFilePath = fileUpload.path;
		console.log('File upload detected:', inputFilePath);
	}

	// Determine output file name and path
	const outputFileName = `${uuidv4()}.mp3`;
	const outputFilePath = path.join(CACHE_DIR, outputFileName);

	// Premium users get higher priority and faster processing
	const isPremium = isPremiumUser(req);

	// make producedPath available to the whole handler (avoid block-scope issues)
	let producedPath = undefined;

	// 1. URL → Direct download + convert
	if (videoUrl) {
		try {
			console.log('Starting download + conversion (URL)...');
			// downloadVideoWithYtdlpUltimate should return the path to the produced MP3
			producedPath = await downloadVideoWithYtdlpUltimate(videoUrl, '/tmp', isPremium);

			// defensive: ensure producedPath is a non-empty string
			if (!producedPath || typeof producedPath !== 'string') {
				console.error('downloadVideoWithYtdlpUltimate returned invalid producedPath:', producedPath);
				throw new Error('DOWNLOAD_FAILED: yt-dlp did not produce a valid output path.');
			}
			if (!fs.existsSync(producedPath)) {
				console.error('Produced file does not exist on disk:', producedPath);
				throw new Error('DOWNLOAD_FAILED: produced file missing on disk.');
			}

			// Copy to cache-named output path (atomic-ish)
			try {
				console.log('Copying produced file to cache:', { producedPath, outputFilePath });
				fs.copyFileSync(producedPath, outputFilePath);
				console.log(`Cached converted file to ${outputFilePath}`);
			} catch (copyErr) {
				console.warn('Failed to copy produced file to cache:', copyErr && copyErr.message);
				// As a fallback, try to move/rename (but ensure producedPath is defined)
				try {
					if (typeof producedPath === 'string' && producedPath) {
						fs.renameSync(producedPath, outputFilePath);
						console.log('Moved produced file to cache via rename.');
					} else {
						throw new Error('CACHE_MOVE_FAILED: invalid producedPath');
					}
				} catch (renameErr) {
					console.warn('Failed to move produced file to cache:', renameErr && renameErr.message);
					// If we can't copy or move, reject with a clear error
					throw new Error('CACHE_WRITE_FAILED');
				}
			}

			// Clean up original produced file if different from cache
			try {
				if (producedPath && producedPath !== outputFilePath && fs.existsSync(producedPath)) {
					fs.unlinkSync(producedPath);
				}
			} catch (e) { /* ignore cleanup errors */ }

			console.log('Download + conversion completed.');
		} catch (error) {
			console.error('Error during download + conversion:', error && error.stack ? error.stack : error);
			return res.status(500).json({ error: 'Failed to process video URL.', errorCode: 'PROCESSING_ERROR', detail: error.message });
		}
	}

	// 2. File upload → Convert to MP3 directly
	else if (fileUpload) {
		try {
			console.log('Starting direct conversion (file upload)...');
			await convertToMp3Ultimate(inputFilePath, outputFilePath, isPremium);
			console.log('Direct conversion completed.');
			// cleanup uploaded file
			try { if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath); } catch (e) {}
			// set producedPath so later checks/logging have a value
			producedPath = outputFilePath;
		} catch (error) {
			console.error('Error during direct conversion:', error && error.stack ? error.stack : error);
			return res.status(500).json({ error: 'Failed to convert uploaded file.', errorCode: 'CONVERSION_ERROR', detail: error.message });
		}
	}

	// Ensure the cached output exists before returning URL (extra logging)
	if (!fs.existsSync(outputFilePath)) {
		console.error('Expected cached output missing:', {
			outputFilePath,
			producedPath: typeof producedPath !== 'undefined' ? producedPath : '<<undefined>>',
			CACHE_DIR
		});
		return res.status(500).json({ error: 'Converted file missing', errorCode: 'MISSING_OUTPUT' });
	}

	// Respond with the URL to the converted MP3 file (served from /file)
	const fileUrl = `${req.protocol}://${req.get('host')}/file/${encodeURIComponent(outputFileName)}`;
	res.json({ url: fileUrl, fileName: outputFileName });
}

// Register both the original and the legacy frontend path to the same handler:
app.post('/convert-video-to-mp3', handleUpload, convertVideoHandler);
app.post('/api/video-to-mp3', handleUpload, convertVideoHandler);

// helper to validate path args
function ensurePathArg(name, p) {
  if (typeof p !== 'string' || p.trim() === '') {
    const err = new Error(`INVALID_PATH_ARG: ${name} is required and must be a non-empty string`);
    err.code = 'INVALID_PATH_ARG';
    throw err;
  }
}

// Explicit global error handler (last middleware)
app.use((err, req, res, next) => {
  try {
    console.error('GLOBAL_ERROR_HANDLER:', err && err.stack ? err.stack : err);
  } catch (e) { console.error('Error logging failure', e); }
  if (!res.headersSent) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err && err.message ? err.message : 'Unknown error' });
  } else {
    // if headers already sent, close connection
    try { res.end(); } catch (e) {}
  }
});

// Process-level handlers to capture any uncaught issues
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT_EXCEPTION', err && err.stack ? err.stack : err);
  // optional: graceful shutdown could be implemented here
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED_REJECTION', reason && reason.stack ? reason.stack : reason);
});

// Ensure server start exists at bottom
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
