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

async function addWatermark(pdfPath) {
  const existingPdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);

  const pages = pdfDoc.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();
