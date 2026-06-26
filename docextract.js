// docextract.js - extract text from born-digital PDF and DOCX files.
// Phase 1: no OCR. Born-digital only - text is already in the file.
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

// Detect file type from the original filename extension.
function detectFileType(filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  return 'unsupported';
}

// Extract text from a file buffer. Returns { text, type, ok, error }.
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