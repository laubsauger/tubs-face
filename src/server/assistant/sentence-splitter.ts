const SENTENCE_END_RE = /[.!?](?=\s|$)/;
const CLAUSE_END_RE = /[,;:](?=\s)/g;
const SOFT_SPLIT_MIN_CHARS = 56;
const HARD_SPLIT_MAX_CHARS = 120;

export interface SentenceSplitter {
  push(delta: string): void;
  flush(): void;
}

export function createSentenceSplitter(onSentence: (sentence: string) => void): SentenceSplitter {
  let buffer = '';

  function skipDelimiterRemainder(index: number): number {
    let cursor = index;
    while (cursor < buffer.length && /\s/.test(buffer[cursor] ?? '')) cursor += 1;
    return cursor;
  }

  function emitNextChunk(): boolean {
    if (!buffer) return false;

    const sentenceMatch = SENTENCE_END_RE.exec(buffer);
    if (sentenceMatch) {
      const endIdx = sentenceMatch.index + sentenceMatch[0].length;
      const sentence = buffer.slice(0, endIdx).trim();
      buffer = buffer.slice(skipDelimiterRemainder(endIdx));
      if (sentence) onSentence(sentence);
      return true;
    }

    if (buffer.length >= SOFT_SPLIT_MIN_CHARS) {
      let clauseMatch: RegExpExecArray | null = null;
      const re = new RegExp(CLAUSE_END_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(buffer)) !== null) {
        clauseMatch = m;
      }
      if (clauseMatch) {
        const endIdx = clauseMatch.index + clauseMatch[0].length;
        const sentence = buffer.slice(0, endIdx).trim();
        buffer = buffer.slice(skipDelimiterRemainder(endIdx));
        if (sentence) onSentence(sentence);
        return true;
      }
    }

    if (buffer.length >= HARD_SPLIT_MAX_CHARS) {
      const splitAtSpace = buffer.lastIndexOf(' ', HARD_SPLIT_MAX_CHARS);
      const endIdx = splitAtSpace > 28 ? splitAtSpace : HARD_SPLIT_MAX_CHARS;
      const sentence = buffer.slice(0, endIdx).trim();
      buffer = buffer.slice(skipDelimiterRemainder(endIdx));
      if (sentence) onSentence(sentence);
      return true;
    }

    return false;
  }

  return {
    push(delta: string): void {
      buffer += delta;
      while (emitNextChunk()) { /* drain */ }
    },
    flush(): void {
      const remaining = buffer.trim();
      buffer = '';
      if (remaining) onSentence(remaining);
    },
  };
}
