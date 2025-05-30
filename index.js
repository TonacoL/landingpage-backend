const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { PDFDocument, rgb, degrees } = require('pdf-lib');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const FILE_EXPIRATION_HOURS = 6;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/file', express.static(UPLOAD_DIR));

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});

const upload = multer({ storage });

async function addWatermark(pdfPath) {
  const existingPdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  const pages = pdfDoc.getPages();
  const text = 'LN Educacional';
  const fontSize = 40;
  const spacingX = 150;
  const spacingY = 100;

  for (const page of pages) {
    const { width, height } = page.getSize();
    for (let x = 0; x < width; x += spacingX) {
      for (let y = 0; y < height; y += spacingY) {
        page.drawText(text, {
          x,
          y,
          size: fontSize,
          color: rgb(0.6, 0.6, 0.6),
          rotate: degrees(-45),
          opacity: 0.35,
        });
      }
    }
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(pdfPath, pdfBytes);
}

function removeOldFiles() {
  const now = Date.now();
  const maxAge = FILE_EXPIRATION_HOURS * 60 * 60 * 1000;

  fs.readdirSync(UPLOAD_DIR).forEach(file => {
    const filePath = path.join(UPLOAD_DIR, file);
    const stats = fs.statSync(filePath);
    if ((now - stats.mtimeMs) > maxAge) {
      fs.unlinkSync(filePath);
      console.log(`🧹 Arquivo removido: ${file}`);
    }
  });
}

app.post('/upload', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const links = [];

  try {
    for (const file of req.files) {
      const fileId = uuidv4();
      const fileExt = path.extname(file.originalname).toLowerCase();
      const allowed = ['.pdf', '.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp', '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.txt', '.rtf', '.html', '.csv', '.svg'];

      if (!allowed.includes(fileExt)) {
        fs.unlinkSync(file.path);
        continue;
      }

      let finalFilePath = file.path;
      let exportUrl = null;

      if (fileExt !== '.pdf') {
        const cloudJob = await axios.post('https://api.cloudconvert.com/v2/jobs', {
          tasks: {
            'import-my-file': { operation: 'import/upload' },
            'convert-my-file': {
              operation: 'convert',
              input: 'import-my-file',
              output_format: 'pdf'
            },
            'export-my-file': { operation: 'export/url', input: 'convert-my-file' }
          }
        }, {
          headers: {
            Authorization: `Bearer ${process.env.CLOUDCONVERT_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        const uploadTask = cloudJob.data.data.tasks.find(t => t.name === 'import-my-file');
        const uploadUrl = uploadTask.result.form.url;
        const uploadParams = uploadTask.result.form.parameters;

        const uploadForm = new FormData();
        for (const key in uploadParams) uploadForm.append(key, uploadParams[key]);
        uploadForm.append('file', fs.createReadStream(file.path), file.originalname);

        await axios.post(uploadUrl, uploadForm, {
          headers: uploadForm.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });

        const jobId = cloudJob.data.data.id;
        let finished = false;
        while (!finished) {
          const statusRes = await axios.get(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${process.env.CLOUDCONVERT_API_KEY}` },
          });

          const job = statusRes.data.data;
          if (job.status === 'finished') {
            finished = true;
            const exportTask = job.tasks.find(t => t.name === 'export-my-file');
            exportUrl = exportTask.result.files[0].url;
          } else if (job.status === 'error' || job.status === 'failed') {
            throw new Error('Erro na conversão do arquivo');
          }

          if (!finished) await new Promise(r => setTimeout(r, 3000));
        }

        const outputPath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
        const downloadRes = await axios.get(exportUrl, { responseType: 'stream' });
        const writer = fs.createWriteStream(outputPath);
        downloadRes.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        finalFilePath = outputPath;
      } else {
        const outputPath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
        fs.renameSync(file.path, outputPath);
        finalFilePath = outputPath;
      }

      await addWatermark(finalFilePath);

      const link = `${process.env.BASE_URL}/file/${path.basename(finalFilePath)}`;
      links.push(link);
    }

    removeOldFiles();
    res.json({ success: true, links });
  } catch (err) {
    console.error('❌ Erro:', err.message);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
