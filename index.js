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

// ULTIMATE SPEED: Premium users get maximum speed with MP3 conversion during download
async function downloadVideoWithYtdlpUltimate(videoUrl, outputDir, isPremium) {
    const videoId = uuidv4();
    const outputTemplate = `${outputDir}/ytdlp_${videoId}.%(ext)s`;

    // Clean the URL to remove playlist/radio parameters
    const cleanedUrl = cleanVideoUrl(videoUrl);

    const config = isPremium ? {
      // PREMIUM: Maximum speed + better quality
      audioQuality: 2,                   // Excellent quality (2 = very good)
      concurrentFragments: 32,           // 32 parallel downloads
      externalDownloaderArgs: 'aria2c:-x 32 -s 32 -k 512K -j 32 --max-connection-per-server=16',
      bufferSize: '128K',                // Large buffer
      httpChunkSize: '20M',              // Large chunks
      proxy: process.env.CDN_PROXY_URL || undefined,
      label: 'ULTIMATE PREMIUM'
    } : {
      // STANDARD: Good speed + good quality
      audioQuality: 4,                   // Good quality
      concurrentFragments: 16,           // 16 parallel downloads
      externalDownloaderArgs: 'aria2c:-x 16 -s 16 -k 1M -j 16',
      bufferSize: '64K',
      httpChunkSize: '10M',
      proxy: undefined,
      label: 'ULTRA-FAST'
    };

    try {
      console.log(`${config.label} download:`, cleanedUrl);

      // ULTIMATE: Convert to MP3 DURING download (eliminates separate conversion!)
      await youtubedl(cleanedUrl, {
        output: outputTemplate,
        format: 'worstaudio[ext=webm]/worstaudio/bestaudio[ext=webm]',
        extractAudio: true,
        audioFormat: 'mp3',              // Convert to MP3 during download!
        audioQuality: config.audioQuality,
        noPlaylist: true,
        quiet: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        youtubeSkipDashManifest: true,
        concurrentFragments: config.concurrentFragments,
        externalDownloader: 'aria2c',
        externalDownloaderArgs: config.externalDownloaderArgs,
        ...(config.proxy && { proxy: config.proxy }),
        // Skip ALL metadata
        noWriteThumbnail: true,
        noEmbedThumbnail: true,
        noWriteInfoJson: true,
        noWriteDescription: true,
        noWriteAnnotations: true,
        noWriteComments: true,
        noWritePlaylistMetafiles: true,
        // Speed optimizations
        noCheckFormats: true,
        noContinue: true,
        bufferSize: config.bufferSize,
        httpChunkSize: config.httpChunkSize,
        limitRate: '0',                  // No rate limit!
        retries: 1,
        fragmentRetries: 1
      });

      const allFiles = fs.readdirSync(outputDir);
      const files = allFiles.filter(f => f.startsWith(`ytdlp_${videoId}.`));

      console.log(`Looking for files with prefix: ytdlp_${videoId}`);
      console.log(`Found files:`, files);
      console.log(`All files in ${outputDir}:`, allFiles.filter(f => f.startsWith('ytdlp_')));

      if (files.length === 0) {
        throw new Error('Download completed but no file was created');
      }

      console.log(`${config.label} downloaded:`, files[0]);
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
