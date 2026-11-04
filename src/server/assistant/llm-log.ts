// Raw model input and output, written to the server log for debugging.

function formatDualHeadRawForLog(rawText: string): string {
  const normalized = String(rawText ?? '')
    .replace(/\r/g, '')
    .trim();
  if (!normalized) {
    return '[empty response]';
  }
  const limited = normalized.length > 2400
    ? `${normalized.slice(0, 2400)}\n...[truncated ${normalized.length - 2400} chars]`
    : normalized;
  return limited;
}

export function logAssistantUserInput(userText: string): void {
  const block = [
    '[LLM] User input begin',
    formatDualHeadRawForLog(userText),
    '[LLM] User input end',
  ].join('\n');
  process.stdout.write(`${block}\n`);
}

export function logRawModelOutput(channel: 'reply' | 'stream' | 'dual' | 'proactive' | 'dual-proactive', rawText: string): void {
  const block = [
    `[LLM:${channel}] Raw model output begin`,
    formatDualHeadRawForLog(rawText),
    `[LLM:${channel}] Raw model output end`,
  ].join('\n');
  process.stdout.write(`${block}\n`);
}

export function logDualHeadInvalidScript(rawText: string, reason: string): void {
  const block = [
    `[LLM:dual] ${reason}`,
    '[LLM:dual] Raw model output begin',
    formatDualHeadRawForLog(rawText),
    '[LLM:dual] Raw model output end',
  ].join('\n');
  process.stderr.write(`${block}\n`);
}
