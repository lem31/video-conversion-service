const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
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
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

// Check if URL is a YouTube/supported video platform
function isSupportedVideoUrl(url) {
  const supportedDomains = [
    'youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com',
    'twitch.tv', 'facebook.com', 'instagram.com', 'tiktok.com'
  ];
  try {
    const urlObj = new URL(url);
    return supportedDomains.some(domain => urlObj.hostname.includes(domain));
  } catch {
    return false;
  }
}

// Download video using yt-dlp for supported platforms
async function downloadVideoWithYtdlp(videoUrl, outputPath) {
  try {
    await youtubedl(videoUrl, {
      output: outputPath,
      format: 'best[ext=mp4]/best',
      noPlaylist: true
    });
  } catch (error) {
    throw new Error(`Failed to download video: ${error.message}`);
  }
}

// Download direct video URLs
async function downloadDirectVideo(videoUrl, outputPath) {
  const response = await axios({
    method: 'GET',
    url: videoUrl,
    responseType: 'stream',
    timeout: 60000,
  });
  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

app.post('/convert-video-to-mp3', upload.single('video'), async (req, res) => {
  let inputPath;
  let shouldCleanupInput = false;
  try {
    if (req.file) {
      inputPath = req.file.path;
    } else if (req.body.videoUrl) {
      const videoId = uuidv4();
      const isSupported = isSupportedVideoUrl(req.body.videoUrl);
      if (isSupported) {
        inputPath = `/tmp/ytdlp_${videoId}.%%(ext)s`;
        await downloadVideoWithYtdlp(req.body.videoUrl, inputPath);
        const files = fs.readdirSync('/tmp').filter(f => f.startsWith(`ytdlp_${videoId}.`));
        if (files.length === 0) throw new Error('Download failed');
        inputPath = `/tmp/${files[0]}`;
      } else {
        inputPath = `/tmp/direct_${videoId}.video`;
        await downloadDirectVideo(req.body.videoUrl, inputPath);
      }
      shouldCleanupInput = true;
    } else {
      return res.status(400).json({ error: 'No video file or URL provided' });
    }
    const outputPath = `/tmp/converted_${uuidv4()}.mp3`;
    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(192)
      .audioFrequency(44100)
      .format('mp3')
      .on('end', () => {
        res.download(outputPath, 'audio.mp3', (err) => {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          if (shouldCleanupInput && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
          if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (shouldCleanupInput && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Video conversion failed' });
      })
      .save(outputPath);
  } catch (error) {
    console.error('Error:', error);
    if (shouldCleanupInput && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (error.message.includes('download')) {
      res.status(400).json({ error: 'Could not download video from URL' });
    } else {
      res.status(500).json({ error: 'Server error during conversion' });
    }
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Video conversion service running on port ${port}`);
});
