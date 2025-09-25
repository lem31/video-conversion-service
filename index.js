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
  const outputTemplate = `${outputDir}/ytdlp_${videoId}.%%(ext)s`;
  await youtubedl(videoUrl, {
    output: outputTemplate,
    format: 'best[ext=mp4]/best',
    noPlaylist: true
  });
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith(`ytdlp_${videoId}.`));
  if (files.length === 0) throw new Error('Download failed');
  return `${outputDir}/${files[0]}`;
}

async function downloadDirectVideo(videoUrl, outputPath) {
  const response = await axios({
    method: 'GET', url: videoUrl, responseType: 'stream',
  });
  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
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
        inputPath = await downloadVideoWithYtdlp(videoUrl, '/tmp');
      } else {
        console.log('Using direct download');
        const videoId = uuidv4();
        inputPath = `/tmp/direct_${videoId}.video`;
        await downloadDirectVideo(videoUrl, inputPath);
      }
    } else {
      return res.status(400).json({ error: 'No video file or URL provided' });
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
        if (req.file) fs.unlinkSync(req.file.path);

        const filename = req.file ? `${req.file.originalname.split('.')[0]}.mp3` : `audio_${outputId}.mp3`;

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
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Conversion failed: ' + err.message });
      })
      .save(outputPath);

  } catch (error) {
    console.error('Error:', error);
    if (shouldCleanupInput && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.listen(port, () => {
  console.log(`Video conversion service running on port ${port}`);
});
