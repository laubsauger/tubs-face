import { GPU_UNIFORM_FLOATS } from './constants.js';
import { INSTANCE_FLOATS } from './morph.js';
import { WEBGPU_POST_SHADER, WEBGPU_SHADER } from './shaders.js';

const GPU_SCENE_FORMAT = 'rgba8unorm';
const gpuTextureUsage = (globalThis as { GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number } }).GPUTextureUsage;
const gpuBufferUsage = (globalThis as { GPUBufferUsage?: { STORAGE: number; COPY_DST: number; UNIFORM: number } }).GPUBufferUsage;

// TypeScript 5.9's DOM lib has no WebGPU types (GPUDevice, GPUBuffer, ...),
// so the GPU objects are untyped handles in one place.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GpuHandle = any;

export interface WebGpuState {
  gpuUniformData: Float32Array;
  gpuPostUniformData: Float32Array;
  gpuContext: GpuHandle;
  gpuDevice: GpuHandle;
  gpuPixelPipeline: GpuHandle;
  gpuPostPipeline: GpuHandle;
  gpuUniformBuffer: GpuHandle;
  gpuPostUniformBuffer: GpuHandle;
  gpuInstanceBuffer: GpuHandle;
  gpuPixelBindGroup: GpuHandle;
  gpuPostBindGroup: GpuHandle;
  gpuSampler: GpuHandle;
  gpuSceneTexture: GpuHandle;
  gpuSceneTextureView: GpuHandle;
  gpuSceneWidth: number;
  gpuSceneHeight: number;
  gpuInstanceCount: number;
  /** Instances the current instance buffer can hold. */
  gpuInstanceCapacity: number;
  gpuFormat: string;
}

export function createWebGpuState(): WebGpuState {
  return {
    gpuUniformData: new Float32Array(GPU_UNIFORM_FLOATS),
    gpuPostUniformData: new Float32Array(GPU_UNIFORM_FLOATS),
    gpuContext: null,
    gpuDevice: null,
    gpuPixelPipeline: null,
    gpuPostPipeline: null,
    gpuUniformBuffer: null,
    gpuPostUniformBuffer: null,
    gpuInstanceBuffer: null,
    gpuPixelBindGroup: null,
    gpuPostBindGroup: null,
    gpuSampler: null,
    gpuSceneTexture: null,
    gpuSceneTextureView: null,
    gpuSceneWidth: 0,
    gpuSceneHeight: 0,
    gpuInstanceCount: 0,
    gpuInstanceCapacity: 0,
    gpuFormat: 'bgra8unorm',
  };
}

export function resetWebGpuResources(gpu: WebGpuState): void {
  if (gpu.gpuSceneTexture) {
    try { gpu.gpuSceneTexture.destroy(); } catch {}
  }
  if (gpu.gpuInstanceBuffer) {
    try { gpu.gpuInstanceBuffer.destroy(); } catch {}
  }
  if (gpu.gpuUniformBuffer) {
    try { gpu.gpuUniformBuffer.destroy(); } catch {}
  }
  if (gpu.gpuPostUniformBuffer) {
    try { gpu.gpuPostUniformBuffer.destroy(); } catch {}
  }

  gpu.gpuContext = null;
  gpu.gpuDevice = null;
  gpu.gpuPixelPipeline = null;
  gpu.gpuPostPipeline = null;
  gpu.gpuUniformBuffer = null;
  gpu.gpuPostUniformBuffer = null;
  gpu.gpuInstanceBuffer = null;
  gpu.gpuPixelBindGroup = null;
  gpu.gpuPostBindGroup = null;
  gpu.gpuSampler = null;
  gpu.gpuSceneTexture = null;
  gpu.gpuSceneTextureView = null;
  gpu.gpuSceneWidth = 0;
  gpu.gpuSceneHeight = 0;
  gpu.gpuInstanceCount = 0;
  gpu.gpuInstanceCapacity = 0;
}

