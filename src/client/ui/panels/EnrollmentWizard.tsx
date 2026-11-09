import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { AppStore } from '../../state/app-state.js';
import type { AppShellControls } from '../app-shell.js';
import { useAppSelector } from '../react-store.js';
import { StudioCameraView } from './StudioCamera.js';
import { deviceView } from '../../studio/live-view.js';

type FaceControls = NonNullable<AppShellControls['face']>;
type Mode = 'guided' | 'quick';
type Phase = 'setup' | 'capture' | 'review' | 'saving' | 'done' | 'error';

interface Pose {
  text: string;
  hint: string;
  icon: string;
}

interface Sample {
  embedding: number[];
  thumbnail: string;
  duplicate: boolean;
  discarded: boolean;
}

interface Banner {
  kind: 'intro' | 'pose' | 'countdown' | 'snap' | 'warn' | 'error' | 'review' | 'saving' | 'done';
  icon: string;
  text: string;
  hint?: string;
  count?: number;
}

// Same poses and timing as main's enrollment wizard.
const GUIDED_POSES: Pose[] = [
  { text: 'Look straight at the camera', hint: 'Face forward, eyes on the lens', icon: '😐' },
  { text: 'Now turn your head left', hint: 'Just slightly, like checking your shoulder', icon: '⬅️' },
  { text: 'Turn your head right', hint: 'Mirror what you just did, other side', icon: '➡️' },
  { text: 'Tilt your head up a bit', hint: "Like you're looking at a tall shelf", icon: '⬆️' },
  { text: 'Tilt your head down', hint: 'Like reading your phone', icon: '⬇️' },
];
const QUICK_POSES: Pose[] = [{ text: 'Look at the camera', hint: 'Hold still for the snap', icon: '📸' }];

const POSE_READ_MS = 1200;
const COUNTDOWN_STEP_MS = 800;
const RETRY_MESSAGE_MS = 1500;
const AUTO_SAVE_SECONDS = 10;
const MAX_DUPLICATE_RETRIES = 1;
// Main retried a pose forever; after this many misses we skip it instead.
const MAX_MISSED_RETRIES = 3;

class Cancelled extends Error {}

/**
 * Face onboarding, ported from main's wizard: full-screen live camera, one pose
 * at a time with a 3-2-1 countdown and sounds, a strip of captured shots you
 * can click to drop, then an auto-save countdown. Name and mode are picked in
 * the dialog instead of main's browser prompt() and confirm().
 */
export function EnrollmentWizard({ store, controls }: { store: AppStore; controls?: FaceControls }): JSX.Element | null {
  const open = useAppSelector(store, (state) => state.faceEnrollOpen);
  if (!open || !controls || typeof document === 'undefined') {
    return null;
  }
  return createPortal(<WizardDialog store={store} controls={controls} />, document.body);
}

