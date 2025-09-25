const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const fileType = require('file-type');
const libre = require('libreoffice-convert');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const mammoth = require('mammoth');
const xml2js = require('xml2js');
const { Parser } = require('json2csv');
const cors = require('cors');



const app = express();
const port = process.env.PORT || 8080;

app.use(bodyParser.json({ limit: '50mb' }));

app.use(cors());
app.post('/api/convert', async (req, res) => {
  const { file, fileName, mimeType, fromFormat, toFormat } = req.body;

  try {
    const buffer = Buffer.from(file, 'base64');
    const tempInput = path.join(__dirname, 'uploads', `${Date.now()}-${fileName}`);
    const tempOutput = path.join(__dirname, 'uploads', `${Date.now()}-converted.${toFormat}`);

    fs.writeFileSync(tempInput, buffer);

    let outputBuffer;


    if (['doc', 'docx', 'odt', 'pptx', 'xlsx', 'html', 'txt', 'epub'].includes(fromFormat)) {
      outputBuffer = await promisify(libre.convert)(buffer, toFormat, undefined);
    } else if (['jpg', 'png', 'heic'].includes(fromFormat)) {
      outputBuffer = await sharp(buffer)[toFormat]().toBuffer();
    } else if (['mp3', 'wav'].includes(fromFormat)) {
      outputBuffer = await convertAudio(tempInput, toFormat);
    } else if (['mp4', 'mov'].includes(fromFormat)) {
      outputBuffer = await convertVideo(tempInput, toFormat);
    } else if (fromFormat === 'json' && toFormat === 'csv') {
      const json = JSON.parse(buffer.toString());
      const parser = new Parser();
      outputBuffer = Buffer.from(parser.parse(json));
    } else if (fromFormat === 'xml' && toFormat === 'json') {
      const result = await xml2js.parseStringPromise(buffer.toString());
      outputBuffer = Buffer.from(JSON.stringify(result, null, 2));
    } else {
      throw new Error(`Conversion from ${fromFormat} to ${toFormat} not supported.`);
    }

    res.setHeader('Content-Type', mimeTypeFor(toFormat));
    res.send(outputBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).send('Conversion failed.');
  }
});


function convertAudio(inputPath, toFormat) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + `.${toFormat}`;
    ffmpeg(inputPath)
      .toFormat(toFormat)
      .on('end', () => resolve(fs.readFileSync(outputPath)))
      .on('error', reject)
      .save(outputPath);
  });
}


function convertVideo(inputPath, toFormat) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + `.${toFormat}`;
    ffmpeg(inputPath)
      .toFormat(toFormat)
      .on('end', () => resolve(fs.readFileSync(outputPath)))
      .on('error', reject)
      .save(outputPath);
  });
}


function mimeTypeFor(ext) {
  const map = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    jpg: 'image/jpeg',
    png: 'image/png',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    csv: 'text/csv',
    json: 'application/json',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

app.listen(port, () => {
  // console.log(`Conversion service running on port ${port}`);
});
