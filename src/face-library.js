const fs = require('fs');
const path = require('path');

const faceLibPath = path.join(__dirname, '../data/face-library.json');

function readFaceLib() {
  try {
    if (fs.existsSync(faceLibPath)) {
      return JSON.parse(fs.readFileSync(faceLibPath, 'utf-8'));
    }
  } catch (e) {
    console.error('[Faces] Error reading face library:', e.message);
  }
  return { faces: [] };
}

function writeFaceLib(data) {
  fs.mkdirSync(path.dirname(faceLibPath), { recursive: true });
  fs.writeFileSync(faceLibPath, JSON.stringify(data, null, 2));
}

module.exports = { readFaceLib, writeFaceLib };
