const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { PDFDocument, rgb, degrees } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
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
      const pdfName = `${id}.pdf`;
      const pdfPath = path.join(__dirname, 'uploads', pdfName);

      // Adiciona marca d'água no PDF
      await addWatermark(file.path);
      fs.renameSync(file.path, pdfPath);

      // Upload para Supabase
      const { data, error } = await supabase.storage.from(BUCKET).upload(pdfName, fs.readFileSync(pdfPath), {
        contentType: 'application/pdf',
        upsert: true
      });

      if (error) {
        console.error('❌ Erro ao enviar para o Supabase:', error);
        return res.status(500).json({ error: 'Erro ao enviar para o Supabase', details: error.message || error });
      }

      // Gera URL pública
      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(pdfName);
      links.push(urlData.publicUrl);

      fs.unlinkSync(pdfPath); // Remove localmente
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
