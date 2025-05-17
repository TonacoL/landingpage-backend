// Importar módulos
const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const cors = require('cors');  // <<< Importar cors

// Configurar dotenv para carregar variáveis do .env
dotenv.config();

// Criar app Express
const app = express();
const PORT = process.env.PORT || 3001;

// Usar cors para liberar requisições externas
app.use(cors());  // <<< Middleware cors ativado

// Configurar multer para upload local temporário
const upload = multer({ dest: 'uploads/' });

// Middleware para JSON
app.use(express.json());

// Rota POST /upload para receber e processar o arquivo
app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  const fileId = uuidv4();
  const fileExt = path.extname(file.originalname).toLowerCase();

  // Permitir apenas alguns formatos
  const allowed = ['.pdf', '.docx', '.xlsx'];
  if (!allowed.includes(fileExt)) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: 'Formato não permitido' });
  }

  try {
    let finalFilePath = file.path;

    if (fileExt !== '.pdf') {
      // Criar job no CloudConvert para conversão para PDF
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

      // Pegar URL e params para upload
      const uploadTask = cloudJob.data.data.tasks.find(t => t.name === 'import-my-file');
      const uploadUrl = uploadTask.result.form.url;
      const uploadParams = uploadTask.result.form.parameters;

      // Preparar form-data para enviar arquivo
      const uploadForm = new FormData();
      for (const key in uploadParams) {
        uploadForm.append(key, uploadParams[key]);
      }
      uploadForm.append('file', fs.createReadStream(file.path));

      // Fazer upload para CloudConvert
      await axios.post(uploadUrl, uploadForm, {
        headers: uploadForm.getHeaders(),
      });

      // Aguardar finalização do job
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
        else if (job.status === 'error' || job.status === 'failed') {
          throw new Error('Erro na conversão do arquivo');
        }

        if (!finished) await new Promise(r => setTimeout(r, 3000));
      }

      // Baixar arquivo convertido para pasta uploads
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

    // Responder com link público do arquivo
    // Use seu domínio backend real aqui
    const link = `https://landingpage-backend-z28u.onrender.com/file/${fileId}.pdf`;
    res.json({ success: true, link });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  } finally {
    // Apagar arquivo temporário enviado
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
});

// Servir arquivos estáticos da pasta uploads
app.use('/file', express.static(path.join(__dirname, 'uploads')));

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
