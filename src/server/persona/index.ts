import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GreetingsConfig, GreetingSet } from '../../shared/contracts/faces.js';
import { runtimeConfig } from '../config/runtime.js';

const personaDir = resolve(process.cwd(), 'src/persona');
const systemPromptPath = resolve(personaDir, 'system-prompt.md');
const greetingsPath = resolve(personaDir, 'greetings.json');

const DEFAULT_SYSTEM_PROMPT = 'You are Tubs Bot, a helpful and concise assistant.';
const EMPTY_GREETING_SET: GreetingSet = {
  unnamed: [],
  named: [],
};
const DEFAULT_GREETINGS: GreetingsConfig = {
  maxWords: 5,
  triggers: ['hi', 'hello', 'hey'],
  responses: ['Hey. Tubs online. What are we doing?'],
  wake: EMPTY_GREETING_SET,
  join: EMPTY_GREETING_SET,
  departure: EMPTY_GREETING_SET,
};
const WAKE_NAME_SUFFIXES = new Set(['tubs', 'tub', 'tubbs', 'tops', 'top']);

export function loadSystemPrompt(): string {
  const filePrompt = readTextFile(systemPromptPath, DEFAULT_SYSTEM_PROMPT);
  const runtimePrompt = runtimeConfig.prompt.trim();
  if (!runtimePrompt || runtimePrompt === 'Default personality') {
    return filePrompt;
  }
  return `${filePrompt}\n\nRuntime override:\n${runtimePrompt}`;
}

export function loadGreetingConfig(): GreetingsConfig {
  const config = readJsonFile(greetingsPath, DEFAULT_GREETINGS);
  const triggers = normalizeStringList(config.triggers);
  const responses = trimStringList(config.responses);

  return {
    maxWords: Number.isFinite(config.maxWords) ? Math.max(1, Math.floor(config.maxWords)) : DEFAULT_GREETINGS.maxWords,
    triggers: triggers.length ? triggers : DEFAULT_GREETINGS.triggers,
    responses: responses.length ? responses : DEFAULT_GREETINGS.responses,
    wake: normalizeGreetingSet(config.wake),
    join: normalizeGreetingSet(config.join),
    departure: normalizeGreetingSet(config.departure),
  };
}

export function pickGreetingResponse(text: string): string | null {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  const greetingConfig = loadGreetingConfig();
  const words = normalized.split(' ').filter(Boolean);
  if (!words.length || words.length > greetingConfig.maxWords) {
    return null;
  }

  for (const trigger of greetingConfig.triggers) {
    if (normalized === trigger) {
      return pickGreetingLine(greetingConfig.responses);
    }
    if (normalized.startsWith(`${trigger} `)) {
      const suffix = normalized.slice(trigger.length).trim();
      if (WAKE_NAME_SUFFIXES.has(suffix)) {
        return pickGreetingLine(greetingConfig.responses);
      }
    }
  }

  return null;
}

function normalizeGreetingSet(value: unknown): GreetingSet {
  if (!value || typeof value !== 'object') {
    return EMPTY_GREETING_SET;
  }

  const raw = value as Partial<GreetingSet>;
  return {
    unnamed: trimStringList(raw.unnamed),
    named: trimStringList(raw.named),
  };
}

function readTextFile(filePath: string, fallback: string): string {
  try {
    const content = readFileSync(filePath, 'utf8').trim();
    return content || fallback;
  } catch (error) {
    logReadError(filePath, error);
    return fallback;
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    logReadError(filePath, error);
    return fallback;
  }
}

function logReadError(filePath: string, error: unknown): void {
  if (error instanceof Error) {
    console.error(`[persona] failed to read ${filePath}: ${error.message}`);
  }
}

function normalizeText(input: string): string {
  return String(input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((value) => normalizeText(String(value))).filter(Boolean);
}

function trimStringList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((value) => String(value).trim()).filter(Boolean);
}

function pickGreetingLine(responses: string[]): string | null {
  if (!responses.length) {
    return null;
  }

  const questionLines = responses.filter((line) => /[?]\s*$/.test(line));
  if (questionLines.length && Math.random() < 0.78) {
    return randomItem(questionLines);
  }
  return randomItem(responses);
}

function randomItem<T>(items: T[]): T | null {
  if (!items.length) {
    return null;
  }
  const index = Math.floor(Math.random() * items.length);
  return items[index] ?? null;
}
