const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { DatabaseSync } = require('node:sqlite');

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './verif.db';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

// ========== BASE DE DONNÉES ==========
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS verifications (
    code         TEXT PRIMARY KEY,
    discord_id   TEXT NOT NULL,
    valide       INTEGER DEFAULT 0,
    photo_path   TEXT,
    a_moderer    INTEGER DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ========== UPLOAD ==========
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Seules les images sont autorisées'));
  },
});

// ========== LYCEES ACCEPTES ==========
const LYCEES = [
  { nom: 'Léon Chiris',  variantes: ['leon chiris', 'leonchiris', 'chiris'] },
  { nom: 'Amiral de Grasse', variantes: ['amiral de grasse', 'amiral grasse', 'grasse'] },
  { nom: 'Decroisset',   variantes: ['decroisset', 'de croisset', 'croisset'] },
];

// Normalise le texte (minuscules, sans accents, sans ponctuation)
function normaliser(texte) {
  return texte
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cherche un lycée dans le texte OCR
function trouverLycee(texteOCR) {
  const texte = normaliser(texteOCR);
  for (const lycee of LYCEES) {
    for (const variante of lycee.variantes) {
      if (texte.includes(normaliser(variante))) {
        return lycee.nom;
      }
    }
  }
  return null;
}

// ========== APP ==========
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Route 1 : vérifier le code ---
app.post('/api/verifier-code', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ erreur: 'Aucun code fourni' });

  const ligne = db.prepare(
    'SELECT * FROM verifications WHERE code = ? AND valide = 0'
  ).get(code.toUpperCase().trim());

  if (!ligne) {
    return res.status(400).json({
      erreur: 'Code invalide ou déjà utilisé. Vérifie ton MP Discord.',
    });
  }

  res.json({ succes: true });
});

// --- Route 2 : upload photo + OCR ---
app.post('/api/verifier-photo', upload.single('photo'), async (req, res) => {
  const { code } = req.body;

  if (!code) return res.status(400).json({ erreur: 'Aucun code fourni' });
  if (!req.file) return res.status(400).json({ erreur: 'Aucune photo reçue' });

  const ligne = db.prepare(
    'SELECT * FROM verifications WHERE code = ? AND valide = 0'
  ).get(code.toUpperCase().trim());

  if (!ligne) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(400).json({ erreur: 'Code invalide ou déjà utilisé.' });
  }

  let imageTraitee = null;

  try {
    // Prétraitement pour améliorer l'OCR
    imageTraitee = path.join(UPLOAD_DIR, `traite-${req.file.filename}.png`);
    await sharp(req.file.path)
      .resize({ width: 1600, withoutEnlargement: true })
      .grayscale()
      .normalize()
      .sharpen()
      .toFile(imageTraitee);

    // OCR français
    const { data: { text } } = await Tesseract.recognize(imageTraitee, 'fra');
    console.log(`📄 OCR (code ${code}) :`, text.slice(0, 200).replace(/\n/g, ' '));

    const lyceeTrouve = trouverLycee(text);

    if (lyceeTrouve) {
      // ✅ Validation automatique
      db.prepare(
        'UPDATE verifications SET valide = 1 WHERE code = ?'
      ).run(code.toUpperCase().trim());

      try { fs.unlinkSync(req.file.path); } catch (e) {}
      if (imageTraitee) try { fs.unlinkSync(imageTraitee); } catch (e) {}

      console.log(`✅ Lycée reconnu : ${lyceeTrouve}`);
      return res.json({
        succes: true,
        message: `✅ Carnet reconnu (${lyceeTrouve}). Tu seras vérifié dans quelques secondes.`,
      });
    }

    // ❌ Envoi en modération manuelle
    db.prepare(
      'UPDATE verifications SET photo_path = ?, a_moderer = 1 WHERE code = ?'
    ).run(req.file.path, code.toUpperCase().trim());

    if (imageTraitee) try { fs.unlinkSync(imageTraitee); } catch (e) {}

    console.log(`⚠️ Aucun lycée reconnu — envoi en modération pour ${code}`);
    return res.json({
      succes: true,
      moderation: true,
      message:
        '📸 Photo reçue. Un modérateur va vérifier ton carnet manuellement ' +
        '(généralement sous quelques heures).',
    });
  } catch (err) {
    console.error('❌ Erreur OCR :', err);
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    if (imageTraitee) try { fs.unlinkSync(imageTraitee); } catch (e) {}
    return res.status(500).json({ erreur: 'Erreur lors du traitement de la photo.' });
  }
});

// --- Route santé (utile pour Railway) ---
app.get('/health', (req, res) => res.json({ ok: true }));

// ========== DEMARRAGE ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Site en ligne sur le port ${PORT}`);
});