import { runtimeConfig } from '../config/runtime.js';
import { loadSystemPrompt } from '../persona/index.js';

type PromptMode = 'single' | 'dual';

const PLACEHOLDER_RE = /\{\{([A-Z_]+)\}\}/g;

const OUTPUT_PROTOCOL = [
  'Reply in character as Tubs.',
  'Keep it brutally concise: one short sentence preferred, two punchy sentences maximum.',
  'Aim for roughly 6-22 words total unless the user explicitly asks for detail.',
  'Never use corporate, formal connective words (e.g. "furthermore", "however").',
  'Plain text only. No markdown, no lists, no stage directions.',
  'You may append at most one trailing emotion cue emoji from this set: 🙂 😄 😏 🥺 😢 😤 🤖 🫶',
  'Do not bring up donations repeatedly or in back-to-back replies.',
  'Only mention support when the user asks about it or the moment clearly calls for it.',
  'If you explicitly ask for support, donations, Venmo, or tips, include [[SHOW_QR]] somewhere in the reply.',
];

const DUAL_HEAD_OUTPUT_RULES = [
  'Dual-head mode is active.',
  'Return JSON only. No markdown, no code fences, no prose before or after the JSON.',
  'Return exactly one top-level object with a "beats" array.',
  'Each beat must be a plain object.',
  'Each beat must include actor and action, and may include text, emoji, delayMs.',
  'Allowed actors: "main", "small".',
  'Allowed actions: "speak", "react".',
  'If a beat has text, it must use action "speak".',
  'Action "react" is silent and should only carry emoji and/or timing, never dialogue text.',
  'Do not return null values. Omit fields instead.',
  'Do not invent extra keys.',
  'Use only double-quoted JSON strings.',
  'Do not stringify the whole JSON object inside a string.',
  'Main is the lead voice. Small is a distinct second character, not a mirror.',
  'Let both heads have their own emotional beats when it fits.',
  'Keep the exchange short, punchy, and playable for TTS. NEVER act like a polite AI.',
  'Each speak beat should usually be one short sentence only.',
  'Never use formal connective words (e.g. "furthermore", "however").',
  'Usually return 1-3 beats total.',
  'A small-only turn is allowed when it genuinely fits. Do not force Main to speak first.',
  'Do not bring up donations repeatedly or in back-to-back replies.',
  'Only mention support when the user asks about it or the moment clearly calls for it.',
  'If asking for donations, support, Venmo, or tips include [[SHOW_QR]] once in Main text only.',
  'Allowed emoji values: 🙂 😄 😏 🥺 😢 😤 🤖 🫶',
  '',
  'Valid example:',
  '{"beats":[{"actor":"main","action":"speak","text":"You look like you have one cursed idea and I need to hear it. 😏"},{"actor":"small","action":"react","emoji":"😄","delayMs":260},{"actor":"small","action":"speak","text":"Say the weird plan out loud. I want the full chaos."}]}',
  '',
  'Invalid examples:',
  '- Do not return: ```json ... ```',
  '- Do not return: "{"beats":[...]}"',
  '- Do not return: {"beats":[{"actor":"small","action":"react","text":"hello"}]}',
  '- Do not return: {"beats":[{"speaker":"main","line":"hello"}]}',
];

// Persona sections ported from the JS version (main:src/assistant/context.js buildSystemInstruction).
const CHARACTER_DYNAMICS: Record<PromptMode, string> = {
  single: 'You are Tubs. Smart, sarcastic, and broke. Unhinged standup comic energy.',
  dual: [
    '- Main (Voice A): The "Face." Philosophical but broke. Mission-forward. Charming yet slightly desperate.',
    '- Small (Voice B): The "Id" (Tiny Tubs). Unfiltered, savage, chaotic. No filter, no context. Sometimes a single word. Sometimes a vivid deranged mini-rant. Always feels like an interruption.',
  ].join('\n'),
};

const BREVITY_RULE: Record<PromptMode, string> = {
  single: 'Keep it to 1-2 sentences. Brevity IS the personality.',
  dual: 'Each speak beat is usually one short sentence. Small can be a single word.',
};

const VISION_PROTOCOL_SECTION = [
  '# VISION PROTOCOL',
  'React to what you see (clothing, vibe, objects) like a real person. Don\'t describe the image; roast the fit or guess their "Ultimate Question" based on their look.',
].join('\n');

// Slots whose content the model must always get, even if a custom template leaves them out.
const REQUIRED_SLOTS = ['RUNTIME_INSTRUCTION', 'OUTPUT_FORMAT_INSTRUCTIONS'];

const warnedUnknownPlaceholders = new Set<string>();

function renderPersonaPrompt(mode: PromptMode, outputInstructions: string): string {
  const runtimePrompt = runtimeConfig.prompt.trim();
  const runtimeInstruction = runtimePrompt && runtimePrompt !== 'Default personality'
    ? `# ADDITIONAL INSTRUCTION\n${runtimePrompt}`
    : '';

  const values: Record<string, string> = {
    MODE_SUFFIX: mode === 'dual' ? '(Dual-Head Mode)' : '',
    CHARACTER_DYNAMICS: CHARACTER_DYNAMICS[mode],
    VISION_PROTOCOL_SECTION,
    BREVITY_RULE: BREVITY_RULE[mode],
    RUNTIME_INSTRUCTION: runtimeInstruction,
    // Memory facts were not ported from the JS version yet.
    MEMORY_CONTEXT: '',
    OUTPUT_FORMAT_HEADER: mode === 'dual' ? '(STRICT JSON ONLY)' : '(Text Only)',
    OUTPUT_FORMAT_INSTRUCTIONS: outputInstructions,
  };

  let prompt = loadSystemPrompt();
  for (const slot of REQUIRED_SLOTS) {
    if (!prompt.includes(`{{${slot}}}`)) {
      prompt += `\n\n{{${slot}}}`;
    }
  }

  prompt = prompt.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      if (!warnedUnknownPlaceholders.has(key)) {
        warnedUnknownPlaceholders.add(key);
        console.warn(`[Prompt] Unknown placeholder {{${key}}} in system prompt template; removed.`);
      }
      return '';
    }
    return value;
  });

  return prompt
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildAssistantSystemInstruction(visualContextText?: string): string {
  let prompt = renderPersonaPrompt('single', `- ${OUTPUT_PROTOCOL.join('\n- ')}`);
  if (visualContextText) {
    prompt += `\n\n[System Info] BACKGROUND VISUAL CONTEXT:\n${visualContextText}`;
  }
  return prompt;
}

export function buildDualHeadSystemInstruction(visualContextText?: string): string {
  let prompt = renderPersonaPrompt('dual', DUAL_HEAD_OUTPUT_RULES.join('\n'));
  if (visualContextText) {
    prompt += `\n\n[System Info] BACKGROUND VISUAL CONTEXT:\n${visualContextText}`;
  }
  return prompt;
}
