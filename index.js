const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  dest: '/tmp/',
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.post('/convert-video-to-mp3', upload.single('video'), async (req, res) => {
  console.log('Conversion request received');
  let inputPath;

  try {
    if (req.file) {
      inputPath = req.file.path;
      console.log('File uploaded:', req.file.originalname);
    } else if (req.body.videoUrl) {
      console.log('URL provided:', req.body.videoUrl);
      return res.status(400).json({ error: 'URL support coming soon - use file upload for now' });
    } else {
      return res.status(400).json({ error: 'No video file provided' });
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
        if (req.file) fs.unlinkSync(req.file.path);

        res.json({
          success: true,
          audioData: base64Audio,
          filename: `${req.file.originalname.split('.')[0]}.mp3`,
          size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Conversion failed: ' + err.message });
      })
      .save(outputPath);

  } catch (error) {
    console.error('Error:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.listen(port, () => {
  console.log(`Video conversion service running on port ${port}`);
});
