// The studio listener's camera in a page without one of its own (the
// dashboard; the operator face window in studio mode), with the face
// worker's boxes, names and match scores drawn by the same overlay as the
// face window's camera; in debug view also the detection score and the
// decision. A site stream is read live over WHEP while it is on screen
// (studio/camera-stream.ts); otherwise, or if that fails, the listener's
// relayed preview pictures (studio_frame). Nothing when there is neither.

import { useEffect, useRef, useState, type JSX } from 'react';
import { drawFaceBoxes, drawableFace } from '../../face/overlay.js';
import { acquireStudioCamera } from '../../studio/camera-stream.js';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';

// One empty list: a new [] on every read would re-render without end.
const NO_FACES: never[] = [];

export function StudioCameraView({ store, detail = false }: { store: AppStore; detail?: boolean }): JSX.Element | null {
  const view = useAppSelector(store, (current) => ({
    frame: current.studioFrame,
    // Whichever producer runs (docs/face-service.md); the listener's own faces before the first observation.
    observation: current.studioObservation,
    faces: current.studioLive?.status.faceLastFaces ?? NO_FACES,
    width: current.studioLive?.status.faceFrameWidth ?? null,
    height: current.studioLive?.status.faceFrameHeight ?? null,
    url: current.studioVideoWanted && current.studioLive ? current.studioCameraUrl : null,
  }));
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!view.url) return undefined;
    const camera = acquireStudioCamera(view.url);
    let cancelled = false;
    camera.stream.then((stream) => {
      const video = videoRef.current;
      if (cancelled || !video) return;
      video.srcObject = stream;
      void video.play().catch(() => {});
      setLive(true);
    }).catch(() => {
      // Not reachable from here (another machine, a read login): the relayed pictures stay.
    });
    return () => {
      cancelled = true;
      if (videoRef.current) videoRef.current.srcObject = null;
      setLive(false);
      camera.release();
    };
  }, [view.url]);

  const shown = live && videoSize ? videoSize : view.frame;
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !shown) return;
    // As many canvas pixels as screen pixels, in the picture's shape: the labels read at their size.
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || shown.width;
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(canvas.width * (shown.height / shown.width));
    // The boxes are in the detector's picture; what is shown is that camera at another size.
    const observation = view.observation;
    if (observation && observation.frame.w > 0) {
      drawFaceBoxes(canvas, observation.faces.map((face) => drawableFace(face, observation.frame)), { width: observation.frame.w, height: observation.frame.h }, { mirror: false, detail, pixelRatio: ratio });
    } else {
      drawFaceBoxes(canvas, view.faces, { width: view.width ?? shown.width, height: view.height ?? shown.height }, { mirror: false, detail, pixelRatio: ratio });
    }
  }, [shown, view.observation, view.faces, view.width, view.height, detail]);

  if (!view.frame && !view.url) return null;
  return (
    <>
      {view.url ? (
        <video
          ref={videoRef}
          className={`camera-video studio-camera-picture ${live ? '' : 'is-hidden'}`}
          aria-label="The studio camera, live"
          autoPlay
          muted
          playsInline
          onLoadedMetadata={(event) => setVideoSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })}
        />
      ) : null}
      {view.frame && !live ? <img className="camera-video studio-camera-picture" src={view.frame.src} alt="What the studio camera sees" /> : null}
      {shown ? <canvas ref={overlayRef} className="camera-overlay" data-faces={view.observation ? view.observation.faces.length : view.faces.length} aria-hidden="true" /> : null}
    </>
  );
}
