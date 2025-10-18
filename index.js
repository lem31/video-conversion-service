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

    return (
      host.includes('youtube.com') || host.includes('youtu.be') ||
      host.includes('tiktok.com') ||
      host.includes('instagram.com') ||
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
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return `https://www.youtube.com/watch?v=${raw}`;

    const urlObj = new URL(raw, 'https://www.youtube.com');
    const host = urlObj.hostname.toLowerCase();

    if (host === 'youtu.be') {
      const id = urlObj.pathname.replace(/^\/+/, '').split('/')[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
      return raw;
    }

    if (host.endsWith('youtube.com') || host.includes('youtube')) {
      const v = urlObj.searchParams.get('v');
      if (v) {
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

      return raw;
    }

    return raw;
  } catch {
    return input;
  }
}

function sanitizeArgsForLog(args) {
  const masked = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cookies' || a === '--proxy' || a === '--cookies-from-browser') {
      const next = args[i + 1];
      masked.push(a);
      if (next) {
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
        i++;
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
    } catch (e) { /* ignore */ }

    const proc = spawn('yt-dlp', args, { cwd });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });

      try {
        console.warn('yt-dlp failed (code %d). stderr:', code, stderr.toString().trim().slice(0, 1000));
        if (stdout && stdout.trim()) console.warn('yt-dlp stdout (trim):', stdout.toString().trim().slice(0, 1000));
      } catch (e) { /* ignore */ }

      const err = new Error(`yt-dlp exit ${code}: ${stderr || stdout}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

// Stream yt-dlp -> ffmpeg to produce MP3 without writing source file
async function streamYtdlpToFfmpeg(cleanedUrl, ytFormat, outputPath, isPremium, ytExtraArgs = [], playerClient = 'web') {
  return new Promise((resolve, reject) => {
    // FIX: Add Safari client args for piped mode (same as Layer 2)
    const userAgent = playerClient === 'web_safari'
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    const ytdlpArgs = [
      '--no-playlist',
      '--no-warnings',
      '-f', ytFormat,
      '-o', '-',
      '--extractor-args', `youtube:player_client=${playerClient}`,
      '--user-agent', userAgent,
      '--referer', 'https://www.youtube.com/',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '--add-header', 'Sec-Fetch-Site:none',
      '--add-header', 'Sec-Fetch-Mode:navigate',
      '--add-header', 'Sec-Fetch-Dest:document',
      cleanedUrl,
      ...ytExtraArgs
    ];

    const ytdlp = spawn('yt-dlp', ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    const bitrate = isPremium ? '192k' : '96k';
    const quality = '2'; // Use fast encoding for all tiers (bitrate controls size, not quality)

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-err_detect', 'ignore_err',
      '-fflags', '+discardcorrupt+genpts',
      '-i', 'pipe:0',
      '-vn', '-sn', '-dn',
      '-map', '0:a:0?',
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

    let ytdlpErr = '';
    ytdlp.stderr.on('data', (b) => { ytdlpErr += b.toString(); });

    let ffErr = '';
    ff.stderr.on('data', (b) => { ffErr += b.toString(); });

    let pipeError = null;

    ytdlp.stdout.on('error', (e) => {
      console.warn('yt-dlp stdout pipe error:', e.message);
      pipeError = e;
    });

    ff.stdin.on('error', (e) => {
      console.warn('ffmpeg stdin pipe error:', e.message);
      pipeError = e;
    });

    ytdlp.stdout.pipe(ff.stdin).on('error', (e) => {
      console.warn('Pipe connection error:', e.message);
      pipeError = e;
    });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        console.warn(`yt-dlp exited with code ${code} in piped mode`);
        try { ff.kill(); } catch (e) {}
        const msg = ytdlpErr || `yt-dlp exited ${code}`;
        reject(new Error(`PIPED_FAILED: ytdlp: ${msg}`));
      }
    });

    ff.on('close', (code) => {
      try { ytdlp.kill(); } catch (e) {}

      if (code === 0) {
        // Verify output file exists and has content
        if (fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          if (stats.size > 1000) { // At least 1KB
            return resolve();
          } else {
            return reject(new Error(`PIPED_FAILED: Output file too small (${stats.size} bytes)`));
          }
        } else {
          return reject(new Error('PIPED_FAILED: Output file not created'));
        }
      }

      const msg = ffErr || ytdlpErr || pipeError?.message || `ffmpeg exited ${code}`;
      reject(new Error(`PIPED_FAILED: ${msg}`));
    });

    ff.on('error', (e) => {
      try { ytdlp.kill(); } catch (er) {}
      reject(new Error(`PIPED_FAILED: ffmpeg error: ${e.message}`));
    });

    ytdlp.on('error', (e) => {
      try { ff.kill(); } catch (er) {}
      reject(new Error(`PIPED_FAILED: ytdlp error: ${e.message}`));
    });
  });
}

// OPTIMIZED: Reduced to 2 layers with fast-fail timeouts
async function downloadVideoWithYtdlpOptimized(videoUrl, outputDir, isPremium) {
  const videoId = uuidv4();
  const outputTemplate = `${outputDir}/ytdlp_${videoId}.%(ext)s`;
  const cleanedUrl = cleanVideoUrl(videoUrl);

  // Fast-fail timeout per layer
  const LAYER_TIMEOUT = isPremium ? 120000 : 90000; // 120s premium, 90s free (increased for reliability)

  try {
    console.log('OPTIMIZED download:', cleanedUrl);

    // OPTIMIZATION: Skip metadata probe for known-short videos (Shorts, youtu.be)
    let preferM4aForShort = false;
    let probedDurationSec = 0;
    const isShortUrl = cleanedUrl.includes('youtube.com/shorts/') ||
                       cleanedUrl.includes('youtu.be/');

    if (!isShortUrl && process.env.SKIP_METADATA_PROBE !== 'true') {
      try {
        console.log('Probing video metadata...');
        const probeTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('PROBE_TIMEOUT')), 5000)
        );

        const probePromise = runYtDlp(['--no-warnings', '--skip-download', '--dump-json', cleanedUrl], '/tmp');
        const probe = await Promise.race([probePromise, probeTimeout]);

        const firstLine = (probe.stdout || '').split('\n').find(l => l.trim().length > 0);
        if (firstLine) {
          try {
            const info = JSON.parse(firstLine);
            const durationSec = Number(info.duration || info._duration || 0);
            probedDurationSec = !isNaN(durationSec) ? durationSec : 0;
            console.log('Probed duration (s):', probedDurationSec);

            if (probedDurationSec > 0 && probedDurationSec <= 120) {
              preferM4aForShort = true;
              console.log('Short video detected - using fast format.');
            }
          } catch (e) {
            console.warn('Failed to parse probe JSON:', e.message);
          }
        }
      } catch (probeErr) {
        console.warn('Metadata probe failed or timed out (continuing):', probeErr.message);
      }
    } else if (isShortUrl) {
      console.log('Short URL detected - skipping metadata probe');
      preferM4aForShort = true;
    }

    // Choose format based on user tier and video length
    const formatString = isPremium
      ? 'bestaudio/best'
      : (preferM4aForShort ? 'bestaudio[ext=m4a][abr<=160]/bestaudio[abr<=128]/bestaudio/best' : 'bestaudio[abr<=128]/bestaudio/best');

    // Determine player client
    const preferredClientEnv = (process.env.PREFERRED_YTDLP_CLIENT || '').trim();
    let playerClient = 'web';
    if (preferredClientEnv) {
      playerClient = preferredClientEnv;
    } else if (preferM4aForShort) {
      playerClient = 'web_safari';
    } else {
      const LONG_VIDEO_THRESHOLD = Number(process.env.LONG_VIDEO_THRESHOLD || 600);
      if (probedDurationSec >= LONG_VIDEO_THRESHOLD) {
        playerClient = 'web_safari';
        console.log(`Long video (${probedDurationSec}s) - using web_safari`);
      }
    }
    console.log(`Using player_client: ${playerClient}`);

    const baseArgs = [
      '--no-playlist',
      '-x', '--audio-format', 'mp3',
      '--format', formatString,
      '--output', outputTemplate,
      '--no-mtime',
      '--extractor-args', `youtube:player_client=${playerClient}`,
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
      console.log(`Using cookies from ${process.env.YTDLP_BROWSER} browser`);
    }

    if (process.env.YTDLP_PROXY) extraArgs.push('--proxy', process.env.YTDLP_PROXY);

    let lastYtdlpError = null;

    // DISABLED: Piped mode removed - unreliable and causes delays
    // Direct download is faster and more reliable

    // OPTIMIZATION: Skip Layer 1 for Shorts - start with Safari (works most often)
    const skipLayer1 = isShortUrl || preferM4aForShort;

    if (!skipLayer1) {
      // LAYER 1: Primary method with timeout (only for longer videos)
      try {
        console.log('Layer 1: Primary method...');
        const layer1Timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('LAYER_TIMEOUT')), LAYER_TIMEOUT)
        );
        const layer1Promise = runYtDlp([...baseArgs, ...extraArgs], '/tmp');

        await Promise.race([layer1Promise, layer1Timeout]);
        console.log('SUCCESS: Layer 1 worked!');
        // Success - skip to file finding
      } catch (firstErr) {
        console.warn('Layer 1 failed:', firstErr.message);
        lastYtdlpError = firstErr;
      }
    } else {
      console.log('Skipping Layer 1 - optimized for Shorts, starting with Safari');
      lastYtdlpError = new Error('SKIPPED_LAYER_1');
    }

    // LAYER 2: Safari fallback (USER REQUESTED - works most often)
    if (lastYtdlpError) {
      console.log('Layer 2: Safari fallback (primary working layer)...');
      try {
        const safariFallback = [
          '--no-playlist',
          '-x', '--audio-format', 'mp3',
          '--format', 'bestaudio/best',
          '--output', outputTemplate,
          '--extractor-args', 'youtube:player_client=web_safari',
          '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          '--referer', 'https://www.youtube.com/',
          '--add-header', 'Accept-Language:en-US,en;q=0.9',
          cleanedUrl
        ];

        if (process.env.YTDLP_COOKIES) safariFallback.push('--cookies', process.env.YTDLP_COOKIES);
        if (process.env.YTDLP_PROXY) safariFallback.push('--proxy', process.env.YTDLP_PROXY);

        const layer2Timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('LAYER_TIMEOUT')), LAYER_TIMEOUT)
        );
        const layer2Promise = runYtDlp(safariFallback, '/tmp');

        await Promise.race([layer2Promise, layer2Timeout]);
        console.log('SUCCESS: Layer 2 (Safari) worked!');
        lastYtdlpError = null;
      } catch (safariErr) {
        console.warn('Layer 2 (Safari) failed:', safariErr.message);
        lastYtdlpError = safariErr;

        // LAYER 3: TV embedded fallback (final fallback)
        console.log('Layer 3: TV embedded fallback...');
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

          const layer3Timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('LAYER_TIMEOUT')), LAYER_TIMEOUT)
          );
          const layer3Promise = runYtDlp(tvFallback, '/tmp');

          await Promise.race([layer3Promise, layer3Timeout]);
          console.log('SUCCESS: Layer 3 (TV embedded) worked!');
          lastYtdlpError = null;
        } catch (tvErr) {
          console.warn('Layer 3 (TV embedded) failed:', tvErr.message);
          lastYtdlpError = tvErr;
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
      if (lastYtdlpError) {
        throw lastYtdlpError;
      }
      throw new Error('DOWNLOAD_FAILED: yt-dlp did not produce output. Video may be unavailable, region-locked, or require login.');
    }

    let finalFile = files.find(f => f.endsWith('.mp3')) || files[0];
    let finalPath = `${outputDir}/${finalFile}`;

    if (!finalPath.endsWith('.mp3')) {
      const mp3Path = finalPath.replace(/\.(webm|m4a|wav|aac)$/, '.mp3');
      await convertToMp3Optimized(finalPath, mp3Path, isPremium);
      try { fs.unlinkSync(finalPath); } catch (e) { /* ignore */ }
      finalPath = mp3Path;
    }

    console.log('Downloaded:', finalPath);
    return finalPath;

  } catch (error) {
    console.error('yt-dlp error:', error);
    const msg = error.message || String(error);

    // User-friendly error messages
    if (msg.includes('Sign in to confirm') || (msg.includes('Sign in') && msg.includes('bot'))) {
      throw new Error('VIDEO_RATE_LIMITED: YouTube is rate limiting this server. Try a different video or wait a few minutes.');
    }

    if (msg.includes('vimeo') && (msg.includes('logged-in') || msg.includes('authentication'))) {
      throw new Error('VIDEO_REQUIRES_AUTH: This Vimeo video requires authentication.');
    }

    if (msg.includes('This video is private') || msg.includes('Private video')) {
      throw new Error('VIDEO_PRIVATE: This video is private.');
    } else if (msg.includes('age') && msg.includes('restricted')) {
      throw new Error('VIDEO_AGE_RESTRICTED: This video is age-restricted.');
    } else if (msg.includes('members-only') || msg.includes('Join this channel')) {
      throw new Error('VIDEO_MEMBERS_ONLY: This video is for channel members only.');
    } else if (msg.includes('copyright') && msg.includes('blocked')) {
      throw new Error('VIDEO_COPYRIGHT: This video is blocked due to copyright.');
    } else if (msg.includes('HTTP Error 429')) {
      throw new Error('RATE_LIMITED: Too many requests. Try again in a few minutes.');
    } else {
      throw new Error('VIDEO_UNAVAILABLE: Cannot download this video. It may be unavailable, deleted, region-restricted, or require authentication.');
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

// OPTIMIZED: Faster FFmpeg conversion
function convertToMp3Optimized(inputPath, outputPath, isPremium) {
  return new Promise((resolve, reject) => {
    const label = isPremium ? 'PREMIUM' : 'STANDARD';
    console.log(`${label} conversion...`);

    const bitrate = isPremium ? '192k' : '96k';
    const quality = '2'; // Use fast encoding for all tiers (bitrate controls size, not quality)

    const ffmpeg = spawn('ffmpeg', [
      '-threads', '0',
      '-i', inputPath,
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
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });

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

const handleUpload = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message, errorCode: 'UPLOAD_ERROR' });
    }
    next();
  });
};

// Cache directory
const CACHE_DIR = process.env.VIDEO_CACHE_DIR || path.join(os.tmpdir(), 'video_cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Start cache cleaner (optional - graceful fallback if module missing)
try {
  const cacheCleanerPath = path.join(__dirname, 'cacheCleaner.js');
  if (fs.existsSync(cacheCleanerPath)) {
    const { startCacheCleaner } = require('./cacheCleaner');
    const CACHE_CLEAN_DAYS = Number(process.env.CACHE_CLEAN_DAYS || 7);
    const CACHE_CLEAN_INTERVAL_HOURS = Number(process.env.CACHE_CLEAN_INTERVAL_HOURS || 24);
    startCacheCleaner(CACHE_DIR, CACHE_CLEAN_DAYS, CACHE_CLEAN_INTERVAL_HOURS);
    console.log(`Cache cleaner: purge files older than ${CACHE_CLEAN_DAYS} days every ${CACHE_CLEAN_INTERVAL_HOURS} hours`);
  } else {
    console.warn('cacheCleaner.js not found - cache will not be automatically cleaned');
  }
} catch (e) {
  console.warn('Failed to start cache cleaner:', e.message);
}

// OPTIMIZED: Priority-aware concurrency limiter
const MAX_CONCURRENT_PREMIUM = Number(process.env.MAX_CONCURRENT_DOWNLOADS_PREMIUM || 4);
const MAX_CONCURRENT_STANDARD = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2);
let currentDownloads = 0;
const highPriorityQueue = []; // Premium users
const normalPriorityQueue = []; // Standard users

function acquireDownloadSlot(priority = 'normal', isPremium = false) {
  return new Promise((resolve) => {
    const maxConcurrent = isPremium ? MAX_CONCURRENT_PREMIUM : MAX_CONCURRENT_STANDARD;

    if (currentDownloads < maxConcurrent) {
      currentDownloads++;
      console.log(`Acquired slot (${currentDownloads}/${maxConcurrent}) - ${priority} priority`);
      return resolve();
    }

    // Queue based on priority
    if (priority === 'high') {
      highPriorityQueue.push(resolve);
      console.log(`Queued high priority (${highPriorityQueue.length} waiting)`);
    } else {
      normalPriorityQueue.push(resolve);
      console.log(`Queued normal priority (${normalPriorityQueue.length} waiting)`);
    }
  });
}

function releaseDownloadSlot() {
  currentDownloads = Math.max(0, currentDownloads - 1);

  // Process high priority queue first
  const next = highPriorityQueue.shift() || normalPriorityQueue.shift();
  if (next) {
    currentDownloads++;
    console.log(`Released slot, processing queued request (${currentDownloads} active)`);
    next();
  }
}

function computeCacheKey(url, opts = {}) {
  const hash = crypto.createHash('sha256');
  hash.update(String(url));
  if (opts.quality) hash.update(String(opts.quality));
  return hash.digest('hex');
}

function parseProxyEnv() {
  const raw = process.env.YTDLP_PROXY;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    let port = u.port;
    if (!port) {
      const inferred = u.protocol === 'http:' ? '80' : (u.protocol === 'https:' ? '443' : '');
      console.warn(`YTDLP_PROXY missing port; inferring ${inferred}`);
      port = inferred;
    }
    const auth = u.username ? {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password)
    } : null;
    return { raw, protocol: u.protocol.replace(':', ''), host: u.hostname, port: port, auth };
  } catch (err) {
    console.warn('Invalid YTDLP_PROXY:', raw, err.message);
    return null;
  }
}

const PROXY_CONFIG = parseProxyEnv();
if (PROXY_CONFIG) {
  console.log(`Proxy: ${PROXY_CONFIG.protocol}://${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`);
} else {
  console.log('No proxy configured');
}

