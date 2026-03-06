const DEMO_RESPONSES = [
  "Tubs is online and listening. What's next?",
  'That tracks. Give me one more detail.',
  'Interesting. Keep going.',
  'I heard you. What do you want me to do with that?',
  'Noted. Want the short answer or the weird answer?',
  'That sounds like momentum. Continue.',
  'Okay. I am awake and underfunded. Proceed.',
  'Registered. What is the next move?',
] as const;

export function generateDemoResponse(input: string): string {
  const seed = Math.abs(hashString(input)) % DEMO_RESPONSES.length;
  return DEMO_RESPONSES[seed] ?? DEMO_RESPONSES[0];
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}
