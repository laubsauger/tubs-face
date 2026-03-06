// WebGPU shader sources for glitch-fx.

export const WEBGPU_SHADER = /* wgsl */`
struct Globals {
  canvas: vec4f,
  face: vec4f,
  gaze: vec4f,
  shapeCenters: vec4f,
  motion: vec4f,
  color: vec4f,
  scan: vec4f,
  chroma: vec4f,
  glitch: vec4f,
  glitch2: vec4f,
  scanline: vec4f,
  flags: vec4f
};

@group(0) @binding(0) var<uniform> u: Globals;
@group(0) @binding(1) var<storage, read> pixels: array<vec4f>;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) hueOff: f32,
  @location(1) brightOff: f32,
  @location(2) worldPos: vec2f,
  @location(3) uv: vec2f,
  @location(4) visible: f32,
  @location(5) group: f32,
  @location(6) overrideColor: vec3f
};

fn hash12(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn hue2rgb(p: f32, q: f32, tIn: f32) -> f32 {
  var t = tIn;
  if (t < 0.0) { t = t + 1.0; }
  if (t > 1.0) { t = t - 1.0; }
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}

fn hslToRgb(h: f32, s: f32, l: f32) -> vec3f {
  if (s <= 0.0001) {
    return vec3f(l, l, l);
  }
  var q = l * (1.0 + s);
  if (l >= 0.5) {
    q = l + s - l * s;
  }
  let p = 2.0 * l - q;
  return vec3f(
    hue2rgb(p, q, h + 1.0 / 3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0 / 3.0)
  );
}

@vertex
fn vsMain(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VSOut {
  let base = iid * 2u;
  let a = pixels[base];
  let b = pixels[base + 1u];

  var x = a.x + u.face.x;
  var y = a.y + u.face.y;
  let hueOff = a.z;
  let brightOff = a.w;

  let group = b.x;
  var drawH = u.motion.y;
  let drawW = u.motion.y;

  if (group < 1.5) {
    x = x + u.gaze.x;
    y = y + u.gaze.y;
    if (u.shapeCenters.w > 0.0001) {
      var centerY = u.shapeCenters.x;
      if (group >= 0.5) {
        centerY = u.shapeCenters.y;
      }
      centerY = centerY + u.face.y + u.gaze.y;
      y = centerY + (y - centerY) * (1.0 - u.shapeCenters.w);
      drawH = max(2.0, u.motion.y * (1.0 - u.shapeCenters.w * 0.85));
    }
  } else if (group < 2.5) {
    x = x + u.gaze.z;
    y = y + u.gaze.w;
    let centerY = u.shapeCenters.z + u.face.y + u.gaze.w;
    y = centerY + (y - centerY) * u.motion.x;
  } else {
    x = x + u.gaze.x;
    y = y + u.gaze.y;
    y = y + sin(u.canvas.w * 1.5 + a.y * 0.05) * u.motion.y * 0.3;
  }

  var visible = 1.0;
  if (u.glitch.x > 0.5) {
    let sliceCount = max(1.0, u.glitch.y);
    let bandSize = max(1.0, u.canvas.y / sliceCount);
    let band = floor((y + drawH * 0.5) / bandSize);

    let gapNoise = hash12(vec2f(band, u.canvas.w * 0.77 + u.glitch2.y));
    if (gapNoise < u.glitch2.x) {
      visible = 0.0;
    }

    let offNoise = hash12(vec2f(band + 19.0, u.canvas.w * 1.73 + u.glitch2.y));
    x = x + (offNoise - 0.5) * 2.0 * u.glitch.z * u.glitch.w;
  }

  var corner = vec2f(1.0, 1.0);
  switch (vid) {
    case 0u: { corner = vec2f(0.0, 0.0); }
    case 1u: { corner = vec2f(1.0, 0.0); }
    case 2u: { corner = vec2f(0.0, 1.0); }
    case 3u: { corner = vec2f(0.0, 1.0); }
    case 4u: { corner = vec2f(1.0, 0.0); }
    default: { corner = vec2f(1.0, 1.0); }
  }

  let px = x + corner.x * drawW;
  let py = y + corner.y * drawH;

  let ndcX = (px / max(1.0, u.canvas.x)) * 2.0 - 1.0;
  let ndcY = 1.0 - (py / max(1.0, u.canvas.y)) * 2.0;

  var out: VSOut;
  out.position = vec4f(ndcX, ndcY, 0.0, 1.0);
  out.hueOff = hueOff;
  out.brightOff = brightOff;
  out.worldPos = vec2f(px, py);
  out.uv = corner;
  out.visible = visible;
  out.group = group;
  out.overrideColor = vec3f(b.y, b.z, b.w);
  return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4f {
  if (in.visible < 0.5) {
    discard;
  }

  var hue = fract(u.color.x + in.hueOff / 360.0);
  var sat = clamp(u.color.y, 0.0, 1.0);
  if (in.overrideColor.x > 0.5) {
    hue = fract(in.overrideColor.y);
    sat = clamp(in.overrideColor.z, 0.0, 1.0);
  }
  var light = (u.color.z * 100.0 + in.brightOff) * u.motion.w;

  if (u.scan.y > 0.0) {
    let dist = abs(in.worldPos.y - u.scan.x);
    if (dist < u.scan.y) {
      light = light + (1.0 - dist / u.scan.y) * u.scan.z * 30.0;
    }
  }

  let l = clamp(light / 100.0, 0.0, 1.0);
  let base = hslToRgb(hue, sat, l);
  var color = base;

  if (u.chroma.w > 0.5 && u.chroma.z > 0.0) {
    let wave = 0.5 + 0.5 * sin((in.worldPos.y + u.chroma.y) * 0.18 + (in.worldPos.x + u.chroma.x) * 0.07 + u.canvas.w * 3.2);
    color.r = color.r + wave * u.chroma.z * 0.28;
    color.b = color.b + (1.0 - wave) * u.chroma.z * 0.40;
  }

  let dx = abs(in.uv.x - 0.5) * 2.0;
  let dy = abs(in.uv.y - 0.5) * 2.0;
  let edge = max(dx, dy);
  let glow = pow(clamp(1.0 - edge, 0.0, 1.0), 1.6) * (u.scan.w / 120.0 + 0.16);
  color = color + base * glow;

  if (u.scanline.x > 0.5 && u.scanline.z > 0.0) {
    let phase = fract((in.worldPos.y + u.scanline.w) / max(1.0, u.scanline.z));
    let lineMask = 1.0 - step(u.flags.y, phase);
    let dim = 1.0 - lineMask * u.scanline.y;
    color = color * dim;
  }

  color = color * u.color.w;
  var alpha = clamp(u.motion.z + (1.0 - u.motion.z) * u.motion.w, u.motion.z, 1.0);
  alpha = alpha * u.color.w;

  if (in.group > 2.5) {
    alpha = alpha * (0.5 + 0.5 * sin(u.canvas.w * 2.0 + in.group * 3.14159));
  }

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), clamp(alpha, 0.0, 1.0));
}
`;

