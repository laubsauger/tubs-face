/**
 * Pure helpers for the pre-roll recorder: a buffer that always holds the last
 * few hundred milliseconds of mic audio, and a 16 kHz WAV encoder for Whisper.
 *
 * Hands-free recording starts only after speech is detected. Without the
 * pre-roll, the VAD reaction time plus recorder start-up (about 200-300 ms)
 * cut off the first word of every utterance.
 */
export interface ClipBuffer {
  push(chunk: Float32Array): void;
  /** Start a clip; with preRoll the clip begins with the buffered audio. */
  begin(options?: { preRoll?: boolean }): void;
  /** End the clip and return its samples (empty if no clip was running). */
  end(): Float32Array;
  readonly capturing: boolean;
}

export function createClipBuffer(sampleRate: number, preRollMs: number, maxClipMs: number): ClipBuffer {
  const preRollSamples = Math.round((sampleRate * preRollMs) / 1000);
  const maxClipSamples = Math.round((sampleRate * maxClipMs) / 1000);
  let ring: Float32Array[] = [];
  let ringSamples = 0;
  let clip: Float32Array[] | null = null;
  let clipSamples = 0;

  return {
    push(chunk) {
      if (clip) {
        if (clipSamples < maxClipSamples) {
          clip.push(chunk);
          clipSamples += chunk.length;
        }
        return;
      }
      ring.push(chunk);
      ringSamples += chunk.length;
      // Drop whole chunks from the front while the rest still covers the pre-roll.
      while (ring.length > 1 && ringSamples - ring[0]!.length >= preRollSamples) {
        ringSamples -= ring.shift()!.length;
      }
    },
    begin(options = {}) {
      clip = options.preRoll === false ? [] : trimToLast(ring, ringSamples, preRollSamples);
      clipSamples = clip.reduce((sum, part) => sum + part.length, 0);
      ring = [];
      ringSamples = 0;
    },
    end() {
      const parts = clip ?? [];
      clip = null;
      clipSamples = 0;
      return concat(parts);
    },
    get capturing() {
      return clip !== null;
    },
  };
}

function trimToLast(chunks: Float32Array[], total: number, keep: number): Float32Array[] {
  const out = [...chunks];
  let excess = total - keep;
  while (excess > 0 && out.length > 0) {
    const first = out[0]!;
    if (first.length <= excess) {
      out.shift();
      excess -= first.length;
    } else {
      out[0] = first.subarray(excess);
      excess = 0;
    }
  }
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Downsample to 16 kHz mono (box average) and encode as 16-bit PCM WAV. */
export function encodeWav16k(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const targetRate = 16_000;
  const ratio = sampleRate / targetRate;
  const length = Math.floor(samples.length / ratio);
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j]!;
    const value = end > start ? sum / (end - start) : 0;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  }

  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(buffer, 44).set(pcm);
  return buffer;
}
