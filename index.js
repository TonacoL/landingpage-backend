const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { PDFDocument, rgb, degrees } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const FormData = require('form-data');

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

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = 'documentos';

// Adiciona marca d'água no PDF
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

app.post('/upload', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const links = [];
  try {
    for (const file of req.files) {
      const id = uuidv4();
      const fileExt = path.extname(file.originalname).toLowerCase();
      const pdfName = `${id}.pdf`;
      const pdfPath = path.join(__dirname, 'uploads', pdfName);

      const allowed = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg'];
      if (!allowed.includes(fileExt)) {
        fs.unlinkSync(file.path);
        return res.status(400).json({ error: 'Formato de arquivo não suportado.' });
      }

      let finalPath = file.path;

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
        let exportUrl = null;
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

        const downloadRes = await axios.get(exportUrl, { responseType: 'stream' });
        const writer = fs.createWriteStream(pdfPath);
        downloadRes.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        finalPath = pdfPath;
      } else {
        fs.renameSync(file.path, pdfPath);
        finalPath = pdfPath;
      }

      await addWatermark(finalPath);

      const { data, error } = await supabase.storage.from(BUCKET).upload(pdfName, fs.readFileSync(finalPath), {
        contentType: 'application/pdf',
        upsert: true
      });

      if (error) {
        console.error('❌ Erro ao enviar para o Supabase:', error);
        return res.status(500).json({ error: 'Erro ao enviar para o Supabase', details: error.message || error });
      }

      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(pdfName);
      links.push(urlData.publicUrl);

      fs.unlinkSync(finalPath);
    }

    res.json({ success: true, links });
  } catch (err) {
    console.error('Erro inesperado no servidor:', err.message);
    res.status(500).json({ error: 'Erro interno no servidor.', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
