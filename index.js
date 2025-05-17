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
app.use(express.json());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  console.log('Pasta uploads não existe. Criando...');
  fs.mkdirSync(uploadDir);
}

const upload = multer({ dest: uploadDir });

// Função para adicionar marca d'água
async function addWatermark(pdfPath) {
  const existingPdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);

  const pages = pdfDoc.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();
    const fontSize = 60;
    const text = 'LN Educacional';

    page.drawText(text, {
      x: width / 2 - fontSize * 2.5,
      y: height / 2,
      size: fontSize,
      color: rgb(0.75, 0.75, 0.75),
      rotate: degrees(-45),
      opacity: 0.15,
    });
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(pdfPath, pdfBytes);
}

app.post('/upload', upload.single('file'), async (req, res) => {
  console.log('Recebido arquivo para upload.');

  const file = req.file;
  if (!file) {
    console.log('Nenhum arquivo enviado.');
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const fileId = uuidv4();
  const fileExt = path.extname(file.originalname).toLowerCase();
  const allowed = ['.pdf', '.docx', '.xlsx'];

  if (!allowed.includes(fileExt)) {
    console.log(`Formato não permitido: ${fileExt}`);
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: 'Formato não permitido' });
  }

  let exportUrl = null;
  let finalFilePath = file.path;

  try {
    if (fileExt !== '.pdf') {
      console.log('Arquivo não é PDF, iniciando conversão via CloudConvert.');

      const cloudJob = await axios.post('https://api.cloudconvert.com/v2/jobs', {
        tasks: {
          'import-my-file': { operation: 'import/upload' },
          'convert-my-file': {
            operation: 'convert',
            input: 'import-my-file',
            output_format: 'pdf',
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
      uploadForm.append('file', fs.createReadStream(file.path));

      await axios.post(uploadUrl, uploadForm, {
        headers: uploadForm.getHeaders(),
      });

      let finished = false;
      const jobId = cloudJob.data.data.id;

      while (!finished) {
        console.log('Verificando status da conversão...');
        const statusRes = await axios.get(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${process.env.CLOUDCONVERT_API_KEY}` },
        });

        const job = statusRes.data.data;
        if (job.status === 'finished') {
          finished = true;
          const exportTask = job.tasks.find(t => t.name === 'export-my-file');
          exportUrl = exportTask.result.files[0].url;
          console.log('Conversão finalizada. URL do arquivo:', exportUrl);
        } else if (job.status === 'error' || job.status === 'failed') {
          throw new Error('Erro na conversão do arquivo');
        }

        if (!finished) await new Promise(r => setTimeout(r, 3000));
      }

      const downloadRes = await axios.get(exportUrl, { responseType: 'stream' });
      const outputPath = path.join(uploadDir, `${fileId}.pdf`);
      const writer = fs.createWriteStream(outputPath);

      downloadRes.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log('Arquivo convertido salvo em:', outputPath);
          resolve();
        });
        writer.on('error', err => {
          console.error('Erro ao salvar arquivo convertido:', err);
          reject(err);
        });
      });

      finalFilePath = outputPath;
    } else {
      console.log('Arquivo é PDF, não precisa converter.');
      const outputPath = path.join(uploadDir, `${fileId}.pdf`);
      fs.renameSync(file.path, outputPath);
      finalFilePath = outputPath;
    }

    // Adiciona a marca d'água antes de responder
    await addWatermark(finalFilePath);

    const link = `https://landingpage-backend-z28u.onrender.com/file/${fileId}.pdf`;
    console.log('Link gerado para download:', link);

    res.json({ success: true, link });

  } catch (err) {
    console.error('Erro no upload/conversão:', err);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

app.use('/file', express.static(uploadDir));

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
