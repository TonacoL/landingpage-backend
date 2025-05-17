const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Upload local
const upload = multer({ dest: 'uploads/' });

// JSON
app.use(express.json());

// Rota para upload
app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  const fileId = uuidv4();
  const fileExt = path.extname(file.originalname).toLowerCase();

  const allowed = ['.pdf', '.docx', '.xlsx'];
  if (!allowed.includes(fileExt)) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: 'Formato não permitido' });
  }

  try {
    // Se for PDF, só armazenar e retornar link direto
    let finalFilePath = file.path;

    if (fileExt !== '.pdf') {
      // CONVERTER para PDF com CloudConvert
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

      // Enviar arquivo para CloudConvert
      const uploadForm = new FormData();
      for (const key in uploadParams) {
        uploadForm.append(key, uploadParams[key]);
      }
      uploadForm.append('file', fs.createReadStream(file.path));

      await axios.post(uploadUrl, uploadForm, {
        headers: uploadForm.getHeaders(),
      });

      // Esperar conversão
      let finished = false;
      let exportUrl = null;
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
        }
        await new Promise(r => setTimeout(r, 3000));
      }

      // Baixar arquivo convertido
      const downloadRes = await axios.get(exportUrl, { responseType: 'stream' });
      const outputPath = `uploads/${fileId}.pdf`;
      const writer = fs.createWriteStream(outputPath);
      downloadRes.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      finalFilePath = outputPath;
    }

    // Retornar link de acesso
    const link = `${process.env.BASE_URL}/file/${fileId}.pdf`;
    res.json({ success: true, link });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  } finally {
    fs.unlinkSync(file.path); // remover temporário original
  }
});

// Servir arquivos
app.use('/file', express.static(path.join(__dirname, 'uploads')));

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
