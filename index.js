const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const youtubedl = require('youtube-dl-exec');

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
  const supportedDomains = ['youtube.com', 'youtu.be', 'dailymotion.com'];
  try {
    const urlObj = new URL(url);
    return supportedDomains.some(domain => urlObj.hostname.includes(domain));
  } catch { return false; }
}

// Clean URL by removing playlist, radio, and other extra parameters
function cleanVideoUrl(url) {
  try {
    const urlObj = new URL(url);

    // For YouTube, keep only the 'v' parameter (video ID) and 't' (timestamp if present)
    if (urlObj.hostname.includes('youtube.com')) {
      const videoId = urlObj.searchParams.get('v');
      const timestamp = urlObj.searchParams.get('t');
      if (videoId) {
        let cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
        if (timestamp) {
          cleanUrl += `&t=${timestamp}`;
        }
        console.log('Cleaned YouTube URL:', url, '->', cleanUrl);
        return cleanUrl;
      }
    }

    // For youtu.be, it's already clean (format: youtu.be/VIDEO_ID)
    if (urlObj.hostname.includes('youtu.be')) {
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        const cleanUrl = `https://youtu.be/${pathParts[0]}`;
        console.log('Cleaned youtu.be URL:', url, '->', cleanUrl);
        return cleanUrl;
      }
    }

    // For other platforms, return as-is
    return url;
  } catch {
    return url;
  }
}

// Remove all aria2 references from config objects and comments
// Fix: yt-dlp --limit-rate "0" is invalid, must be a positive value or omitted for unlimited speed
// Remove limitRate: '0' from yt-dlp options
// Fix: Remove deprecated yt-dlp options: --no-call-home, --youtube-skip-dash-manifest, --no-write-annotations
// Fix: Use a more compatible yt-dlp format string for YouTube audio extraction
// Replace 'worstaudio[ext=webm]/worstaudio/bestaudio[ext=webm]' with 'bestaudio/best'

let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  process.env.FFMPEG_PATH = ffmpegPath;
  console.log('Using ffmpeg-static:', ffmpegPath);
} catch (err) {
  console.log('ffmpeg-static not found, using system ffmpeg');
  // Do not set process.env.FFMPEG_PATH, let yt-dlp use system ffmpeg
}

async function downloadVideoWithYtdlpUltimate(videoUrl, outputDir, isPremium) {
  const videoId = uuidv4();
  const outputTemplate = `${outputDir}/ytdlp_${videoId}.%(ext)s`;
  const cleanedUrl = cleanVideoUrl(videoUrl);

  try {
    console.log(`DEBUG download:`, cleanedUrl);

 const result = await youtubedl(cleanedUrl, {
  output: outputTemplate,
  extractAudio: true,
  audioFormat: 'mp3',
  format: 'bestaudio/best',
  noPlaylist: true,
  verbose: true,
  proxy: 'http://199.188.207.30' 
});

    console.log('yt-dlp stdout:', result.stdout || '[no stdout]');
    console.log('yt-dlp stderr:', result.stderr || '[no stderr]');

    // Check for output file after yt-dlp runs
    const allFiles = fs.readdirSync(outputDir);
    const files = allFiles.filter(f =>
      f.startsWith(`ytdlp_${videoId}.`) &&
      (f.endsWith('.mp3') || f.endsWith('.webm') || f.endsWith('.m4a'))
    );

    console.log(`Looking for files with prefix: ytdlp_${videoId}`);
    console.log(`Found files:`, files);

    if (files.length === 0) {
      throw new Error('DOWNLOAD_FAILED: yt-dlp did not produce an output file. The video may be unavailable, region-locked, or require login.');
    }

    console.log(`DEBUG downloaded:`, files[0]);
    return `${outputDir}/${files[0]}`;

  } catch (error) {
    console.error('yt-dlp error:', error);

    const errorMessage = error.message || error.toString();

    if (errorMessage.includes('Video unavailable')) {
      throw new Error('VIDEO_UNAVAILABLE: Video unavailable');
    } else if (errorMessage.includes('Private')) {
      throw new Error('VIDEO_PRIVATE: Private video');
    } else if (errorMessage.includes('Sign in')) {
      throw new Error('VIDEO_AGE_RESTRICTED: Age-restricted');
    } else if (errorMessage.includes('Premium')) {
      throw new Error('VIDEO_REQUIRES_AUTH: Requires auth');
    } else if (errorMessage.includes('copyright')) {
      throw new Error('VIDEO_COPYRIGHT: Copyright');
    } else if (errorMessage.includes('429')) {
      throw new Error('RATE_LIMITED: Rate limited');
    } else {
      throw new Error(`DOWNLOAD_FAILED: ${errorMessage}`);
    }
  }
}


