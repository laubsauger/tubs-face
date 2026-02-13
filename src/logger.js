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

/**
 * Log a Tubs reply, attributing per-actor when beats are present (dual-head).
 * Falls back to plain "TUBS" for single-head replies.
 * @param {{ text: string, beats?: Array<{ actor: string, action: string, text: string }> | null, source?: string }} reply
 */
function logTubsReply(reply) {
  if (Array.isArray(reply.beats) && reply.beats.length > 0) {
    for (const beat of reply.beats) {
      if (beat.action !== 'speak' || !beat.text) continue;
      logConversation(`TUBS:${beat.actor}`, beat.text);
    }
    return;
  }
  logConversation('TUBS', reply.text);
}

module.exports = { logConversation, logTubsReply };
