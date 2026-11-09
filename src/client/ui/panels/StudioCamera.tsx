// The studio listener's camera in the dashboard, with the face worker's boxes,
// names and match scores drawn by the same overlay as the face window's
// camera. A site stream is read live over WHEP while it is on screen
// (studio/camera-stream.ts); otherwise, or if that fails, the listener's
// relayed preview pictures (studio_frame). Nothing when there is neither.

import { useEffect, useRef, useState, type JSX } from 'react';
import { drawFaceBoxes } from '../../face/overlay.js';
import { acquireStudioCamera } from '../../studio/camera-stream.js';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';

export function StudioCameraView({ store }: { store: AppStore }): JSX.Element | null {
  const view = useAppSelector(store, (current) => ({
    frame: current.studioFrame,
    faces: current.faceLastFaces,
    width: current.faceFrameWidth,
    height: current.faceFrameHeight,
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
    canvas.width = shown.width;
    canvas.height = shown.height;
    // The boxes are in the detector's picture; what is shown is that camera at another size.
    drawFaceBoxes(canvas, view.faces, { width: view.width ?? shown.width, height: view.height ?? shown.height }, { mirror: false });
  }, [shown, view.faces, view.width, view.height]);

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
      {shown ? <canvas ref={overlayRef} className="camera-overlay" data-faces={view.faces.length} aria-hidden="true" /> : null}
    </>
  );
}
