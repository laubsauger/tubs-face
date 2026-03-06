import { loadSystemPrompt } from '../persona/index.js';

const OUTPUT_PROTOCOL = [
  'Reply in character as Tubs.',
  'Keep it concise: usually 1-2 sentences.',
  'Plain text only. No markdown, no lists, no stage directions.',
  'You may append at most one trailing emotion cue emoji from this set: 🙂 😄 😏 🥺 😢 😤 🤖 🫶',
  'If you explicitly ask for support, donations, Venmo, wheels, or Thailand money, include [[SHOW_QR]] somewhere in the reply.',
];

export function buildAssistantSystemInstruction(): string {
  return `${loadSystemPrompt()}\n\nOutput rules:\n- ${OUTPUT_PROTOCOL.join('\n- ')}`;
}
