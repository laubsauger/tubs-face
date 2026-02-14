import { GPU_UNIFORM_FLOATS } from './constants.js';
import { WEBGPU_POST_SHADER, WEBGPU_SHADER } from './shaders.js';

const GPU_SCENE_FORMAT = 'rgba8unorm';

export function createWebGpuState() {
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
        gpuFormat: 'bgra8unorm',
    };
}

export function resetWebGpuResources(gpu) {
    if (gpu.gpuSceneTexture) {
        try { gpu.gpuSceneTexture.destroy(); } catch { }
    }
    if (gpu.gpuInstanceBuffer) {
        try { gpu.gpuInstanceBuffer.destroy(); } catch { }
    }
    if (gpu.gpuUniformBuffer) {
        try { gpu.gpuUniformBuffer.destroy(); } catch { }
    }
    if (gpu.gpuPostUniformBuffer) {
        try { gpu.gpuPostUniformBuffer.destroy(); } catch { }
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
}

function updateGpuPixelBindGroup(gpu) {
    if (!gpu.gpuDevice || !gpu.gpuPixelPipeline || !gpu.gpuUniformBuffer || !gpu.gpuInstanceBuffer) return;
    gpu.gpuPixelBindGroup = gpu.gpuDevice.createBindGroup({
        layout: gpu.gpuPixelPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: gpu.gpuUniformBuffer } },
            { binding: 1, resource: { buffer: gpu.gpuInstanceBuffer } },
        ],
    });
}

function updateGpuPostBindGroup(gpu) {
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

function createGpuSceneTarget(gpu, canvas) {
    if (!gpu.gpuDevice || !canvas?.width || !canvas?.height) return;
    if (gpu.gpuSceneTexture && gpu.gpuSceneWidth === canvas.width && gpu.gpuSceneHeight === canvas.height) return;

    if (gpu.gpuSceneTexture) {
        try { gpu.gpuSceneTexture.destroy(); } catch { }
    }

    gpu.gpuSceneTexture = gpu.gpuDevice.createTexture({
        size: { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 },
        format: GPU_SCENE_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    gpu.gpuSceneTextureView = gpu.gpuSceneTexture.createView();
    gpu.gpuSceneWidth = canvas.width;
    gpu.gpuSceneHeight = canvas.height;
    updateGpuPostBindGroup(gpu);
}

export function configureWebGpuCanvas(gpu, canvas) {
    if (!gpu.gpuContext || !gpu.gpuDevice || !canvas) return;

    gpu.gpuContext.configure({
        device: gpu.gpuDevice,
        format: gpu.gpuFormat,
        alphaMode: 'premultiplied',
    });
    createGpuSceneTarget(gpu, canvas);
}

export function updateGpuInstanceBuffer(gpu, pixelGrid, shapeGroups) {
    if (!gpu.gpuDevice) return;

    const instanceCount = pixelGrid.length;
    const minFloats = 8;
    const floatCount = Math.max(minFloats, instanceCount * 8);
    const packed = new Float32Array(floatCount);

    for (let i = 0; i < instanceCount; i++) {
        const p = pixelGrid[i];
        const off = i * 8;
        packed[off + 0] = p.x;
        packed[off + 1] = p.y;
        packed[off + 2] = p.hueOff;
        packed[off + 3] = p.brightOff;
        packed[off + 4] = shapeGroups[i] || 0;
        const ovr = p.overrideHSL;
        packed[off + 5] = ovr ? 1 : 0;
        packed[off + 6] = ovr ? ((ovr.h % 360 + 360) % 360 / 360) : 0;
        packed[off + 7] = ovr ? (ovr.s / 100) : 0;
    }

    if (gpu.gpuInstanceBuffer) {
        try { gpu.gpuInstanceBuffer.destroy(); } catch { }
    }

    gpu.gpuInstanceBuffer = gpu.gpuDevice.createBuffer({
        size: packed.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    gpu.gpuDevice.queue.writeBuffer(gpu.gpuInstanceBuffer, 0, packed.buffer, packed.byteOffset, packed.byteLength);
    gpu.gpuInstanceCount = instanceCount;
    updateGpuPixelBindGroup(gpu);
}

async function createShaderModuleChecked(device, code, label = 'shader') {
    const module = device.createShaderModule({ code, label });
    if (typeof module.getCompilationInfo !== 'function') {
        return module;
    }

    const info = await module.getCompilationInfo();
    if (!info?.messages?.length) {
        return module;
    }

    const errors = info.messages.filter((m) => m.type === 'error');
    if (!errors.length) {
        return module;
    }

    const first = errors[0];
    throw new Error(`${label} WGSL error (${first.lineNum}:${first.linePos}) ${first.message}`);
}

export async function initWebGpuRenderer(gpu, canvas) {
    if (!canvas || !navigator.gpu) return false;

    try {
        const context = canvas.getContext('webgpu');
        if (!context) return false;

        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return false;

        const device = await adapter.requestDevice();
        const format = navigator.gpu.getPreferredCanvasFormat
            ? navigator.gpu.getPreferredCanvasFormat()
            : 'bgra8unorm';

        const pixelShaderModule = await createShaderModuleChecked(device, WEBGPU_SHADER, 'glitch-pixel');
        const postShaderModule = await createShaderModuleChecked(device, WEBGPU_POST_SHADER, 'glitch-post');

        const pixelPipelineDescriptor = {
            layout: 'auto',
            vertex: {
                module: pixelShaderModule,
                entryPoint: 'vsMain',
            },
            fragment: {
                module: pixelShaderModule,
                entryPoint: 'fsMain',
                targets: [{
                    format: GPU_SCENE_FORMAT,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            multisample: { count: 1 },
        };
        const pixelPipeline = typeof device.createRenderPipelineAsync === 'function'
            ? await device.createRenderPipelineAsync(pixelPipelineDescriptor)
            : device.createRenderPipeline(pixelPipelineDescriptor);

        const postPipelineDescriptor = {
            layout: 'auto',
            vertex: {
                module: postShaderModule,
                entryPoint: 'vsPost',
            },
            fragment: {
                module: postShaderModule,
                entryPoint: 'fsPost',
                targets: [{
                    format,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            multisample: { count: 1 },
        };
        const postPipeline = typeof device.createRenderPipelineAsync === 'function'
            ? await device.createRenderPipelineAsync(postPipelineDescriptor)
            : device.createRenderPipeline(postPipelineDescriptor);

        const uniformBuffer = device.createBuffer({
            size: GPU_UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const postUniformBuffer = device.createBuffer({
            size: GPU_UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const placeholder = new Float32Array(8);
        const instanceBuffer = device.createBuffer({
            size: placeholder.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
        gpu.gpuFormat = format;

        updateGpuPixelBindGroup(gpu);
        createGpuSceneTarget(gpu, canvas);
        updateGpuPostBindGroup(gpu);

        device.lost.then((info) => {
            console.warn('[GlitchFX] WebGPU device lost:', info?.message || info);
        }).catch(() => { });

        return true;
    } catch (err) {
        console.warn('[GlitchFX] WebGPU init failed, falling back to Canvas2D:', err);
        resetWebGpuResources(gpu);
        return false;
    }
}