// Preserved from the legacy renderer; TS transport now has the shader source colocated.
export const WEBGPU_POST_SHADER = /* wgsl */`
struct Globals {
  canvas: vec4f,
  face: vec4f,
  gaze: vec4f,
  shapeCenters: vec4f,
  motion: vec4f,
  color: vec4f,
  scan: vec4f,
  chroma: vec4f,
  glitch: vec4f,
  glitch2: vec4f,
  scanline: vec4f,
  flags: vec4f
};

@group(0) @binding(0) var<uniform> u: Globals;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f
};

fn hash12(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

@vertex
fn vsPost(@builtin(vertex_index) vid: u32) -> VSOut {
  var pos = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0),
  );
  var uv = array<vec2f, 6>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 0.0),
    vec2f(1.0, 1.0),
  );
  var out: VSOut;
  out.position = vec4f(pos[vid], 0.0, 1.0);
  out.uv = uv[vid];
  return out;
}

fn sampleScene(uv: vec2f) -> vec4f {
  let suv = vec2f(uv.x, 1.0 - uv.y);
  return textureSample(sceneTex, sceneSampler, suv);
}

@fragment
fn fsPost(in: VSOut) -> @location(0) vec4f {
  var uv = in.uv;
  var x = uv.x;
  let y = uv.y;

  if (u.glitch.x > 0.5) {
    let sliceCount = max(1.0, u.glitch.y);
    let band = floor(y * sliceCount);
    let gapNoise = hash12(vec2f(band, u.glitch2.y + 31.0));
    if (gapNoise < u.glitch2.x) {
      discard;
    }
    let offNoise = hash12(vec2f(band + 19.0, u.glitch2.y + 53.0));
    let offPx = (offNoise - 0.5) * 2.0 * u.glitch.z * u.glitch.w;
    x = x + offPx / max(1.0, u.canvas.x);
  }

  var color = sampleScene(vec2f(x, y));
  if (u.scanline.x > 0.5 && u.scanline.z > 0.0) {
    let phase = fract((y * u.canvas.y + u.scanline.w) / max(1.0, u.scanline.z));
    let lineMask = 1.0 - step(u.flags.y, phase);
    let dim = 1.0 - lineMask * u.scanline.y;
    color = vec4f(color.rgb * dim, color.a);
  }

  if (u.flags.z > 0.0) {
    let bloom = (
      sampleScene(vec2f(x + 0.003, y)).rgb +
      sampleScene(vec2f(x - 0.003, y)).rgb +
      sampleScene(vec2f(x, y + 0.003)).rgb +
      sampleScene(vec2f(x, y - 0.003)).rgb
    ) * 0.25;
    color = vec4f(color.rgb + bloom * u.flags.z * 0.35, color.a);
  }

  return color;
}
`;
