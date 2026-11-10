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
  flags: vec4f,
  // Living expression motion per shape: a pixel centre p goes to p * xy + zw.
  xformL: vec4f,
  xformR: vec4f,
  xformM: vec4f,
  // A worn prop (glitch/props.ts): its pivot (the middle of its base) and its
  // tilt's cos and sin; then how far it moves with the eyes' tops.
  prop: vec4f,
  propMove: vec4f
};

@group(0) @binding(0) var<uniform> u: Globals;
@group(0) @binding(1) var<storage, read> pixels: array<vec4f>;

// Tears (3 and 4) move with their eye.
fn shapeXform(group: f32) -> vec4f {
  if (group < 0.5 || (group > 2.5 && group < 3.5)) { return u.xformL; }
  if (group < 1.5 || group > 3.5) { return u.xformR; }
  return u.xformM;
}

// A prop pixel's centre (groups 5-7). The propeller's blades (6) turn round
// the middle: seen from the front a turn squeezes them in and swaps their
// sides. The tassel (7) swings a little. Then the whole prop tilts about its
// pivot and moves with the eyes' tops; the gaze moves it with the eyes.
fn propCentre(p: vec2f, group: f32) -> vec2f {
  var local = p - u.prop.xy;
  if (group > 5.5 && group < 6.5) {
    local.x = local.x * cos(u.canvas.w * 9.0);
  } else if (group > 6.5) {
    local.x = local.x + sin(u.canvas.w * 4.2) * u.motion.y * 0.5;
  }
  let turned = vec2f(local.x * u.prop.z - local.y * u.prop.w, local.x * u.prop.w + local.y * u.prop.z);
  return u.prop.xy + turned + u.propMove.xy;
}

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) hueOff: f32,
  @location(1) brightOff: f32,
  @location(2) worldPos: vec2f,
  @location(3) uv: vec2f,
  @location(4) visible: f32,
  @location(5) group: f32,
  @location(6) overrideColor: vec3f,
  @location(7) scale: f32
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

  let hueOff = a.z;
  let brightOff = a.w;

  let group = b.x;
  // Below 1 only while a morph grows the pixel in or shrinks it away.
  let scale = b.y;

  // The shape's motion moves the pixel centre and sizes the pixel with it.
  let xf = shapeXform(group);
  let sz = u.motion.y;
  var moved = (a.xy + vec2f(sz * 0.5)) * xf.xy + xf.zw;
  var drawW = sz * xf.x;
  var drawH = sz * xf.y;
  if (group > 4.5) {
    moved = propCentre(a.xy + vec2f(sz * 0.5), group);
    drawW = sz;
    drawH = sz;
  }
  var x = moved.x - drawW * 0.5 + u.face.x;
  var y = moved.y - drawH * 0.5 + u.face.y;

  if (group < 1.5) {
    x = x + u.gaze.x;
    y = y + u.gaze.y;
    if (u.shapeCenters.w > 0.0001) {
      var centerY = u.shapeCenters.x;
      if (group >= 0.5) {
        centerY = u.shapeCenters.y;
      }
      centerY = centerY * xf.y + xf.w + u.face.y + u.gaze.y;
      y = centerY + (y - centerY) * (1.0 - u.shapeCenters.w);
      drawH = max(2.0, drawH * (1.0 - u.shapeCenters.w * 0.85));
    }
  } else if (group < 2.5) {
    x = x + u.gaze.z;
    y = y + u.gaze.w;
    let centerY = u.shapeCenters.z * xf.y + xf.w + u.face.y + u.gaze.w;
    y = centerY + (y - centerY) * u.motion.x;
    // Closing, the pixels flatten too (like a blink); moving only the rows
    // left the mouth looking the same.
    drawH = max(2.0, drawH * clamp(u.motion.x, 0.2, 1.0));
  } else if (group < 4.5) {
    x = x + u.gaze.x;
    y = y + u.gaze.y;
    y = y + sin(u.canvas.w * 1.5 + a.y * 0.05) * u.motion.y * 0.3;
  } else {
    x = x + u.gaze.x;
    y = y + u.gaze.y;
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

  // Scaled around the pixel's own centre, so it grows and shrinks in place.
  let w = drawW * scale;
  let h = drawH * scale;
  let px = x + (drawW - w) * 0.5 + corner.x * w;
  let py = y + (drawH - h) * 0.5 + corner.y * h;

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
  // b.z is the override hue, negative for the base colour.
  out.overrideColor = vec3f(select(0.0, 1.0, b.z >= 0.0), b.z, b.w);
  out.scale = scale;
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

  if (in.group > 2.5 && in.group < 4.5) {
    alpha = alpha * (0.5 + 0.5 * sin(u.canvas.w * 2.0 + in.group * 3.14159));
  }
  // Pixels fade as they shrink, so they melt into the new shape instead of popping.
  alpha = alpha * clamp(in.scale * 1.5, 0.0, 1.0);

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
