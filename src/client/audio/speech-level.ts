/**
 * How loud Tubs's voice is right now, for lip sync. Streamed speech plays
 * through one analyser per AudioContext and the face reads the level every
 * frame, so the mouth closes in pauses and opens on loud syllables instead of
 * flapping at a fixed rate.
 */

// Kokoro speech peaks around 0.1-0.25 RMS; this maps it to roughly 0..1.
const LEVEL_GAIN = 5;
// A jaw opens fast and closes a little slower.
const ATTACK_MS = 30;
const RELEASE_MS = 90;

interface Meter {
  input: GainNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
}

const meters = new WeakMap<AudioContext, Meter>();
let active: Meter | null = null;
let envelope = 0;
let lastReadAt = 0;

/** Where speech sources connect instead of the destination. */
export function speechOutput(context: AudioContext): AudioNode {
  let meter = meters.get(context);
  if (!meter) {
    const input = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    input.connect(analyser);
    input.connect(context.destination);
    meter = { input, analyser, samples: new Float32Array(analyser.fftSize) };
    meters.set(context, meter);
  }
  active = meter;
  return meter.input;
}

/** Smoothed level 0..1, or null before any speech was played. */
export function readSpeechLevel(now: number): number | null {
  if (!active) return null;
  active.analyser.getFloatTimeDomainData(active.samples);
  let sum = 0;
  for (const sample of active.samples) sum += sample * sample;
  const target = Math.min(1, Math.sqrt(sum / active.samples.length) * LEVEL_GAIN);
  const dt = lastReadAt ? Math.min(100, Math.max(0, now - lastReadAt)) : 16;
  lastReadAt = now;
  const tau = target > envelope ? ATTACK_MS : RELEASE_MS;
  envelope += (target - envelope) * (1 - Math.exp(-dt / tau));
  return envelope;
}
