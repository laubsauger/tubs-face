import type { AppState } from '../state/app-state.js';

interface FaceDecor {
  d: string;
  className: string;
}

interface FaceProfile {
  leftEye: string;
  rightEye: string;
  mouth: string;
  decor?: FaceDecor[];
}

export function renderFaceVisualMarkup(state: AppState): string {
  const mode = state.config?.faceRenderMode ?? 'css';
  if (mode === 'glitch') {
    return '';
  }

  if (mode === 'svg') {
    return renderSvgFace(state);
  }

  return `
    <div class="visual-eyes">
      <span class="visual-eye"></span>
      <span class="visual-eye"></span>
    </div>
    <div class="visual-mouth"></div>
  `;
}

function renderSvgFace(state: AppState): string {
  const profile = getFaceProfile(state);
  const decor = (profile.decor ?? []).map((item) => `
    <path class="face-svg-decor ${escapeAttribute(item.className)}" d="${escapeAttribute(item.d)}"></path>
  `).join('');

  return `
    <svg class="face-svg" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <pattern id="face-svg-scanline" width="12" height="6" patternUnits="userSpaceOnUse">
          <rect width="12" height="6" fill="#ffffff"></rect>
          <rect width="12" height="2" fill="#b0b0b0"></rect>
        </pattern>
        <mask id="face-svg-mask">
          <rect x="0" y="0" width="100" height="100" fill="url(#face-svg-scanline)"></rect>
        </mask>
      </defs>
      <g class="face-svg-eyes" mask="url(#face-svg-mask)">
        <path class="face-svg-eye left" d="${escapeAttribute(profile.leftEye)}"></path>
        <path class="face-svg-eye right" d="${escapeAttribute(profile.rightEye)}"></path>
        ${decor}
      </g>
      <g class="face-svg-mouth-group" mask="url(#face-svg-mask)">
        <path class="face-svg-mouth" d="${escapeAttribute(profile.mouth)}"></path>
      </g>
    </svg>
  `;
}

function getFaceProfile(state: AppState): FaceProfile {
  const expression = state.sleeping ? 'sleep' : state.currentExpression;
  if (expression === 'love') {
    return {
      leftEye: heartPath(32, 38, 8),
      rightEye: heartPath(68, 38, 8),
      mouth: 'M 34 68 Q 50 80 66 68',
    };
  }
  if (expression === 'crying') {
    return {
      leftEye: eyeLinePath(24, 38, 16, 4),
      rightEye: eyeLinePath(60, 38, 16, 4),
      mouth: 'M 34 72 Q 50 58 66 72',
      decor: [
        { d: tearPath(31, 45), className: 'tear-left' },
        { d: tearPath(69, 45), className: 'tear-right' },
      ],
    };
  }
  if (expression === 'sleep') {
    return {
      leftEye: eyeLinePath(24, 40, 16, 0),
      rightEye: eyeLinePath(60, 40, 16, 0),
      mouth: 'M 38 66 Q 50 70 62 66',
      decor: [{ d: 'M 72 18 L 80 18 L 74 26 L 82 26', className: 'zzz' }],
    };
  }
  if (expression === 'thinking') {
    return {
      leftEye: 'M 24 42 Q 32 34 40 42',
      rightEye: 'M 60 42 Q 68 34 76 42',
      mouth: 'M 40 68 L 60 68',
    };
  }
  if (expression === 'sad') {
    return {
      leftEye: eyeLinePath(24, 39, 16, 2),
      rightEye: eyeLinePath(60, 39, 16, 2),
      mouth: 'M 36 72 Q 50 60 64 72',
    };
  }
  if (expression === 'angry') {
    return {
      leftEye: 'M 24 42 L 40 36',
      rightEye: 'M 60 36 L 76 42',
      mouth: 'M 38 70 L 62 70',
    };
  }
  if (expression === 'surprised') {
    return {
      leftEye: eyeOvalPath(32, 38, 7, 9),
      rightEye: eyeOvalPath(68, 38, 7, 9),
      mouth: mouthOvalPath(50, 69, 7, 9),
    };
  }
  if (expression === 'happy') {
    return {
      leftEye: eyeSmilePath(24, 36, 16),
      rightEye: eyeSmilePath(60, 36, 16),
      mouth: 'M 32 64 Q 50 82 68 64',
    };
  }
  if (expression === 'smile') {
    return {
      leftEye: eyeOvalPath(32, 38, 8, 7),
      rightEye: eyeOvalPath(68, 38, 8, 7),
      mouth: 'M 34 66 Q 50 76 66 66',
    };
  }
  if (expression === 'listening') {
    return {
      leftEye: eyeOvalPath(32, 38, 8, 9),
      rightEye: eyeOvalPath(68, 38, 8, 9),
      mouth: mouthOvalPath(50, 68, 9, 5),
    };
  }
  if (expression === 'speaking' || state.audioPlaying) {
    return {
      leftEye: eyeOvalPath(32, 38, 8, 7),
      rightEye: eyeOvalPath(68, 38, 8, 7),
      mouth: mouthOvalPath(50, 68, 12, 10),
    };
  }
  if (state.idleVariant === 'flat' || expression === 'idle-flat') {
    return {
      leftEye: eyeOvalPath(32, 38, 8, 6),
      rightEye: eyeOvalPath(68, 38, 8, 6),
      mouth: 'M 38 68 L 62 68',
    };
  }

  return {
    leftEye: eyeOvalPath(32, 38, 8, 7),
    rightEye: eyeOvalPath(68, 38, 8, 7),
    mouth: 'M 38 68 Q 50 70 62 68',
  };
}

function eyeOvalPath(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0`;
}

function mouthOvalPath(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0`;
}

function eyeSmilePath(x: number, y: number, width: number): string {
  return `M ${x} ${y} Q ${x + width / 2} ${y + 6} ${x + width} ${y}`;
}

function eyeLinePath(x: number, y: number, width: number, lift: number): string {
  return `M ${x} ${y} Q ${x + width / 2} ${y + lift} ${x + width} ${y}`;
}

function tearPath(x: number, y: number): string {
  return `M ${x} ${y} C ${x - 2} ${y + 4}, ${x - 1} ${y + 9}, ${x} ${y + 12} C ${x + 2} ${y + 9}, ${x + 3} ${y + 4}, ${x} ${y}`;
}

function heartPath(cx: number, cy: number, size: number): string {
  return [
    `M ${cx} ${cy + size}`,
    `C ${cx - size * 1.3} ${cy + size * 0.2}, ${cx - size * 1.4} ${cy - size * 0.7}, ${cx} ${cy - size * 0.1}`,
    `C ${cx + size * 1.4} ${cy - size * 0.7}, ${cx + size * 1.3} ${cy + size * 0.2}, ${cx} ${cy + size}`,
    'Z',
  ].join(' ');
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
