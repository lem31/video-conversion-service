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

// PREMIUM: Ultra-fast download with CDN proxy
async function downloadVideoWithYtdlpPremium(videoUrl, outputDir) {
    const videoId = uuidv4();
    const outputTemplate = `${outputDir}/ytdlp_${videoId}.%(ext)s`;

    try {
      console.log('PREMIUM SPEED download:', videoUrl);

      await youtubedl(videoUrl, {
        output: outputTemplate,
        format: 'worstaudio[ext=webm]/worstaudio/bestaudio[ext=webm]',
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 3,                 // PREMIUM: Better quality (3 vs 5)
        noPlaylist: true,
        quiet: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        youtubeSkipDashManifest: true,
        concurrentFragments: 32,         // PREMIUM: 32 fragments (vs 16)
        externalDownloader: 'aria2c',
        externalDownloaderArgs: 'aria2c:-x 32 -s 32 -k 512K -j 32 --max-connection-per-server=16',
        // PREMIUM: Use CDN proxy if available
        proxy: process.env.CDN_PROXY_URL, // Set in Railway env vars
        noWriteThumbnail: true,
        noEmbedThumbnail: true,
        noWriteInfoJson: true,
        noWriteDescription: true,
        noWriteAnnotations: true,
        noWriteComments: true,
        noWritePlaylistMetafiles: true,
        noCheckFormats: true,
        noContinue: true,
        bufferSize: '128K',              // PREMIUM: Larger buffer
        httpChunkSize: '20M',            // PREMIUM: Larger chunks
        limitRate: '0',
        retries: 1,
        fragmentRetries: 1
      });

      const allFiles = fs.readdirSync(outputDir);
      const files = allFiles.filter(f => f.startsWith(`ytdlp_${videoId}.`));

      if (files.length === 0) {
        throw new Error('Download failed');
      }

      console.log('Downloaded:', files[0]);
      return `${outputDir}/${files[0]}`;

    } catch (error) {
      throw error;
    }
}

// Standard speed download for free users
async function downloadVideoWithYtdlpStandard(videoUrl, outputDir) {
    const videoId = uuidv4();
    const outputTemplate = `${outputDir}/ytdlp_${videoId}.%(ext)s`;

    try {
      console.log('Standard speed download:', videoUrl);

      await youtubedl(videoUrl, {
        output: outputTemplate,
        format: 'worstaudio[ext=webm]/worstaudio/bestaudio[ext=webm]',
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 5,                 // Standard quality
        noPlaylist: true,
        quiet: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        youtubeSkipDashManifest: true,
        concurrentFragments: 16,
        externalDownloader: 'aria2c',
        externalDownloaderArgs: 'aria2c:-x 16 -s 16 -k 1M -j 16',
        noWriteThumbnail: true,
        noEmbedThumbnail: true,
        noWriteInfoJson: true,
        bufferSize: '64K',
        httpChunkSize: '10M',
        limitRate: '0',
        retries: 1,
        fragmentRetries: 1
      });

      const allFiles = fs.readdirSync(outputDir);
      const files = allFiles.filter(f => f.startsWith(`ytdlp_${videoId}.`));

      if (files.length === 0) {
        throw new Error('Download failed');
      }

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

// PREMIUM: Better quality conversion
function convertToMp3Premium(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log('PREMIUM conversion...');

    const ffmpeg = spawn('ffmpeg', [
      '-threads', '0',
      '-i', inputPath,
      '-vn',
      '-sn',
      '-dn',
      '-map', '0:a:0',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',               // PREMIUM: Higher bitrate
      '-ar', '44100',
      '-ac', '2',
      '-compression_level', '0',
      '-q:a', '2',                  // PREMIUM: Higher quality
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
        console.log('Premium conversion done!');
        resolve();
      } else {
        reject(new Error(`FFmpeg failed: ${stderr}`));
      }
    });

    ffmpeg.on('error', reject);
  });
}

// Standard conversion
function convertToMp3Standard(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log('Standard conversion...');

    const ffmpeg = spawn('ffmpeg', [
      '-threads', '0',
      '-i', inputPath,
      '-vn',
      '-sn',
      '-dn',
      '-map', '0:a:0',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      '-compression_level', '0',
      '-q:a', '4',
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
        resolve();
      } else {
        reject(new Error(`FFmpeg failed: ${stderr}`));
      }
    });

    ffmpeg.on('error', reject);
  });
}

app.post('/convert-video-to-mp3', upload.single('video'), async (req, res) => {
  const premium = isPremiumUser(req);
  console.log(`Conversion request - ${premium ? 'PREMIUM' : 'STANDARD'} user`);

  let inputPath;
  let shouldCleanupInput = false;
  const startTime = Date.now();

  try {
    if (req.file) {
      inputPath = req.file.path;
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
          // Use premium or standard download based on user tier
          inputPath = premium
            ? await downloadVideoWithYtdlpPremium(videoUrl, '/tmp')
            : await downloadVideoWithYtdlpStandard(videoUrl, '/tmp');

          // If already MP3, skip conversion
          if (inputPath.endsWith('.mp3')) {
            console.log('Already MP3!');
            const stats = fs.statSync(inputPath);
            const audioData = fs.readFileSync(inputPath);
            const base64Audio = audioData.toString('base64');

            fs.unlinkSync(inputPath);

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`Total: ${elapsed}s`);

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

    // Use premium or standard conversion
    if (premium) {
      await convertToMp3Premium(inputPath, outputPath);
    } else {
      await convertToMp3Standard(inputPath, outputPath);
    }

    const stats = fs.statSync(outputPath);
    const audioData = fs.readFileSync(outputPath);
    const base64Audio = audioData.toString('base64');

    // Cleanup
    fs.unlinkSync(outputPath);
    if (shouldCleanupInput && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    const filename = req.file ? `${req.file.originalname.split('.')[0]}.mp3` : `audio_${outputId}.mp3`;
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
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.status(500).json({
      error: error.message || 'Server error',
      errorCode: 'SERVER_ERROR'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    mode: 'PREMIUM + STANDARD',
    cdnEnabled: !!process.env.CDN_PROXY_URL
  });
});

app.listen(port, () => {
  console.log(`Premium conversion service on port ${port}`);
});