function updateGpuPixelBindGroup(gpu: WebGpuState): void {
  if (!gpu.gpuDevice || !gpu.gpuPixelPipeline || !gpu.gpuUniformBuffer || !gpu.gpuInstanceBuffer) return;
  gpu.gpuPixelBindGroup = gpu.gpuDevice.createBindGroup({
    layout: gpu.gpuPixelPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: gpu.gpuUniformBuffer } },
      { binding: 1, resource: { buffer: gpu.gpuInstanceBuffer } },
    ],
  });
}

function updateGpuPostBindGroup(gpu: WebGpuState): void {
  if (!gpu.gpuDevice || !gpu.gpuPostPipeline || !gpu.gpuPostUniformBuffer || !gpu.gpuSampler || !gpu.gpuSceneTextureView) return;
  gpu.gpuPostBindGroup = gpu.gpuDevice.createBindGroup({
    layout: gpu.gpuPostPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: gpu.gpuPostUniformBuffer } },
      { binding: 1, resource: gpu.gpuSampler },
      { binding: 2, resource: gpu.gpuSceneTextureView },
    ],
  });
}

function createGpuSceneTarget(gpu: WebGpuState, canvas: HTMLCanvasElement): void {
  if (!gpu.gpuDevice || !canvas.width || !canvas.height) return;

  if (gpu.gpuSceneTexture) {
    try { gpu.gpuSceneTexture.destroy(); } catch {}
  }

  gpu.gpuSceneTexture = gpu.gpuDevice.createTexture({
        size: { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 },
        format: GPU_SCENE_FORMAT,
        usage: (gpuTextureUsage?.RENDER_ATTACHMENT ?? 0x10) | (gpuTextureUsage?.TEXTURE_BINDING ?? 0x04),
  });
  gpu.gpuSceneTextureView = gpu.gpuSceneTexture.createView();
  gpu.gpuSceneWidth = canvas.width;
  gpu.gpuSceneHeight = canvas.height;
  updateGpuPostBindGroup(gpu);
}

export function configureWebGpuCanvas(gpu: WebGpuState, canvas: HTMLCanvasElement | null): void {
  if (!gpu.gpuContext || !gpu.gpuDevice || !canvas) return;

  gpu.gpuContext.configure({
    device: gpu.gpuDevice,
    format: gpu.gpuFormat,
    alphaMode: 'premultiplied',
  });
  createGpuSceneTarget(gpu, canvas);
}

/**
 * Uploads count instances (INSTANCE_FLOATS each) from data. A morph uploads
 * every frame, so the buffer is reused and only replaced, with headroom,
 * when it is too small.
 */
export function writeGpuInstances(gpu: WebGpuState, data: Float32Array, count: number): void {
  if (!gpu.gpuDevice) return;

  if (!gpu.gpuInstanceBuffer || gpu.gpuInstanceCapacity < count) {
    if (gpu.gpuInstanceBuffer) {
      try { gpu.gpuInstanceBuffer.destroy(); } catch {}
    }
    const capacity = Math.max(1, Math.ceil(count * 1.5));
    gpu.gpuInstanceBuffer = gpu.gpuDevice.createBuffer({
      size: capacity * INSTANCE_FLOATS * 4,
      usage: (gpuBufferUsage?.STORAGE ?? 0x80) | (gpuBufferUsage?.COPY_DST ?? 0x08),
    });
    gpu.gpuInstanceCapacity = capacity;
    updateGpuPixelBindGroup(gpu);
  }

  if (count > 0) {
    gpu.gpuDevice.queue.writeBuffer(gpu.gpuInstanceBuffer, 0, data.buffer, data.byteOffset, count * INSTANCE_FLOATS * 4);
  }
  gpu.gpuInstanceCount = count;
}

async function createShaderModuleChecked(device: GpuHandle, code: string, label: string): Promise<GpuHandle> {
  const module = device.createShaderModule({ code, label });
  if (typeof module.getCompilationInfo !== 'function') return module;
  const info = await module.getCompilationInfo();
  const errors = info?.messages?.filter((message: { type: string }) => message.type === 'error') ?? [];
  if (!errors.length) return module;
  const first = errors[0];
  throw new Error(`${label} WGSL error (${first.lineNum}:${first.linePos}) ${first.message}`);
}

