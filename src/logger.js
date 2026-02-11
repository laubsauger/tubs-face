const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logsDir, { recursive: true });

let currentDate = null;
let stream = null;

function getDateStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function ensureStream() {
  const today = getDateStr();
  if (today !== currentDate) {
    if (stream) stream.end();
    currentDate = today;
    const filePath = path.join(logsDir, `${today}.log`);
    stream = fs.createWriteStream(filePath, { flags: 'a' });
  }
  return stream;
}

function logConversation(speaker, text) {
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${speaker}: ${text}\n`;
  ensureStream().write(line);
}

module.exports = { logConversation };
