// AudioWorklet that copies every mic sample to the main thread in 2048-sample
// chunks, so the clip buffer always has the last moments of audio. Inlined as a
// Blob module to avoid a separate build entry.
const TAP_PROCESSOR_SOURCE = `
class TubsPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this.buffer[this.filled++] = channel[i];
        if (this.filled === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(2048);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('tubs-pcm-tap', TubsPcmTap);
`;

/** Starts tapping `source`; returns a function that stops and disconnects it. */
export async function createPcmTap(
  context: AudioContext,
  source: AudioNode,
  onChunk: (chunk: Float32Array) => void,
): Promise<() => void> {
  const url = URL.createObjectURL(new Blob([TAP_PROCESSOR_SOURCE], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(context, 'tubs-pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  // The graph only runs nodes that lead to the destination; route through a muted gain.
  const sink = context.createGain();
  sink.gain.value = 0;
  node.port.onmessage = (event: MessageEvent<Float32Array>) => onChunk(event.data);
  source.connect(node);
  node.connect(sink);
  sink.connect(context.destination);
  return () => {
    node.port.onmessage = null;
    try {
      source.disconnect(node);
    } catch {
      // already disconnected
    }
    node.disconnect();
    sink.disconnect();
  };
}
