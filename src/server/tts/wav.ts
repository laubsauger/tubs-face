/**
 * Joins base64 PCM WAV chunks of one clip (same format, as the TTS service
 * sends them) into one base64 WAV. A single chunk comes back unchanged.
 */
export function joinWavChunks(chunks: readonly string[]): string {
  if (chunks.length === 1) return chunks[0]!;
  let fmt: Buffer | null = null;
  const data: Buffer[] = [];
  for (const chunk of chunks) {
    const wav = Buffer.from(chunk, 'base64');
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('TTS chunk is not a WAV file');
    }
    for (let at = 12; at + 8 <= wav.length;) {
      const id = wav.toString('ascii', at, at + 4);
      const size = wav.readUInt32LE(at + 4);
      const body = wav.subarray(at + 8, Math.min(wav.length, at + 8 + size));
      if (id === 'fmt ') fmt ??= body;
      if (id === 'data') data.push(body);
      at += 8 + size + (size % 2);
    }
  }
  if (!fmt) throw new Error('TTS chunk has no fmt chunk');
  const pcm = Buffer.concat(data);
  const header = Buffer.alloc(20);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + 8 + fmt.length + 8 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(fmt.length, 16);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(pcm.length, 4);
  return Buffer.concat([header, fmt, dataHeader, pcm]).toString('base64');
}
