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

// Criação da pasta de uploads se não existir
if (!fs.existsSync(UPLOAD_DIR)) {
  console.log('Pasta uploads não existe. Criando...');
  fs.mkdirSync(UPLOAD_DIR);
}

// Configuração do Multer
const upload = multer({ dest: UPLOAD_DIR });

// Função para aplicar marca d'água no PDF
async function addWatermark(pdfPath) {
  const existingPdfBytes = fs.readFileSync(pdfPath);

  if (!existingPdfBytes.slice(0, 5).toString().startsWith('%PDF-')) {
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

// Função para remover arquivos antigos
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

// Rota de upload de arquivos
app.post('/upload', upload.single('file'), async (req, res) => {
  console.log('Recebido arquivo para upload.');

  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  const fileId = uuidv4();
  const fileExt = path.extname(file.originalname).toLowerCase();
  const allowed = [
    '.pdf', '.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods',
    '.ppt', '.pptx', '.odp', '.png', '.jpg', '.jpeg', '.bmp',
    '.gif', '.txt', '.rtf', '.html', '.csv', '.svg'
  ];

  if (!allowed.includes(fileExt)) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: `Formato não permitido: ${fileExt}` });
  }

  let finalFilePath = file.path;
  let exportUrl = null;

  try {
    // Conversão se necessário
    if (fileExt !== '.pdf') {
      console.log('Arquivo não é PDF. Iniciando conversão via CloudConvert.');

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
      for (const key in uploadParams) uploadForm.append(key, uploadParams[key]);
      uploadForm.append('file', fs.createReadStream(file.path), file.originalname);

      await axios.post(uploadUrl, uploadForm, {
        headers: uploadForm.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      // Aguardar finalização da conversão
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

      // Baixar PDF convertido
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

    // Marca d'água
    await addWatermark(finalFilePath);

    // Geração do link
    const link = `https://landingpage-backend-z28u.onrender.com/file/${fileId}.pdf`;
    console.log('✅ Upload completo:', link);
    res.json({ success: true, link });

    // Limpeza de arquivos antigos
    removeOldFiles();

  } catch (err) {
    console.error('❌ Erro:', err.message);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// Rota para servir os arquivos
app.use('/file', express.static(UPLOAD_DIR));

// Inicialização do servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
