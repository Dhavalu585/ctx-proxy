
// docextract.js - extract text from born-digital PDF and DOCX files.
// Phase 1: no OCR. Born-digital only - text is already in the file.
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

function detectFileType(filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  return 'unsupported';
}

async function extractText(buffer, filename) {
  const type = detectFileType(filename);
  try {
    if (type === 'pdf') {
      const parser = new PDFParse(new Uint8Array(buffer));
      const data = await parser.getText();
      return { text: data.text || '', type, ok: true };
    }
    if (type === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value || '', type, ok: true };
    }
    return { text: '', type, ok: false, error: 'Unsupported file type (only PDF and DOCX in Phase 1)' };
  } catch (err) {
    return { text: '', type, ok: false, error: err.message };
  }
}

// Split text into ~chunkChars-sized chunks at paragraph boundaries, with slight
// overlap so answers spanning a boundary stay findable. Small docs return as 1 chunk.
// chunkChars ~4000 ≈ 1000 tokens; overlapChars ~320 ≈ 80 tokens.
function chunkText(text, chunkChars = 4000, overlapChars = 320) {
  const clean = (text || '').trim();
  if (clean.length <= chunkChars) return [clean];   // small doc: one chunk

  // Split into paragraphs, then greedily pack into chunks.
  const paras = clean.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const para of paras) {
    if (current.length + para.length + 2 > chunkChars && current.length > 0) {
      chunks.push(current.trim());
      // start next chunk with a tail of the previous one (overlap)
      const tail = current.slice(-overlapChars);
      current = tail + '\n\n' + para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Safety: if a single paragraph was huge (> chunkChars), hard-split those.
  const final = [];
  for (const c of chunks) {
    if (c.length <= chunkChars * 1.5) { final.push(c); continue; }
    for (let i = 0; i < c.length; i += (chunkChars - overlapChars)) {
      final.push(c.slice(i, i + chunkChars));
    }
  }
  return final;
}

module.exports = { detectFileType, extractText, chunkText };
