const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
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

function isSupportedVideoUrl(url) {
  const supportedDomains = ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com'];
  try {
    const urlObj = new URL(url);
    return supportedDomains.some(domain => urlObj.hostname.includes(domain));
  } catch { return false; }
}

 async function downloadVideoWithYtdlp(videoUrl, outputDir) {
    const videoId = uuidv4();
    const outputTemplate = `${outputDir}/ytdlp_${videoId}.%(ext)s`;

    try {
      console.log('Attempting to download with yt-dlp:', videoUrl);
      console.log('Output template:', outputTemplate);

      await youtubedl(videoUrl, {
        output: outputTemplate,
        format: 'bestaudio/best',
        noPlaylist: true,
        quiet: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        youtubeSkipDashManifest: true
      });

      // List all files in output directory for debugging
      const allFiles = fs.readdirSync(outputDir);
      console.log('All files in /tmp after download:', allFiles);

      // Find the downloaded file
      const files = allFiles.filter(f => f.startsWith(`ytdlp_${videoId}.`));

      if (files.length === 0) {
        console.error('No file found with prefix ytdlp_' + videoId);
        console.error('Available files:', allFiles);
        throw new Error('Download completed but no file was created');
      }

      console.log('Downloaded file:', files[0]);
      return `${outputDir}/${files[0]}`;

    } catch (error) {
      console.error('yt-dlp error details:', error);

      // Map common errors to user-friendly messages
      const errorMessage = error.message || error.toString();

      if (errorMessage.includes('Video unavailable')) {
        throw new Error('VIDEO_UNAVAILABLE: This video is unavailable, private, or deleted');
      } else if (errorMessage.includes('Private video')) {
        throw new Error('VIDEO_PRIVATE: This video is private and cannot be downloaded');
      } else if (errorMessage.includes('Sign in to confirm your age')) {
        throw new Error('VIDEO_AGE_RESTRICTED: This video is age-restricted');
      } else if (errorMessage.includes('This video is only available to Music Premium members')) {
        throw new Error('VIDEO_REQUIRES_AUTH: This video requires authentication');
      } else if (errorMessage.includes('copyright')) {
        throw new Error('VIDEO_COPYRIGHT: This video cannot be downloaded due to copyright
  restrictions');
      } else if (errorMessage.includes('not available in your country')) {
        throw new Error('VIDEO_UNAVAILABLE: This video is not available in your region');
      } else if (errorMessage.includes('HTTP Error 429')) {
        throw new Error('RATE_LIMITED: Too many requests. Please try again later');
      } else {
        throw new Error(`DOWNLOAD_FAILED: ${errorMessage}`);
      }
    }
  }
async function downloadDirectVideo(videoUrl, outputPath) {
  try {
    console.log('Downloading direct video from:', videoUrl);
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: 60000,
      maxRedirects: 5
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log('Direct download completed');
        resolve();
      });
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Direct download error:', error);
    throw new Error(`Direct download failed: ${error.message}`);
  }
}

app.post('/convert-video-to-mp3', upload.single('video'), async (req, res) => {
  console.log('Conversion request received');
  let inputPath;
  let shouldCleanupInput = false;

  try {
    if (req.file) {
      inputPath = req.file.path;
      console.log('File uploaded:', req.file.originalname);
    } else if (req.body.videoUrl) {
      const videoUrl = req.body.videoUrl;
      console.log('URL provided:', videoUrl);
      shouldCleanupInput = true;

      if (isSupportedVideoUrl(videoUrl)) {
        console.log('Using yt-dlp for supported platform');
        try {
          inputPath = await downloadVideoWithYtdlp(videoUrl, '/tmp');
        } catch (ytdlpError) {
          // Extract error code and message
          const errorMsg = ytdlpError.message || ytdlpError.toString();
          const errorCode = errorMsg.split(':')[0];

          console.error('yt-dlp failed:', errorMsg);

          return res.status(400).json({
            error: errorMsg,
            errorCode: errorCode,
            errorDetail: errorMsg.split(':')[1]?.trim() || errorMsg
          });
        }
      } else {
        console.log('Using direct download');
        const videoId = uuidv4();
        inputPath = `/tmp/direct_${videoId}.video`;
        await downloadDirectVideo(videoUrl, inputPath);
      }
    } else {
      return res.status(400).json({
        error: 'No video file or URL provided',
        errorCode: 'NO_INPUT'
      });
    }

    const outputId = uuidv4();
    const outputPath = `/tmp/converted_${outputId}.mp3`;

    console.log('Starting conversion...');
    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(192)
      .format('mp3')
      .on('end', () => {
        console.log('Conversion completed');
        const stats = fs.statSync(outputPath);
        const audioData = fs.readFileSync(outputPath);
        const base64Audio = audioData.toString('base64');

        // Cleanup
        fs.unlinkSync(outputPath);
        if (shouldCleanupInput && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        const filename = req.file ? `${req.file.originalname.split('.')[0]}.mp3` : `audio_${outputId}.mp3`;

        // Return base64 audio data
        res.json({
          success: true,
          audioData: base64Audio,
          filename: filename,
          size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (shouldCleanupInput && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        res.status(500).json({
          error: 'Conversion failed: ' + err.message,
          errorCode: 'CONVERSION_FAILED'
        });
      })
      .save(outputPath);

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
  res.json({ status: 'healthy', ytdlpVersion: 'installed' });
});

app.listen(port, () => {
  console.log(`Video conversion service running on port ${port}`);
});
