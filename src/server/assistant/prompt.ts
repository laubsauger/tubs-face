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
    'Return JSON only with a top-level "beats" array.',
    'Each beat must include actor and action, and may include text, emoji, delayMs.',
    'Allowed actors: "main", "small".',
    'Allowed actions: "speak", "react".',
    'If a beat has text, it must use action "speak".',
    'Action "react" is silent and should only carry emoji and/or timing, never dialogue text.',
    'Main is the lead voice. Small is a distinct second character, not a mirror.',
    'Let both heads have their own emotional beats when it fits.',
    'Keep the exchange short, punchy, and playable for TTS.',
    'If asking for support, Venmo, wheels, or Thailand money, include [[SHOW_QR]] once in Main text only.',
    'Do not use markdown. Do not add prose outside the JSON.',
    'Allowed emoji values: 🙂 😄 😏 🥺 😢 😤 🤖 🫶',
  ].join('\n');
  if (visualContextText) {
    prompt += `\n\n[System Info] BACKGROUND VISUAL CONTEXT:\n${visualContextText}`;
  }
  return prompt;
}
