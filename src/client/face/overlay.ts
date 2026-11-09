// Face boxes over a picture: green for a recognised face, orange for an
// unknown one, a glowing box with corner accents and a label pill (name and
// how sure). The camera preview draws them mirrored, like its video; the
// Studio tab's vision thumbnail as the picture was taken.

import type { StudioLiveFace } from '../../shared/contracts/studio.js';

export function drawFaceBoxes(
  canvas: HTMLCanvasElement,
  faces: ReadonlyArray<StudioLiveFace>,
  source: { width: number; height: number },
  options: { mirror: boolean },
): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const scaleX = canvas.width / Math.max(1, source.width || canvas.width);
  const scaleY = canvas.height / Math.max(1, source.height || canvas.height);

  for (const face of faces) {
    const [x1, y1, x2, y2] = face.box;
    const width = (x2 - x1) * scaleX;
    const height = (y2 - y1) * scaleY;
    const left = options.mirror ? canvas.width - (x2 * scaleX) : x1 * scaleX;
    const top = y1 * scaleY;
    const name = face.name ?? face.match?.name ?? null;
    const color = name ? '#34d399' : '#fb923c';

    context.shadowColor = color;
    context.shadowBlur = 8;
    context.lineWidth = 3;
    context.strokeStyle = color;
    context.strokeRect(left, top, width, height);
    context.shadowBlur = 0;

    const corner = Math.min(12, width * 0.2, height * 0.2);
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(left, top + corner); context.lineTo(left, top); context.lineTo(left + corner, top);
    context.moveTo(left + width - corner, top); context.lineTo(left + width, top); context.lineTo(left + width, top + corner);
    context.moveTo(left, top + height - corner); context.lineTo(left, top + height); context.lineTo(left + corner, top + height);
    context.moveTo(left + width - corner, top + height); context.lineTo(left + width, top + height); context.lineTo(left + width, top + height - corner);
    context.stroke();

    const label = faceLabel(face);
    context.font = 'bold 12px Outfit, system-ui, sans-serif';
    const labelWidth = context.measureText(label).width + 10;
    const labelTop = Math.max(0, top - 20);
    context.fillStyle = name ? 'rgba(52, 211, 153, 0.85)' : 'rgba(251, 146, 60, 0.8)';
    context.fillRect(left, labelTop, labelWidth, 20);
    context.fillStyle = '#04121c';
    context.fillText(label, left + 5, labelTop + 15);
  }
}

/** "Flo 87%" for a recognised face (the match's certainty), "64%" (detection) for an unknown one. */
export function faceLabel(face: StudioLiveFace): string {
  const name = face.name ?? face.match?.name ?? null;
  const score = Math.round((face.match?.score ?? face.confidence ?? face.score) * 100);
  return name ? `${name} ${score}%` : `${score}%`;
}

/** What leaves the page about a face: box, scores and the top candidates; no embedding or landmarks. */
export function liveFaceOf(face: StudioLiveFace): StudioLiveFace {
  const match = (entry: { name?: string; score: number }) => ({ ...(entry.name !== undefined ? { name: entry.name.slice(0, 80) } : {}), score: entry.score });
  return {
    box: [face.box[0], face.box[1], face.box[2], face.box[3]],
    score: face.score,
    ...(face.confidence !== undefined ? { confidence: face.confidence } : {}),
    ...(face.name !== undefined ? { name: face.name ? face.name.slice(0, 80) : face.name } : {}),
    ...(face.match ? { match: match(face.match) } : {}),
    ...(face.matches?.length ? { matches: face.matches.slice(0, 3).map(match) } : {}),
  };
}