function WizardDialog({ store, controls }: { store: AppStore; controls: FaceControls }): JSX.Element {
  const camera = useAppSelector(store, (state) => ({
    // In studio mode the studio listener's camera and face worker (live-view.ts).
    active: deviceView(state).faceCameraActive,
    workerReady: deviceView(state).faceWorkerReady,
    // The dashboard in studio mode: the studio listener's camera, its pictures relayed.
    studio: state.studioLive !== null,
  }));
  const [name, setName] = useState(() => initialName(store));
  const [mode, setMode] = useState<Mode>('guided');
  const [phase, setPhase] = useState<Phase>('setup');
  const [banner, setBanner] = useState<Banner>(INTRO_BANNER);
  const [bannerKey, setBannerKey] = useState(0);
  const [pose, setPose] = useState<{ index: number; count: number } | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [secondsLeft, setSecondsLeft] = useState(AUTO_SAVE_SECONDS);
  const [flashKey, setFlashKey] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const runRef = useRef({ cancelled: false });
  const enrollingRef = useRef(false);
  const closeTimerRef = useRef<number | undefined>(undefined);

  const show = useCallback((next: Banner) => {
    setBanner(next);
    setBannerKey((key) => key + 1);
  }, []);

  const close = useCallback(() => {
    runRef.current.cancelled = true;
    window.clearTimeout(closeTimerRef.current);
    if (enrollingRef.current) {
      enrollingRef.current = false;
      controls.endEnrollment();
    }
    store.setState((current) => ({ ...current, faceEnrollOpen: false }));
  }, [controls, store]);

  // Show the same camera stream the face worker uses.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const stream = camera.active ? controls.getCameraStream() : null;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
  }, [camera.active, controls]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phase !== 'saving') {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close, phase]);

  useEffect(() => () => {
    // Unmounted from outside (e.g. the store flag cleared): stop the run.
    runRef.current.cancelled = true;
    window.clearTimeout(closeTimerRef.current);
    if (enrollingRef.current) {
      enrollingRef.current = false;
      controls.endEnrollment();
    }
  }, [controls]);

  const save = useCallback(async (current: Sample[]) => {
    const keep = current.filter((sample) => !sample.discarded);
    if (keep.length === 0) {
      sounds.fail();
      setPhase('error');
      show({ kind: 'error', icon: '🗑️', text: 'All shots discarded', hint: 'Nothing was saved. Try again?' });
      return;
    }
    setPhase('saving');
    show({ kind: 'saving', icon: '💾', text: 'Saving…', hint: `${keep.length} shot${keep.length === 1 ? '' : 's'} of ${name.trim()}` });
    try {
      const saved = await controls.saveEnrollment(name, keep);
      sounds.success();
      setPhase('done');
      show({ kind: 'done', icon: '🎉', text: `Got it, ${name.trim()}!`, hint: `${saved} shot${saved === 1 ? '' : 's'} saved. Tubs knows your face now.` });
      window.dispatchEvent(new CustomEvent('tubs:face-enrolled', { detail: { name: name.trim() } }));
      closeTimerRef.current = window.setTimeout(close, 2400);
    } catch (error) {
      sounds.fail();
      setPhase('error');
      show({ kind: 'error', icon: '⚠️', text: 'Saving failed', hint: error instanceof Error ? error.message : String(error) });
    }
  }, [close, controls, name, show]);

  // Review: auto-save after a countdown; clicking a shot restarts it.
  useEffect(() => {
    if (phase !== 'review') return undefined;
    if (secondsLeft <= 0) {
      void save(samples);
      return undefined;
    }
    const timer = window.setTimeout(() => setSecondsLeft((left) => left - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [phase, samples, save, secondsLeft]);

  const run = useCallback(async () => {
    const token = { cancelled: false };
    runRef.current = token;
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      window.setTimeout(() => (token.cancelled ? reject(new Cancelled()) : resolve()), ms);
    });
    const poses = mode === 'guided' ? GUIDED_POSES : QUICK_POSES;
    const collected: Sample[] = [];
    setSamples([]);
    setPhase('capture');
    enrollingRef.current = true;
    controls.beginEnrollment();
    try {
      for (const [index, current] of poses.entries()) {
        let duplicateRetries = 0;
        let missedRetries = 0;
        for (;;) {
          setPose({ index, count: poses.length });
          sounds.newPose();
          show({ kind: 'pose', icon: current.icon, text: current.text, hint: current.hint });
          await wait(POSE_READ_MS);
          for (let count = 3; count > 0; count -= 1) {
            sounds.tick();
            show({ kind: 'countdown', icon: current.icon, text: current.text, count });
            await wait(COUNTDOWN_STEP_MS);
          }
          sounds.shutter();
          setFlashKey((key) => key + 1);
          show({ kind: 'snap', icon: current.icon, text: 'SNAP!' });

          const keepEmbeddings = collected.filter((sample) => !sample.discarded).map((sample) => sample.embedding);
          const capture = await controls.captureEnrollmentSample(keepEmbeddings);
          if (token.cancelled) throw new Cancelled();

          if (!capture) {
            sounds.fail();
            missedRetries += 1;
            if (missedRetries > MAX_MISSED_RETRIES) {
              show({ kind: 'warn', icon: '⏭️', text: 'Skipping this pose', hint: "Couldn't find exactly one face" });
              await wait(900);
              break;
            }
            show({ kind: 'error', icon: '🙈', text: 'No face detected!', hint: 'Make sure only your face is in view, then hold still' });
            await wait(RETRY_MESSAGE_MS);
            continue;
          }
          if (capture.duplicate && duplicateRetries < MAX_DUPLICATE_RETRIES) {
            duplicateRetries += 1;
            sounds.fail();
            show({ kind: 'warn', icon: '🔁', text: 'Too similar!', hint: 'Move your head more, retrying this pose' });
            await wait(RETRY_MESSAGE_MS);
            continue;
          }

          collected.push({ ...capture, discarded: capture.duplicate });
          setSamples([...collected]);
          if (capture.duplicate) {
            show({ kind: 'warn', icon: '🤷', text: 'Still similar, keeping it off', hint: 'Click it later if you want it in' });
            await wait(900);
          } else {
            sounds.success();
          }
          break;
        }
      }
    } catch (error) {
      if (error instanceof Cancelled) return;
      sounds.fail();
      setPhase('error');
      show({ kind: 'error', icon: '⚠️', text: 'Capture failed', hint: error instanceof Error ? error.message : String(error) });
      return;
    } finally {
      if (enrollingRef.current) {
        enrollingRef.current = false;
        controls.endEnrollment();
      }
    }

    setPose(null);
    if (collected.length === 0) {
      setPhase('error');
      show({ kind: 'error', icon: '🙈', text: 'No usable shots', hint: 'Check the lighting and that only one person is in view' });
      return;
    }
    setSecondsLeft(AUTO_SAVE_SECONDS);
    setPhase('review');
    show({ kind: 'review', icon: '✅', text: 'Check the shots', hint: 'Click a bad one to drop it' });
  }, [controls, mode, show]);

  const canStart = Boolean(name.trim()) && camera.active && camera.workerReady;
  const start = () => {
    if (!canStart) return;
    store.setState((current) => ({ ...current, faceDraftName: name.trim() }));
    void run();
  };
  const restart = () => {
    setPhase('setup');
    setSamples([]);
    setPose(null);
    show(INTRO_BANNER);
  };
  const toggleSample = (index: number) => {
    setSamples((current) => current.map((sample, i) => (i === index ? { ...sample, discarded: !sample.discarded } : sample)));
    setSecondsLeft(AUTO_SAVE_SECONDS);
  };

  return (
    <div className="enroll-backdrop" role="presentation">
      <div className={`enroll-dialog is-${phase}`} role="dialog" aria-modal="true" aria-label="Face onboarding">
        <header key={bannerKey} className={`enroll-instruction is-${banner.kind}`}>
          <span className="enroll-icon" aria-hidden="true">{banner.icon}</span>
          <div className="enroll-text">
            <span className="enroll-main">{banner.text}</span>
            {banner.kind === 'countdown' ? <span className="enroll-countdown">{banner.count}</span> : null}
            {banner.hint && banner.kind !== 'countdown' ? <span className="enroll-hint">{banner.hint}</span> : null}
          </div>
          <button type="button" className="enroll-close" aria-label="Cancel onboarding" disabled={phase === 'saving'} onClick={close}>✕</button>
        </header>

        <div className="enroll-status" aria-live="polite">
          {phase === 'capture' && pose ? `Pose ${pose.index + 1} of ${pose.count}` : null}
          {phase === 'review' ? <>Auto-saving in <strong>{secondsLeft}s</strong>, click bad shots to discard</> : null}
          {phase === 'setup' ? (camera.active ? (camera.workerReady ? 'Camera ready' : 'Loading face model…') : 'Camera is off') : null}
        </div>

        <div className="enroll-stage">
          <video ref={videoRef} className={`enroll-video ${camera.studio ? 'is-hidden' : ''}`} autoPlay muted playsInline />
          {camera.studio ? <div className="enroll-video enroll-studio-camera"><StudioCameraView store={store} /></div> : null}
          {flashKey > 0 ? <div key={flashKey} className="enroll-flash" aria-hidden="true" /> : null}

          {!camera.active ? (
            <div className="enroll-camera-off">
              <p>The camera is off.</p>
              {camera.studio
                ? <p>The studio camera is the vision source: choose one in the Studio tab.</p>
                : <button type="button" className="enroll-btn enroll-btn-primary" onClick={() => void controls.toggleCamera()}>Start camera</button>}
            </div>
          ) : null}

          {phase === 'setup' && camera.active ? (
            <form
              className="enroll-setup"
              onSubmit={(event) => {
                event.preventDefault();
                start();
              }}
            >
              <label className="enroll-name">
                <span>Who's this?</span>
                <input
                  autoFocus
                  type="text"
                  value={name}
                  placeholder="Name"
                  maxLength={48}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </label>
              <div className="enroll-modes" role="radiogroup" aria-label="Capture mode">
                <button type="button" role="radio" aria-checked={mode === 'guided'} className={mode === 'guided' ? 'is-selected' : ''} onClick={() => setMode('guided')}>
                  <strong>Guided</strong>
                  <span>5 poses, best recognition</span>
                </button>
                <button type="button" role="radio" aria-checked={mode === 'quick'} className={mode === 'quick' ? 'is-selected' : ''} onClick={() => setMode('quick')}>
                  <strong>Quick</strong>
                  <span>1 photo</span>
                </button>
              </div>
              <button type="submit" className="enroll-btn enroll-btn-primary" disabled={!canStart}>Start</button>
            </form>
          ) : null}

          {samples.length > 0 ? (
            <div className="enroll-strip">
              {samples.map((sample, index) => (
                <button
                  key={sample.thumbnail}
                  type="button"
                  className={`enroll-thumb ${sample.duplicate ? 'is-duplicate' : ''} ${sample.discarded ? 'is-discarded' : ''}`}
                  aria-pressed={!sample.discarded}
                  aria-label={`Shot ${index + 1}${sample.discarded ? ', discarded' : ''}`}
                  disabled={phase !== 'capture' && phase !== 'review'}
                  onClick={() => toggleSample(index)}
                >
                  <img src={sample.thumbnail} alt="" />
                </button>
              ))}
            </div>
          ) : null}

          {phase === 'review' ? (
            <div className="enroll-actions">
              <button type="button" className="enroll-btn" onClick={close}>Discard all</button>
              <button type="button" className="enroll-btn enroll-btn-primary" onClick={() => void save(samples)}>Save face</button>
            </div>
          ) : null}

          {phase === 'error' ? (
            <div className="enroll-actions">
              <button type="button" className="enroll-btn" onClick={close}>Close</button>
              <button type="button" className="enroll-btn enroll-btn-primary" onClick={restart}>Try again</button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const INTRO_BANNER: Banner = {
  kind: 'intro',
  icon: '📸',
  text: 'Teach Tubs a face',
  hint: 'Pick a name and a mode, then follow the prompts',
};

function initialName(store: AppStore): string {
  const state = store.getState();
  // Someone already recognised in front of the camera is most likely who is
  // being re-enrolled.
  return state.faceLastFaces.find((face) => face.name)?.name ?? state.faceDraftName ?? '';
}

// Short synth blips, same tones as main.
const sounds = (() => {
  let context: AudioContext | null = null;
  const tone = (freq: number, endFreq: number, duration: number, type: OscillatorType = 'square', volume = 0.1) => {
    try {
      context ??= new AudioContext();
      if (context.state === 'suspended') void context.resume();
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.connect(gain);
      gain.connect(context.destination);
      osc.type = type;
      const now = context.currentTime;
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + duration);
      osc.start();
      osc.stop(now + duration + 0.02);
    } catch {
      // No audio output available; the wizard still works silently.
    }
  };
  return {
    shutter: () => tone(800, 1200, 0.05),
    tick: () => tone(440, 440, 0.04, 'sine', 0.06),
    newPose: () => tone(600, 900, 0.12, 'sine', 0.12),
    success: () => tone(800, 1600, 0.15, 'sine', 0.1),
    fail: () => tone(300, 200, 0.2, 'sawtooth', 0.08),
  };
})();
