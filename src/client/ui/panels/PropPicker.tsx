import { useEffect, useRef, type JSX } from 'react';
import { PROPS, type PropId } from '../../../shared/contracts/config.js';
import { DEFAULT_CONFIG } from '../../glitch/constants.js';
import { restingPropAnchors } from '../../glitch/pixel-grid.js';
import { PROP_TONES, propBounds, rasterizeProp } from '../../glitch/props.js';
import { hexToHSL } from '../../glitch/utils.js';

const LABELS: Record<PropId, string> = {
  none: 'None',
  'party-hat': 'Party hat',
  'top-hat': 'Top hat',
  'witch-hat': 'Witch hat',
  crown: 'Crown',
  'propeller-cap': 'Propeller cap',
  watts: 'Alan Watts',
  'mark-watts': 'Mark Watts',
};

const PREVIEW_W = 44;
const PREVIEW_H = 30;

/**
 * What a head wears, with a small preview in that head's colour. The
 * dashboard has no face of its own to show it on; the face window and the
 * studio streams change live.
 */
export function PropPicker(props: { label: string; value: PropId; color: string; onChange: (prop: PropId) => void }): JSX.Element {
  return (
    <label className="grid grid-cols-[minmax(84px,1fr)_auto_minmax(0,1.3fr)] items-center gap-2 text-xs font-mono">
      <span className="text-slate-400 truncate">{props.label}</span>
      <PropPreview prop={props.value} color={props.color} />
      <select className="mini-select w-full" value={props.value} onChange={(event) => props.onChange(event.currentTarget.value as PropId)}>
        {PROPS.map((prop) => <option key={prop} value={prop}>{LABELS[prop]}</option>)}
      </select>
    </label>
  );
}

/** The prop as the face draws it (glitch/props.ts), on a few pixels, without the face or the glitch effects. */
function PropPreview({ prop, color }: { prop: PropId; color: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(PREVIEW_W * dpr);
    canvas.height = Math.round(PREVIEW_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
    // Where the parts sit on the default face, fitted into the preview.
    const rest = restingPropAnchors(DEFAULT_CONFIG);
    const box = rest && propBounds(prop, rest);
    if (!rest || !box) return;
    const scale = Math.min((PREVIEW_W - 4) / (box.right - box.left), (PREVIEW_H - 4) / (box.bottom - box.top));
    const at = (point: { x: number; y: number }) => ({
      x: PREVIEW_W / 2 + (point.x - (box.left + box.right) / 2) * scale,
      y: PREVIEW_H / 2 + (point.y - (box.top + box.bottom) / 2) * scale,
    });
    // About the face's pixel pitch: some 1.25 face units a pixel.
    const stride = scale * 1.25;
    const base = hexToHSL(color);
    for (const pixel of rasterizeProp(prop, { eyes: at(rest.eyes), lip: at(rest.lip), jaw: at(rest.jaw) }, scale, scale, stride * 0.75, stride * 0.25)) {
      const tone = PROP_TONES[pixel.tone];
      const sat = tone.sat === undefined ? base.s : tone.sat * 100;
      ctx.fillStyle = `hsl(${base.h + tone.hue} ${sat}% ${Math.max(0, Math.min(100, base.l + tone.light))}%)`;
      ctx.fillRect(pixel.x, pixel.y, stride * 0.75, stride * 0.75);
    }
  }, [prop, color]);
  return <canvas ref={canvasRef} aria-hidden="true" style={{ width: PREVIEW_W, height: PREVIEW_H, background: '#000', borderRadius: 4 }} />;
}
