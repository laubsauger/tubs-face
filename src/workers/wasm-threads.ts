/**
 * WASM threads for the face models. Threads need SharedArrayBuffer, which a
 * page only gets when it is cross-origin isolated (the server sends COOP and
 * COEP headers); otherwise one. Measured in headless Chrome on the Studio Mac
 * (Nov 2026): det_10g 584 ms on one thread, 152 on four, 82 on eight; ArcFace
 * R50 280, 80 and 47 ms per face. Same models, same results. A couple of cores
 * stay free for speech, Ming and the face renderer.
 */
export function wasmThreadsFor(crossOriginIsolated: boolean, cores: number): number {
  return crossOriginIsolated ? Math.max(1, Math.min(8, Math.floor(cores) - 2)) : 1;
}
