import type { VadProvider, VadResult } from './types.js';

/**
 * TEN-VAD provider. Loads the WASM module from /audio/ten-vad/ and
 * processes 16 kHz int16 frames through the native C API.
 *
 * The voice-runtime feeds float32 samples at the AudioContext sample rate
 * (typically 44100 or 48000). We downsample to 16 kHz internally and
 * accumulate samples until we have a full frame (HOP_SIZE).
 */

const WASM_JS_URL = '/audio/ten-vad/ten_vad.js';
const HOP_SIZE = 256; // 16ms at 16 kHz
const VOICE_THRESHOLD = 0.5;
const TARGET_SAMPLE_RATE = 16000;

interface TenVadWasmModule {
  _ten_vad_create(handlePtr: number, hopSize: number, threshold: number): number;
  _ten_vad_process(
    handle: number,
    audioDataPtr: number,
    audioDataLength: number,
    outProbabilityPtr: number,
    outFlagPtr: number,
  ): number;
  _ten_vad_destroy(handlePtr: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
  HEAPF32: Float32Array;
  HEAP32: Int32Array;
  HEAPU8: Uint8Array;
}

/** Read an i32 from WASM heap (pointer must be 4-byte aligned). */
function readI32(mod: TenVadWasmModule, ptr: number): number {
  return mod.HEAP32[ptr >> 2]!;
}

/** Read a float32 from WASM heap (pointer must be 4-byte aligned). */
function readF32(mod: TenVadWasmModule, ptr: number): number {
  return mod.HEAPF32[ptr >> 2]!;
}

type WasmFactory = (opts?: { locateFile?: (path: string) => string }) => Promise<TenVadWasmModule>;

export function createTenVad(sourceSampleRate: number): VadProvider {
  let wasmModule: TenVadWasmModule | null = null;
  let vadHandle: number | null = null;
  let handlePtr: number | null = null;

  // Pre-allocated WASM pointers (created once after init)
  let audioPtr = 0;
  let probPtr = 0;
  let flagPtr = 0;

  // Resampling accumulator
  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
  let resampleBuffer: Int16Array = new Int16Array(HOP_SIZE);
  let resamplePos = 0;
  let srcFractional = 0;

  // Latest result (returned when we don't have a full frame yet)
  let lastResult: VadResult = { isVoice: false, probability: 0 };

  return {
    id: 'ten-vad',

    async init(): Promise<void> {
      // Load the WASM JS glue via fetch + blob URL to bypass Vite's module
      // pipeline (public/ files cannot be imported from source code).
      const jsResponse = await fetch(WASM_JS_URL);
      if (!jsResponse.ok) {
        throw new Error(`Failed to fetch ${WASM_JS_URL}: ${jsResponse.status}`);
      }
      const jsSource = await jsResponse.text();
      const blob = new Blob([jsSource], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      let factoryModule: { default: WasmFactory };
      try {
        factoryModule = await import(/* @vite-ignore */ blobUrl) as { default: WasmFactory };
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      const createModule = factoryModule.default;
      wasmModule = await createModule({
        locateFile: (path: string) => path.endsWith('.wasm') ? '/audio/ten-vad/ten_vad.wasm' : path,
      });

      // Create VAD instance
      handlePtr = wasmModule._malloc(4);
      const result = wasmModule._ten_vad_create(handlePtr, HOP_SIZE, VOICE_THRESHOLD);
      if (result !== 0) {
        wasmModule._free(handlePtr);
        handlePtr = null;
        throw new Error(`ten_vad_create failed (code ${result})`);
      }
      vadHandle = readI32(wasmModule, handlePtr);

      // Pre-allocate buffers
      audioPtr = wasmModule._malloc(HOP_SIZE * 2); // int16 = 2 bytes
      probPtr = wasmModule._malloc(4);
      flagPtr = wasmModule._malloc(4);
    },

    process(samples: Float32Array): VadResult {
      if (!wasmModule || vadHandle == null) {
        return lastResult;
      }

      // Downsample from source rate to 16 kHz and convert float32 → int16
      for (let i = 0; i < samples.length; i++) {
        srcFractional += 1;
        if (srcFractional >= ratio) {
          srcFractional -= ratio;
          const clamped = Math.max(-1, Math.min(1, samples[i]!));
          resampleBuffer[resamplePos] = Math.round(clamped * 32767);
          resamplePos++;

          if (resamplePos >= HOP_SIZE) {
            lastResult = runFrame(wasmModule, resampleBuffer);
            resamplePos = 0;
          }
        }
      }

      return lastResult;
    },

    dispose(): void {
      if (wasmModule) {
        if (audioPtr) wasmModule._free(audioPtr);
        if (probPtr) wasmModule._free(probPtr);
        if (flagPtr) wasmModule._free(flagPtr);
        if (handlePtr != null) {
          wasmModule._ten_vad_destroy(handlePtr);
          wasmModule._free(handlePtr);
        }
      }
      wasmModule = null;
      vadHandle = null;
      handlePtr = null;
      audioPtr = 0;
      probPtr = 0;
      flagPtr = 0;
      resamplePos = 0;
      srcFractional = 0;
    },
  };

  function runFrame(mod: TenVadWasmModule, frame: Int16Array): VadResult {
    mod.HEAP16.set(frame, audioPtr / 2);
    const rc = mod._ten_vad_process(vadHandle!, audioPtr, HOP_SIZE, probPtr, flagPtr);
    if (rc !== 0) {
      return lastResult;
    }
    const probability = readF32(mod, probPtr);
    const flag = readI32(mod, flagPtr);
    return { isVoice: flag === 1, probability };
  }
}
