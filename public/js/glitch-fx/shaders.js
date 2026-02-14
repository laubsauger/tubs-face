// WebGPU shader sources for glitch-fx

export const WEBGPU_SHADER = /* wgsl */`
struct Globals {
  canvas: vec4f,      // W, H, dpr, timeSec
  face: vec4f,        // faceOX, faceOY, faceW, faceH
  gaze: vec4f,        // eyeGazeX, eyeGazeY, mouthGazeX, mouthGazeY
  shapeCenters: vec4f,// leftEyeCenterY, rightEyeCenterY, mouthCenterY, blinkF
  motion: vec4f,      // mouthScale, pixelSize, opacityMin, pulseMod
  color: vec4f,       // baseHue01, baseSat01, baseLight01, flicker
  scan: vec4f,        // scanY, scanHalfW, scanBrightness, scanGlow
  chroma: vec4f,      // offX, offY, intensity, enabled
  glitch: vec4f,      // inBurst, sliceCount, maxOffset, intensity
  glitch2: vec4f,     // gapChance, burstSeed, intervalSec, burstDurSec
  scanline: vec4f,    // enabled, intensity, spacing, scroll
  flags: vec4f        // sleeping, scanlineThicknessRatio, reserved, reserved
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
    // Tear decorators: follow eye gaze, no blink, oscillating flow
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

  // Tear opacity modulation for groups 3+
  if (in.group > 2.5) {
    alpha = alpha * (0.5 + 0.5 * sin(u.canvas.w * 2.0 + in.group * 3.14159));
  }

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), clamp(alpha, 0.0, 1.0));
}
`;

export const WEBGPU_POST_SHADER = /* wgsl */`
struct Globals {
  canvas: vec4f,      // W, H, dpr, timeSec
  face: vec4f,        // faceOX, faceOY, faceW, faceH
  gaze: vec4f,        // eyeGazeX, eyeGazeY, mouthGazeX, mouthGazeY
  shapeCenters: vec4f,// leftEyeCenterY, rightEyeCenterY, mouthCenterY, blinkF
  motion: vec4f,      // mouthScale, pixelSize, opacityMin, pulseMod
  color: vec4f,       // baseHue01, baseSat01, baseLight01, flicker
  scan: vec4f,        // scanY, scanHalfW, scanBrightness, scanGlow
  chroma: vec4f,      // offX, offY, intensity, enabled
  glitch: vec4f,      // inBurst, sliceCount, maxOffset, intensity
  glitch2: vec4f,     // gapChance, burstSeed, intervalSec, burstDurSec
  scanline: vec4f,    // enabled, intensity, spacing, scroll
  flags: vec4f        // sleeping, scanlineThicknessRatio, bloomIntensity, glowStrength
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

fn sampleScene(uv: vec2f) -> vec4f {
  let suv = vec2f(uv.x, 1.0 - uv.y);
  return textureSampleLevel(sceneTex, sceneSampler, clamp(suv, vec2f(0.0), vec2f(1.0)), 0.0);
}

@vertex
fn vsPost(@builtin(vertex_index) vid: u32) -> VSOut {
  var pos = vec2f(-1.0, -1.0);
  var uv = vec2f(0.0, 0.0);
  switch (vid) {
    case 0u: {
      pos = vec2f(-1.0, -1.0);
      uv = vec2f(0.0, 0.0);
    }
    case 1u: {
      pos = vec2f(1.0, -1.0);
      uv = vec2f(1.0, 0.0);
    }
    case 2u: {
      pos = vec2f(-1.0, 1.0);
      uv = vec2f(0.0, 1.0);
    }
    case 3u: {
      pos = vec2f(-1.0, 1.0);
      uv = vec2f(0.0, 1.0);
    }
    case 4u: {
      pos = vec2f(1.0, -1.0);
      uv = vec2f(1.0, 0.0);
    }
    default: {
      pos = vec2f(1.0, 1.0);
      uv = vec2f(1.0, 1.0);
    }
  }

  var out: VSOut;
  out.position = vec4f(pos, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fsPost(in: VSOut) -> @location(0) vec4f {
  var uv = in.uv;

  if (u.glitch.x > 0.5) {
    let sliceCount = max(1.0, u.glitch.y);
    let band = floor(uv.y * sliceCount);
    let gapNoise = hash12(vec2f(band, u.canvas.w * 0.77 + u.glitch2.y));
    if (gapNoise < u.glitch2.x) {
      return vec4f(0.0);
    }

    let offNoise = hash12(vec2f(band + 19.0, u.canvas.w * 1.73 + u.glitch2.y));
    let offPx = (offNoise - 0.5) * 2.0 * u.glitch.z * u.glitch.w;
    uv.x = uv.x + offPx / max(1.0, u.canvas.x);
  }

  let base = sampleScene(uv);
  var color = base.rgb;

  if (u.chroma.w > 0.5 && u.chroma.z > 0.0) {
    let offs = vec2f(
      u.chroma.x / max(1.0, u.canvas.x),
      u.chroma.y / max(1.0, u.canvas.y)
    );
    let r = sampleScene(uv + offs).r;
    let g = sampleScene(uv).g;
    let b = sampleScene(uv - offs).b;
    let ca = vec3f(r, g, b);
    color = mix(color, ca, clamp(u.chroma.z, 0.0, 1.0));
  }

  let px = vec2f(1.0 / max(1.0, u.canvas.x), 1.0 / max(1.0, u.canvas.y));
  let blur =
    sampleScene(uv + vec2f(px.x, 0.0)).rgb +
    sampleScene(uv - vec2f(px.x, 0.0)).rgb +
    sampleScene(uv + vec2f(0.0, px.y)).rgb +
    sampleScene(uv - vec2f(0.0, px.y)).rgb;
  let bloom = blur * 0.25;
  let bloomStrength = max(0.0, u.flags.z) * (0.12 + max(0.0, u.flags.w) * 0.18);
  color = color + bloom * bloomStrength;

  if (u.scan.y > 0.0) {
    let y = uv.y * u.canvas.y;
    let dist = abs(y - u.scan.x);
    let beam = 1.0 - clamp(dist / max(1.0, u.scan.y * 1.8), 0.0, 1.0);
    let beamCurve = beam * beam;
    let beamColor = hslToRgb(fract(u.color.x), 1.0, 0.5);
    color = color + beamColor * beamCurve * (u.scan.w / 95.0);
  }

  if (u.scanline.x > 0.5 && u.scanline.z > 0.0) {
    let phase = fract((uv.y * u.canvas.y + u.scanline.w) / max(1.0, u.scanline.z));
    let lineMask = 1.0 - step(u.flags.y, phase);
    color = color * (1.0 - lineMask * u.scanline.y);
  }

  color = color * u.color.w;
  let alpha = clamp(base.a * u.color.w, 0.0, 1.0);
  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), alpha);
}
`;