async function downloadDirectVideo(videoUrl, outputPath) {
  try {
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: 120000,
      maxRedirects: 5,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

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

// ULTIMATE: Direct FFmpeg spawn for maximum speed (used only if yt-dlp doesn't output MP3)
function convertToMp3Ultimate(inputPath, outputPath, isPremium) {
  return new Promise((resolve, reject) => {
    const label = isPremium ? 'ULTIMATE PREMIUM' : 'ULTRA-FAST';
    console.log(`${label} conversion...`);

    const bitrate = isPremium ? '192k' : '128k';
    const quality = isPremium ? '2' : '4';

    const ffmpeg = spawn('ffmpeg', [
      '-threads', '0',              // All cores
      '-i', inputPath,
      '-vn',                        // No video
      '-sn',                        // No subtitles
      '-dn',                        // No data streams
      '-map', '0:a:0',              // Only first audio
      '-c:a', 'libmp3lame',
      '-b:a', bitrate,
      '-ar', '44100',
      '-ac', '2',
      '-compression_level', '0',    // NO compression for speed
      '-q:a', quality,
      '-write_xing', '0',           // Skip extra metadata
      '-id3v2_version', '0',        // Skip ID3 tags
      '-f', 'mp3',
      '-y',                         // Overwrite
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
    // Multer error handling
    if (err) {
      return res.status(400).json({ error: err.message, errorCode: 'UPLOAD_ERROR' });
    }
    next();
  });
};

app.post('/convert-video-to-mp3', handleUpload, async (req, res) => {
  const premium = isPremiumUser(req);
  console.log(`ULTIMATE conversion request - ${premium ? 'PREMIUM' : 'STANDARD'} user`);
  console.log('Request body:', req.body);
  console.log('Request files:', req.files);

  let inputPath;
  let shouldCleanupInput = false;
  const startTime = Date.now();

  // Handle file size limit exceeded (413 Payload Too Large)
  if (req.files && req.files.length > 0) {
    const file = req.files[0];
    if (file.size > 500 * 1024 * 1024) { // 500MB limit
      return res.status(413).json({
        error: 'File size exceeds 500MB limit.',
        errorCode: 'FILE_TOO_LARGE'
      });
    }
  }

  try {
    // Check for file in req.files array (when using .any())
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

        try {
          // Use ULTIMATE speed with tier-based settings
          inputPath = await downloadVideoWithYtdlpUltimate(videoUrl, '/tmp', premium);

          // If already MP3 (yt-dlp converted it during download), skip conversion!
          if (inputPath.endsWith('.mp3')) {
            console.log('Already MP3! No conversion needed.');
            const stats = fs.statSync(inputPath);
            const audioData = fs.readFileSync(inputPath);
            const base64Audio = audioData.toString('base64');

            fs.unlinkSync(inputPath);

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`Total: ${elapsed}s (${premium ? 'PREMIUM' : 'STANDARD'})`);

            return res.json({
              success: true,
              audioData: base64Audio,
              filename: 'audio.mp3',
              size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
              conversionTime: `${elapsed}s`,
              tier: premium ? 'premium' : 'standard'
            });
          }

        } catch (ytdlpError) {
          const errorMsg = ytdlpError.message || ytdlpError.toString();
          const errorCode = errorMsg.split(':')[0];

          return res.status(400).json({
            error: errorMsg,
            errorCode: errorCode,
            errorDetail: errorMsg.split(':')[1]?.trim() || errorMsg
          });
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

    // Convert with tier-based settings
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
    // Handle yt-dlp errors and send 400 for unsupported URLs or formats
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
    mode: 'ULTIMATE (Premium + Standard)',
    cdnEnabled: !!process.env.CDN_PROXY_URL
  });
});

app.listen(port, () => {
  console.log(`ULTIMATE conversion service on port ${port}`);
});

// No code changes are needed for the Node.js socket/file handle output you posted.
// This output is normal for Node.js streams and sockets, especially after process exit or cleanup.
// If you are not seeing errors or crashes, you can ignore these internal details.

// If you experience actual socket/file handle exhaustion (EMFILE errors), set Docker/container ulimits as previously advised.
