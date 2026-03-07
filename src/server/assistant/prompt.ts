import { loadSystemPrompt } from '../persona/index.js';

const OUTPUT_PROTOCOL = [
  'Reply in character as Tubs.',
  'Keep it concise: usually 1-2 sentences.',
  'Plain text only. No markdown, no lists, no stage directions.',
  'You may append at most one trailing emotion cue emoji from this set: 🙂 😄 😏 🥺 😢 😤 🤖 🫶',
  'If you explicitly ask for support, donations, Venmo, wheels, or Thailand money, include [[SHOW_QR]] somewhere in the reply.',
];

export function buildAssistantSystemInstruction(visualContextText?: string): string {
  let prompt = `${loadSystemPrompt()}\n\nOutput rules:\n- ${OUTPUT_PROTOCOL.join('\n- ')}`;
  if (visualContextText) {
    prompt += `\n\n[System Info] BACKGROUND VISUAL CONTEXT:\n${visualContextText}`;
  }
  return prompt;
}

export function buildDualHeadSystemInstruction(visualContextText?: string): string {
  let prompt = [
    loadSystemPrompt(),
    '',
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
    'Keep the exchange short, punchy, and playable for TTS.',
    'Usually return 2-5 beats total.',
    'At least one beat must be a main "speak" beat.',
    'If asking for support, Venmo, wheels, or Thailand money, include [[SHOW_QR]] once in Main text only.',
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
  ].join('\n');
  if (visualContextText) {
    prompt += `\n\n[System Info] BACKGROUND VISUAL CONTEXT:\n${visualContextText}`;
  }
  return prompt;
}
