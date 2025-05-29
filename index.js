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

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  console.log('Pasta uploads não existe. Criando...');
  fs.mkdirSync(uploadDir);
}

const upload = multer({ dest: uploadDir });

// Função para remover arquivos temporários com mais de 24h
function cleanOldFiles() {
  const files = fs.readdirSync(uploadDir);
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 horas

  files.forEach(file => {
    const filePath = path.join(uploadDir, file);
    fs.stat(filePath, (err, stats) => {
      if (err) return;
      if (now - stats.mtimeMs > maxAge) {
        fs.unlink(filePath, err => {
          if (!err) console.log(`Arquivo antigo removido: ${file}`);
        });
      }
    });
  });
}
// Roda limpeza a cada hora
setInterval(cleanOldFiles, 60 * 60 * 1000);

async function addWatermark(pdfPath) {
  const existingPdfBytes = fs.readFileSync(pdfPath);

  // Valida cabeçalho PDF
  const header = existingPdfBytes.slice(0, 5).toString();
  if (header !== '%PDF-') {
    throw new Error('Arquivo inválido: Cabeçalho PDF não encontrado.');
  }

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

const allowedExtensions = [
  '.pdf', '.doc', '.docx', '.odt',
  '.xls', '.xlsx', '.ods',
  '.ppt', '.pptx', '.odp',
  '.png', '.jpg', '.jpeg', '.bmp', '.gif',
  '.txt', '.rtf', '.html', '.csv', '.svg'
];

app.post('/upload', upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const processedFiles = [];

    for (const file of req.files) {
      const fileId = uuidv4();
      const fileExt = path.extname(file.originalname).toLowerCase();

      if (!allowedExtensions.includes(fileExt)) {
        fs.unlinkSync(file.path);
        return res.status(400).json({ error: `Formato não permitido: ${fileExt}` });
      }

      let finalFilePath = file.path;
      let exportUrl = null;

      if (fileExt !== '.pdf') {
        // Conversão CloudConvert
        const cloudJob = await axios.post('https://api.cloudconvert.com/v2/jobs', {
          tasks: {
            'import-my-file': { operation: 'import/upload' },
            'convert-my-file': {
              operation: 'convert',
              input: 'import-my-file',
              output_format: 'pdf'
            },
            'export-my-file': {
              operation: 'export/url',
              input: 'convert-my-file',
            }
          }
        }, {
          headers: {
            Authorization: `Bearer ${process.env.CLOUDCONVERT_API_KEY}`,
            'Content-Type': 'application/json',
          }
        });

        const uploadTask = cloudJob.data.data.tasks.find(t => t.name === 'import-my-file');
        const uploadUrl = uploadTask.result.form.url;
        const uploadParams = uploadTask.result.form.parameters;

        const uploadForm = new FormData();
        for (const key in uploadParams) {
          uploadForm.append(key, uploadParams[key]);
        }
        uploadForm.append('file', fs.createReadStream(file.path), file.originalname);

        await axios.post(uploadUrl, uploadForm, {
          headers: uploadForm.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });

        let finished = false;
        const jobId = cloudJob.data.data.id;

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
            const failedTask = job.tasks.find(t => t.status === 'error' || t.status === 'failed');
            throw new Error('Erro na conversão do arquivo');
          }

          if (!finished) await new Promise(r => setTimeout(r, 3000));
        }

        const downloadRes = await axios.get(exportUrl, { responseType: 'stream' });
        const outputPath = path.join(uploadDir, `${fileId}.pdf`);
        const writer = fs.createWriteStream(outputPath);

        downloadRes.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        finalFilePath = outputPath;
      } else {
        const outputPath = path.join(uploadDir, `${fileId}.pdf`);
        fs.renameSync(file.path, outputPath);
        finalFilePath = outputPath;
      }

      await addWatermark(finalFilePath);

      processedFiles.push({
        originalName: file.originalname,
        downloadLink: `https://landingpage-backend-z28u.onrender.com/file/${fileId}.pdf`
      });
    }

    return res.json({ success: true, files: processedFiles });

  } catch (err) {
    console.error('❌ Erro no upload/conversão:', err);
    return res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

app.use('/file', express.static(uploadDir));

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
