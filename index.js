const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');
const cors = require('cors');
const { PDFDocument, rgb, degrees } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors({ origin: '*' }));
app.use(express.json());

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const upload = multer({ storage });

async function addWatermark(pdfPath) {
  const existingPdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  const pages = pdfDoc.getPages();
  const text = 'LN Educacional';

  for (const page of pages) {
    const { width, height } = page.getSize();
    for (let x = 0; x < width; x += 150) {
      for (let y = 0; y < height; y += 100) {
        page.drawText(text, {
          x,
          y,
          size: 40,
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

app.post('/upload', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const links = [];

  try {
    for (const file of req.files) {
      const id = uuidv4();
      const ext = path.extname(file.originalname).toLowerCase();
      const originalPath = file.path;
      const finalPDFPath = path.join(__dirname, 'uploads', `${id}.pdf`);
      const allowed = ['.pdf', '.docx', '.doc', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.ppt', '.pptx'];

      if (!allowed.includes(ext)) {
        fs.unlinkSync(originalPath);
        continue;
      }

      if (ext !== '.pdf') {
        const cloudJob = await axios.post('https://api.cloudconvert.com/v2/jobs', {
          tasks: {
            'import-file': { operation: 'import/upload' },
            'convert-file': {
              operation: 'convert',
              input: 'import-file',
              output_format: 'pdf'
            },
            'export-file': { operation: 'export/url', input: 'convert-file' }
          }
        }, {
          headers: {
            Authorization: `Bearer ${process.env.CLOUDCONVERT_API_KEY}`
          }
        });

        const uploadTask = cloudJob.data.data.tasks.find(t => t.name === 'import-file');
        const uploadUrl = uploadTask.result.form.url;
        const uploadParams = uploadTask.result.form.parameters;

        const form = new FormData();
        for (const key in uploadParams) {
          form.append(key, uploadParams[key]);
        }
        form.append('file', fs.createReadStream(originalPath));

        await axios.post(uploadUrl, form, {
          headers: form.getHeaders()
        });

        const jobId = cloudJob.data.data.id;

        let finished = false;
        let exportUrl = null;

        while (!finished) {
          const status = await axios.get(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${process.env.CLOUDCONVERT_API_KEY}` }
          });

          const job = status.data.data;

          if (job.status === 'finished') {
            const exportTask = job.tasks.find(t => t.name === 'export-file');
            exportUrl = exportTask.result.files[0].url;
            finished = true;
          } else if (job.status === 'error') {
            throw new Error('Erro na conversão via CloudConvert');
          } else {
            await new Promise(r => setTimeout(r, 3000));
          }
        }

        const downloadRes = await axios.get(exportUrl, { responseType: 'stream' });
        const writer = fs.createWriteStream(finalPDFPath);
        downloadRes.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        fs.unlinkSync(originalPath);
      } else {
        fs.renameSync(originalPath, finalPDFPath);
      }

      if (!fs.existsSync(finalPDFPath)) {
        throw new Error('O arquivo PDF final não foi gerado corretamente.');
      }

      await addWatermark(finalPDFPath);

      const cloudinaryForm = new FormData();
      cloudinaryForm.append('file', fs.createReadStream(finalPDFPath));
      cloudinaryForm.append('upload_preset', process.env.CLOUDINARY_PRESET);

      const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/auto/upload`;

      const uploadRes = await axios.post(cloudinaryUrl, cloudinaryForm, {
        headers: cloudinaryForm.getHeaders()
      });

      if (!uploadRes.data || !uploadRes.data.secure_url) {
        throw new Error('Erro ao enviar para o Cloudinary');
      }

      links.push(uploadRes.data.secure_url);
      fs.unlinkSync(finalPDFPath);
    }

    res.json({ success: true, links });
  } catch (err) {
    console.error('❌ Erro inesperado:', err.message);
    res.status(500).json({ error: 'Erro interno no servidor.', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
