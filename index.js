 const express = require('express');
  const cors = require('cors');
  const multer = require('multer');
  const ffmpeg = require('fluent-ffmpeg');
  const path = require('path');
  const fs = require('fs');

  const app = express();
  const upload = multer({ dest: 'uploads/' });

  app.use(cors());

  app.get('/', (req, res) => {
    res.json({ message: 'Video conversion service is running!' });
  });

  app.post('/convert-video-to-mp3', upload.single('video'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const inputPath = req.file.path;
    const outputPath = inputPath + '.mp3';

    ffmpeg(inputPath)
      .toFormat('mp3')
      .on('end', () => {
        const mp3Buffer = fs.readFileSync(outputPath);
        const base64Audio = mp3Buffer.toString('base64');
        const downloadUrl = 'data:audio/mpeg;base64,' + base64Audio;

        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);

        res.json({
          downloadUrl,
          filename: path.parse(req.file.originalname).name + '.mp3'
        });
      })
      .on('error', (err) => {
        console.error(err);
        fs.unlinkSync(inputPath);
        res.status(500).json({ error: 'Conversion failed' });
      })
      .save(outputPath);
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log('Video conversion service running on port ' + port);
  });