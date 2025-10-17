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

// New helper: stream yt-dlp -> ffmpeg to produce an MP3 without writing the source file
async function streamYtdlpToFfmpeg(cleanedUrl, ytFormat, outputPath, isPremium, ytExtraArgs = [], playerClient = 'web') {
  return new Promise((resolve, reject) => {
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

    // use PROXY_CONFIG.raw when available
    if (PROXY_CONFIG) extraArgs.push('--proxy', PROXY_CONFIG.raw);

    // decide piped etc — keep your original fallback layers
    const enablePipe = process.env.ENABLE_PIPE === '0' ? false : true;
    if (enablePipe) console.log('Fast piped yt-dlp->ffmpeg path ENABLED for this request (can be disabled with ENABLE_PIPE=0)');

    if (enablePipe) {
      const pipedMp3Path = `${outputDir}/ytdlp_${videoId}.mp3`;
      const ytExtraArgsForPipe = [];
      if (process.env.YTDLP_COOKIES) ytExtraArgsForPipe.push('--cookies', process.env.YTDLP_COOKIES);
      else if (process.env.YTDLP_BROWSER) ytExtraArgsForPipe.push('--cookies-from-browser', process.env.YTDLP_BROWSER);
      if (PROXY_CONFIG) ytExtraArgsForPipe.push('--proxy', PROXY_CONFIG.raw);

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
        if (PROXY_CONFIG) tvFallback.push('--proxy', PROXY_CONFIG.raw);

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
          if (PROXY_CONFIG) safariFallback.push('--proxy', PROXY_CONFIG.raw);

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
          if (PROXY_CONFIG) embeddedFallback.push('--proxy', PROXY_CONFIG.raw);

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
          if (PROXY_CONFIG) hlsArgs.push('--proxy', PROXY_CONFIG.raw);

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
  if