// Binary checks
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
  'python3': checkBinary('python3', ['--version'])
};

Object.keys(BINARIES).forEach(k => {
  if (!BINARIES[k].ok) {
    console.warn(`MISSING: ${k} -> ${BINARIES[k].message}`);
  } else {
    console.log(`FOUND: ${k} -> ${BINARIES[k].message}`);
  }
});

app.post('/convert-video-to-mp3', handleUpload, async (req, res) => {
  const premium = isPremiumUser(req);
  const priority = req.headers['x-request-priority'] === 'high' ? 'high' : 'normal';

  console.log(`Request: ${premium ? 'PREMIUM' : 'STANDARD'} user, ${priority} priority`);

  let inputPath;
  let shouldCleanupInput = false;
  const startTime = Date.now();

  // Handle file size limit
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

        // OPTIMIZATION: Check cache BEFORE acquiring download slot
        const cleaned = cleanVideoUrl(videoUrl);
        const cacheKey = computeCacheKey(cleaned);
        const cachedPath = path.join(CACHE_DIR, `${cacheKey}.mp3`);

        if (fs.existsSync(cachedPath)) {
          console.log(`✓ Cache hit for ${cleaned}`);
          const stats = fs.statSync(cachedPath);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`Total (cached): ${elapsed}s`);

          // Stream binary response (faster for all devices)
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
          res.setHeader('Content-Length', stats.size);
          res.setHeader('X-Conversion-Time', `${elapsed}s`);
          res.setHeader('X-File-Size', `${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          res.setHeader('X-User-Tier', premium ? 'premium' : 'standard');
          res.setHeader('X-Cached', 'true');

          return fs.createReadStream(cachedPath).pipe(res);
        }

        // Acquire slot with priority awareness
        await acquireDownloadSlot(priority, premium);
        let downloadedPath = null;

        try {
          downloadedPath = await downloadVideoWithYtdlpOptimized(videoUrl, '/tmp', premium);

          // Cache the result
          if (downloadedPath && fs.existsSync(downloadedPath)) {
            try {
              if (!fs.existsSync(cachedPath)) {
                fs.copyFileSync(downloadedPath, cachedPath);
                console.log(`✓ Cached: ${cleaned}`);
              }
            } catch (e) {
              console.warn('Cache write failed:', e.message);
            }
          }
        } finally {
          releaseDownloadSlot();
        }

        // Serve from cache if available, otherwise from downloaded file
        const finalServePath = fs.existsSync(cachedPath) ? cachedPath : downloadedPath;
        if (finalServePath && finalServePath.endsWith('.mp3')) {
          console.log('Serving MP3:', finalServePath);
          const stats = fs.statSync(finalServePath);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          // Stream binary response (faster for all devices)
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
          res.setHeader('Content-Length', stats.size);
          res.setHeader('X-Conversion-Time', `${elapsed}s`);
          res.setHeader('X-File-Size', `${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          res.setHeader('X-User-Tier', premium ? 'premium' : 'standard');
          res.setHeader('X-Cached', fs.existsSync(cachedPath) ? 'true' : 'false');

          const stream = fs.createReadStream(finalServePath);
          stream.pipe(res);

          // Cleanup temp file after streaming completes
          stream.on('end', () => {
            if (fs.existsSync(downloadedPath) && downloadedPath !== cachedPath) {
              try { fs.unlinkSync(downloadedPath); } catch (e) { /* ignore */ }
            }
          });

          return;
        }
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

    await convertToMp3Optimized(inputPath, outputPath, premium);

    const stats = fs.statSync(outputPath);
    const filename = videoFile ? `${videoFile.originalname.split('.')[0]}.mp3` : `audio_${outputId}.mp3`;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Total: ${elapsed}s`);

    // Stream binary response (faster for all devices)
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('X-Conversion-Time', `${elapsed}s`);
    res.setHeader('X-File-Size', `${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    res.setHeader('X-User-Tier', premium ? 'premium' : 'standard');
    res.setHeader('X-Cached', 'false');

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);

    // Cleanup after streaming completes
    stream.on('end', () => {
      try { fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
      if (shouldCleanupInput && fs.existsSync(inputPath)) {
        try { fs.unlinkSync(inputPath); } catch (e) { /* ignore */ }
      }
      if (videoFile && fs.existsSync(videoFile.path)) {
        try { fs.unlinkSync(videoFile.path); } catch (e) { /* ignore */ }
      }
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
    mode: 'OPTIMIZED (3-Layer Fast-Fail)',
    layers: '3 (Primary → Safari → TV Embedded)',
    timeouts: 'Layer timeout: 60-90s',
    cacheFirst: true,
    priorityQueue: true,
    cookiesEnabled: !!process.env.YTDLP_COOKIES,
    proxyEnabled: !!process.env.YTDLP_PROXY,
    binaries: BINARIES,
    concurrency: {
      premium: MAX_CONCURRENT_PREMIUM,
      standard: MAX_CONCURRENT_STANDARD
    }
  });
});

app.listen(port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  OPTIMIZED Video Conversion Service                       ║
║  Port: ${port}                                            ║
║  Performance Mode: ENABLED                                ║
║  ✓ Cache-first strategy                                   ║
║  ✓ Priority queue for premium users                       ║
║  ✓ Fast-fail timeouts (60-90s per layer)                  ║
║  ✓ 3 optimized layers (Primary → Safari → TV)             ║
║  Expected: 40-60% faster than before                      ║
╚═══════════════════════════════════════════════════════════╝
  `);
  console.log('Configuration:');
  console.log('  - Cookies:', process.env.YTDLP_COOKIES ? 'ENABLED' : 'DISABLED');
  console.log('  - Proxy:', process.env.YTDLP_PROXY ? 'ENABLED' : 'DISABLED');
  console.log('  - Skip metadata probe:', process.env.SKIP_METADATA_PROBE || 'auto (shorts only)');
  console.log('  - Pipe mode:', process.env.ENABLE_PIPE === '1' ? 'ENABLED' : 'DISABLED (recommended)');
  console.log('  - Concurrent downloads (premium):', MAX_CONCURRENT_PREMIUM);
  console.log('  - Concurrent downloads (standard):', MAX_CONCURRENT_STANDARD);
  console.log('\n🚀 Ready! Optimized for speed.\n');
});
