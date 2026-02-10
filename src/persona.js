const fs = require('fs');
const path = require('path');

const personaDir = path.join(__dirname, 'persona');
const systemPromptPath = path.join(personaDir, 'system-prompt.txt');
const greetingsPath = path.join(personaDir, 'greetings.json');

const DEFAULT_SYSTEM_PROMPT = 'You are Tubs Bot, a helpful and concise assistant.';
const DEFAULT_GREETINGS = {
  maxWords: 5,
  triggers: ['hi', 'hello', 'hey'],
  responses: ['Hey. Tubs online.'],
};
const WAKE_NAME_SUFFIXES = new Set(['tubs', 'tub', 'tubbs', 'tops', 'top']);

function readTextFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf8').trim();
    return content || fallback;
  } catch (err) {
    console.error(`[Persona] Failed to read ${filePath}:`, err.message);
    return fallback;
  }
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[Persona] Failed to parse ${filePath}:`, err.message);
    return fallback;
  }
}

function normalizeText(input) {
  return (input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadSystemPrompt() {
  return readTextFile(systemPromptPath, DEFAULT_SYSTEM_PROMPT);
}

function loadGreetingConfig() {
  const config = readJsonFile(greetingsPath, DEFAULT_GREETINGS);
  const triggers = Array.isArray(config.triggers)
    ? config.triggers.map(normalizeText).filter(Boolean)
    : DEFAULT_GREETINGS.triggers;
  const responses = Array.isArray(config.responses)
    ? config.responses.map((s) => String(s || '').trim()).filter(Boolean)
    : DEFAULT_GREETINGS.responses;

  return {
    maxWords: Number.isFinite(config.maxWords) ? Math.max(1, Math.floor(config.maxWords)) : DEFAULT_GREETINGS.maxWords,
    triggers: triggers.length ? triggers : DEFAULT_GREETINGS.triggers,
    responses: responses.length ? responses : DEFAULT_GREETINGS.responses,
  };
}

function pickGreetingResponse(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const greetingConfig = loadGreetingConfig();
  const words = normalized.split(' ').filter(Boolean);
  if (!words.length || words.length > greetingConfig.maxWords) return null;

  for (const trigger of greetingConfig.triggers) {
    if (normalized === trigger) {
      return greetingConfig.responses[Math.floor(Math.random() * greetingConfig.responses.length)];
    }
    if (normalized.startsWith(`${trigger} `)) {
      const suffix = normalized.slice(trigger.length).trim();
      if (WAKE_NAME_SUFFIXES.has(suffix)) {
        return greetingConfig.responses[Math.floor(Math.random() * greetingConfig.responses.length)];
      }
    }
  }

  return null;
}

module.exports = {
  loadSystemPrompt,
  loadGreetingConfig,
  pickGreetingResponse,
};