export async function initWebGpuRenderer(gpu: WebGpuState, canvas: HTMLCanvasElement | null): Promise<boolean> {
  if (!canvas || !('gpu' in navigator)) return false;

  try {
    const navGpu = (navigator as Navigator & { gpu?: GpuHandle }).gpu;
    if (!navGpu) return false;
    const context = canvas.getContext('webgpu');
    if (!context) return false;

    const adapter = await navGpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return false;

    const device = await adapter.requestDevice();
    const format = typeof navGpu.getPreferredCanvasFormat === 'function'
      ? navGpu.getPreferredCanvasFormat()
      : 'bgra8unorm';

    const pixelShaderModule = await createShaderModuleChecked(device, WEBGPU_SHADER, 'glitch-pixel');
    const postShaderModule = await createShaderModuleChecked(device, WEBGPU_POST_SHADER, 'glitch-post');

    const pixelPipeline = typeof device.createRenderPipelineAsync === 'function'
      ? await device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module: pixelShaderModule, entryPoint: 'vsMain' },
          fragment: {
            module: pixelShaderModule,
            entryPoint: 'fsMain',
            targets: [{
              format: GPU_SCENE_FORMAT,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          multisample: { count: 1 },
        })
      : device.createRenderPipeline({
          layout: 'auto',
          vertex: { module: pixelShaderModule, entryPoint: 'vsMain' },
          fragment: {
            module: pixelShaderModule,
            entryPoint: 'fsMain',
            targets: [{
              format: GPU_SCENE_FORMAT,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          multisample: { count: 1 },
        });

    const postPipeline = typeof device.createRenderPipelineAsync === 'function'
      ? await device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module: postShaderModule, entryPoint: 'vsPost' },
          fragment: {
            module: postShaderModule,
            entryPoint: 'fsPost',
            targets: [{
              format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          multisample: { count: 1 },
        })
      : device.createRenderPipeline({
          layout: 'auto',
          vertex: { module: postShaderModule, entryPoint: 'vsPost' },
          fragment: {
            module: postShaderModule,
            entryPoint: 'fsPost',
            targets: [{
              format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          multisample: { count: 1 },
        });

        const uniformBuffer = device.createBuffer({
            size: GPU_UNIFORM_FLOATS * 4,
            usage: (gpuBufferUsage?.UNIFORM ?? 0x40) | (gpuBufferUsage?.COPY_DST ?? 0x08),
        });
        const postUniformBuffer = device.createBuffer({
            size: GPU_UNIFORM_FLOATS * 4,
            usage: (gpuBufferUsage?.UNIFORM ?? 0x40) | (gpuBufferUsage?.COPY_DST ?? 0x08),
        });

    const placeholder = new Float32Array(INSTANCE_FLOATS);
        const instanceBuffer = device.createBuffer({
            size: placeholder.byteLength,
            usage: (gpuBufferUsage?.STORAGE ?? 0x80) | (gpuBufferUsage?.COPY_DST ?? 0x08),
        });
    device.queue.writeBuffer(instanceBuffer, 0, placeholder.buffer, placeholder.byteOffset, placeholder.byteLength);
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    gpu.gpuContext = context;
    gpu.gpuDevice = device;
    gpu.gpuPixelPipeline = pixelPipeline;
    gpu.gpuPostPipeline = postPipeline;
    gpu.gpuUniformBuffer = uniformBuffer;
    gpu.gpuPostUniformBuffer = postUniformBuffer;
    gpu.gpuInstanceBuffer = instanceBuffer;
    gpu.gpuSampler = sampler;
    gpu.gpuInstanceCount = 0;
    gpu.gpuInstanceCapacity = 1;
    gpu.gpuFormat = format;

    updateGpuPixelBindGroup(gpu);
    createGpuSceneTarget(gpu, canvas);
    updateGpuPostBindGroup(gpu);
    void device.lost?.then?.((info: { message?: string }) => {
      console.warn('[GlitchFX] WebGPU device lost:', info?.message || info);
    }).catch(() => {});

    return true;
  } catch (error) {
    console.warn('[GlitchFX] WebGPU init failed:', error);
    resetWebGpuResources(gpu);
    return false;
  }
}
