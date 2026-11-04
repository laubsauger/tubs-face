import type { WsClientMessage } from '../../shared/contracts/ws.js';
import type { AppStore } from '../state/app-state.js';
import { IDLE_SETTLE_MS } from '../behavior/emotion-runtime.js';
import { createGazeController, nearestFaceIndex, type GazeSample } from './gaze.js';

const BLINK_MIN_MS = 3800;
const BLINK_MAX_MS = 6400;
const BEHAVIOR_MIN_MS = 3600;
const BEHAVIOR_MAX_MS = 5800;
const WANDER_X_RANGE = 0.32;
const WANDER_Y_RANGE = 0.2;
// Idle life: now and then a smile that lasts, instead of a flip every few seconds.
const IDLE_SMILE_CHANCE = 0.15;
const IDLE_SMILE_MIN_MS = 2500;
const IDLE_SMILE_MAX_MS = 5000;
const WANDER_CHANCE = 0.2;
// A wander holds long enough to read as a look, and doesn't come back to back.
const WANDER_HOLD_MIN_MS = 1500;
const WANDER_HOLD_MAX_MS = 4000;
const WANDER_MIN_GAP_MS = 10_000;
const INPUT_DEADZONE = 0.035;
const INPUT_SHAPE_EXPONENT = 0.82;
// With several people in view, stay with each one for a while.
const FACE_TARGET_SWITCH_MIN_MS = 2500;
const FACE_TARGET_SWITCH_MAX_MS = 6000;
const PARTNER_MOTION_IDLE_BLOCK_MS = 1800;
const PARTNER_BLINK_MIN_GAP_MS = 900;
// The partner's motion arrives ~30 times a second while its eyes move. Small
// reacts once they come to rest, and only sometimes, so the two don't mirror.
const PARTNER_SETTLE_MS = 200;
const PARTNER_GLANCE_CHANCE = 0.35;
const MICRO_SACCADE_INTERVAL_MS = 1500;
const MICRO_SACCADE_MAX_INTERVAL_MS = 3500;
// Barely visible on purpose: a still eye looks dead, a twitchy one nervous.
const MICRO_SACCADE_AMPLITUDE = 0.018;
// People look away while working out what to say and back when they start
// talking. A face that stares while "thinking" reads as a frozen screen.
const THINKING_GAZE_CHANCE = 0.7;
const THINKING_GAZE_X = 0.5;
const THINKING_GAZE_Y = -0.4;
// face_motion feeds the partner face and spectators over the network; ~30 Hz is
// smooth there and halves the traffic of sending every animation frame.
const MOTION_SEND_INTERVAL_MS = 33;

export interface FaceBehaviorRuntime {
  bind(root: HTMLElement): void;
  init(): void;
  dispose(): void;
  attachSender(sender: ((message: WsClientMessage) => void) | null): void;
}

export function createFaceBehaviorRuntime(store: AppStore, mode: 'main' | 'mini'): FaceBehaviorRuntime {
  let rootEl: HTMLElement | null = null;
  let blinkTimer: number | null = null;
  let behaviorTimer: number | null = null;
  let lookResetTimer: number | null = null;
  let smileResetTimer: number | null = null;
  let rafId: number | null = null;
  let sender: ((message: WsClientMessage) => void) | null = null;
  // One model drives the eyes; the renderer draws its output as is.
  const gaze = createGazeController();
  const gazeSample: GazeSample = { x: 0, y: 0, moving: false };
  let lastPointerAt = 0;
  // Centre of the face being looked at, in camera frame pixels.
  let activeFaceX = Number.NaN;
  let activeFaceY = Number.NaN;
  let nextFaceSwitchAt = 0;
  let lastWanderAt = Number.NEGATIVE_INFINITY;
  // When the face last came back to idle; idle smiles wait for it to settle.
  let idleSince = Date.now();
  let partnerMotionAt = 0;
  let partnerX = 0;
  let partnerY = 0;
  let partnerSettleTimer: number | null = null;
  let partnerGlanceTimer: number | null = null;
  let partnerBlinkTimer: number | null = null;
  let lastPartnerBlinkAt = 0;
  let partnerMotionHandler: ((event: Event) => void) | null = null;
  let partnerBlinkHandler: ((event: Event) => void) | null = null;
  let microSaccadeTimer: number | null = null;
  let lastMotionSentAt = 0;
  let lastSentX = Number.NaN;
  let lastSentY = Number.NaN;
  let thinkingGazeTimer: number | null = null;
  let thinkingGaze = false;

  return {
    bind(root: HTMLElement): void {
      rootEl = root.querySelector<HTMLElement>('.visual-shell');
      if (!rootEl) {
        return;
      }

      rootEl.onpointermove = (event) => {
        // Face bounding box takes priority over mouse cursor
        if (hasTrackedFaces()) {
          return;
        }
        const rect = rootEl?.getBoundingClientRect();
        if (!rect) {
          return;
        }
        const normalizedX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const normalizedY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
        lastPointerAt = Date.now();
        trackTarget(normalizedX * 0.8, normalizedY * 0.6);
      };

      rootEl.onpointerleave = () => {
        if (hasTrackedFaces()) {
          return;
        }
        resetGaze();
      };
    },
    init(): void {
      attachPartnerHandlers();
      scheduleBlink();
      scheduleBehavior();
      scheduleMicroSaccade();
      resetGaze();

      store.subscribeSelector(
        (state) => state.currentExpression === 'thinking',
        (thinking) => (thinking ? startThinkingGaze() : endThinkingGaze()),
        { fireImmediately: false },
      );

      store.subscribeSelector(
        (state) => state.currentExpression === 'idle',
        (idle) => {
          if (idle) {
            idleSince = Date.now();
          }
        },
        { fireImmediately: false },
      );

      // Start face tracking animation immediately when faces appear
      store.subscribeSelector(
        (state) => state.faceLastFaces,
        () => {
          if (hasTrackedFaces()) {
            steerTowardDetectedFace();
            startAnimationLoop();
          }
        },
        { fireImmediately: false },
      );
    },
    attachSender(nextSender): void {
      sender = nextSender;
    },
    dispose(): void {
      clearManagedTimer(blinkTimer);
      clearManagedTimer(behaviorTimer);
      clearManagedTimer(lookResetTimer);
      clearManagedTimer(smileResetTimer);
      clearManagedTimer(partnerBlinkTimer);
      clearManagedTimer(partnerSettleTimer);
      clearManagedTimer(partnerGlanceTimer);
      clearManagedTimer(microSaccadeTimer);
      clearManagedTimer(thinkingGazeTimer);
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (rootEl) {
        rootEl.onpointermove = null;
        rootEl.onpointerleave = null;
      }
      detachPartnerHandlers();
    },
  };

  function shouldAnimate(): boolean {
    const state = store.getState();
    return !state.sleeping && !state.audioPlaying;
  }

  function shouldIdleAnimate(): boolean {
    const state = store.getState();
    // While the FX editor previews an expression, idle smiles would override it.
    return shouldAnimate() && state.currentExpression === 'idle' && !state.fxEditorOpen;
  }

  function hasTrackedFaces(): boolean {
    const state = store.getState();
    return Boolean(state.faceCameraActive && state.faceLastFaces.length > 0 && state.faceFrameWidth && state.faceFrameHeight);
  }

  function scheduleBlink(): void {
    clearManagedTimer(blinkTimer);
    blinkTimer = window.setTimeout(() => {
      if (shouldAnimate()) {
        blink();
      }
      scheduleBlink();
    }, randBetween(BLINK_MIN_MS, BLINK_MAX_MS));
  }

  function scheduleBehavior(): void {
    clearManagedTimer(behaviorTimer);
    behaviorTimer = window.setTimeout(() => {
      if (shouldIdleAnimate()) {
        runBehaviorStep();
      }
      scheduleBehavior();
    }, randBetween(BEHAVIOR_MIN_MS, BEHAVIOR_MAX_MS));
  }

  function runBehaviorStep(): void {
    const tracking = hasTrackedFaces();

    // Steer toward detected face (updates gaze target)
    if (tracking) {
      steerTowardDetectedFace();
    }

    if (!tracking && mode === 'mini' && Date.now() - partnerMotionAt <= PARTNER_MOTION_IDLE_BLOCK_MS) {
      return;
    }

    const action = chooseIdleAction(Math.random(), {
      tracking,
      idleForMs: Date.now() - idleSince,
      sinceWanderMs: Date.now() - lastWanderAt,
    });
    if (action === 'smile') {
      store.setState((current) => ({
        ...current,
        currentExpression: 'smile',
      }));
      clearManagedTimer(smileResetTimer);
      smileResetTimer = window.setTimeout(() => {
        const state = store.getState();
        if (!shouldAnimate() || state.currentExpression !== 'smile' || state.fxEditorOpen) {
          return;
        }
        store.setState((current) => ({
          ...current,
          currentExpression: 'idle',
        }));
      }, randBetween(IDLE_SMILE_MIN_MS, IDLE_SMILE_MAX_MS));
      return;
    }

    if (action === 'wander') {
      lastWanderAt = Date.now();
      const nextX = (Math.random() * 2 - 1) * WANDER_X_RANGE;
      const nextY = (Math.random() * 2 - 1) * WANDER_Y_RANGE;
      lookAt(nextX, nextY);
      clearManagedTimer(lookResetTimer);
      lookResetTimer = window.setTimeout(() => {
        resetGaze();
      }, randBetween(WANDER_HOLD_MIN_MS, WANDER_HOLD_MAX_MS));
    }
  }

  function startThinkingGaze(): void {
    if (store.getState().sleeping || Math.random() >= THINKING_GAZE_CHANCE) {
      return;
    }
    clearManagedTimer(thinkingGazeTimer);
    thinkingGazeTimer = window.setTimeout(() => {
      thinkingGazeTimer = null;
      thinkingGaze = true;
      const side = Math.random() < 0.5 ? -1 : 1;
      lookAt(side * THINKING_GAZE_X, THINKING_GAZE_Y);
    }, randBetween(120, 320));
  }

  function endThinkingGaze(): void {
    clearManagedTimer(thinkingGazeTimer);
    thinkingGazeTimer = null;
    if (!thinkingGaze) {
      return;
    }
    thinkingGaze = false;
    if (!steerTowardDetectedFace()) {
      resetGaze();
    }
  }

  function scheduleMicroSaccade(): void {
    clearManagedTimer(microSaccadeTimer);
    microSaccadeTimer = window.setTimeout(() => {
      if (shouldAnimate() && hasTrackedFaces() && !thinkingGaze) {
        // Small involuntary eye movements while fixating on a face
        gaze.microSaccade(
          (Math.random() * 2 - 1) * MICRO_SACCADE_AMPLITUDE,
          (Math.random() * 2 - 1) * MICRO_SACCADE_AMPLITUDE,
          performance.now(),
        );
        startAnimationLoop();
      }
      scheduleMicroSaccade();
    }, randBetween(MICRO_SACCADE_INTERVAL_MS, MICRO_SACCADE_MAX_INTERVAL_MS));
  }

  function blink(): void {
    sender?.({
      type: 'face_blink',
      actor: mode === 'mini' ? 'small' : 'main',
      ts: Date.now(),
    });
    store.setState((current) => ({
      ...current,
      blinkActive: true,
      lastBlinkAt: Date.now(),
    }));
    window.setTimeout(() => {
      store.setState((current) => ({
        ...current,
        blinkActive: false,
      }));
    }, randBetween(95, 184));
  }

  function attachPartnerHandlers(): void {
    if (mode !== 'mini' || partnerMotionHandler || partnerBlinkHandler) {
      return;
    }

    partnerMotionHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ x?: number; y?: number; ts?: number }>).detail;
      if (!detail || store.getState().sleeping) {
        return;
      }
      if (typeof detail.x !== 'number' || typeof detail.y !== 'number') {
        return;
      }
      partnerX = detail.x;
      partnerY = detail.y;
      clearManagedTimer(partnerSettleTimer);
      partnerSettleTimer = window.setTimeout(() => {
        partnerSettleTimer = null;
        // De-sync: only sometimes look where the partner looks, and late.
        if (Math.random() > PARTNER_GLANCE_CHANCE) {
          return;
        }
        partnerMotionAt = Date.now();
        clearManagedTimer(partnerGlanceTimer);
        partnerGlanceTimer = window.setTimeout(() => {
          partnerGlanceTimer = null;
          if (store.getState().sleeping) {
            return;
          }
          // Add some jitter so they don't look EXACTLY at the same coordinate footprint
          const jitterX = (Math.random() - 0.5) * 0.15;
          const jitterY = (Math.random() - 0.5) * 0.15;
          lookAt(partnerX + jitterX, partnerY + jitterY);
        }, randBetween(400, 1800));
      }, PARTNER_SETTLE_MS);
    };

    partnerBlinkHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ ts?: number }>).detail;
      if (store.getState().sleeping) {
        return;
      }
      const now = Number(detail?.ts) || Date.now();
      if (now - lastPartnerBlinkAt < PARTNER_BLINK_MIN_GAP_MS) {
        return;
      }
      
      // De-sync: Extremely rarely blink in sync (10% chance instead of 65%)
      if (Math.random() < 0.90) {
        return;
      }
      clearManagedTimer(partnerBlinkTimer);
      partnerBlinkTimer = window.setTimeout(() => {
        partnerBlinkTimer = null;
        lastPartnerBlinkAt = Date.now();
        blink();
      }, randBetween(150, 750));
    };

    window.addEventListener('tubs:partner-face-motion', partnerMotionHandler as EventListener);
    window.addEventListener('tubs:partner-face-blink', partnerBlinkHandler as EventListener);
  }

  function detachPartnerHandlers(): void {
    if (partnerMotionHandler) {
      window.removeEventListener('tubs:partner-face-motion', partnerMotionHandler as EventListener);
      partnerMotionHandler = null;
    }
    if (partnerBlinkHandler) {
      window.removeEventListener('tubs:partner-face-blink', partnerBlinkHandler as EventListener);
      partnerBlinkHandler = null;
    }
  }

  /** A deliberate look: wander, thinking, back to centre, another person. */
  function lookAt(x: number, y: number): void {
    gaze.lookAt(easeInput(x), easeInput(y), performance.now());
    startAnimationLoop();
  }

  /** A continuous, noisy target (face box, pointer); the gaze model filters it. */
  function trackTarget(x: number, y: number): void {
    gaze.track(easeInput(x), easeInput(y), performance.now());
    startAnimationLoop();
  }

  function resetGaze(): void {
    lookAt(0, 0);
  }

  function startAnimationLoop(): void {
    if (rafId != null) {
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function tick(nowMs: number): void {
    // Always steer toward detected face when camera has one;
    // fall back to face tracking when mouse has been idle for 1.2s.
    if (hasTrackedFaces() || Date.now() - lastPointerAt > 1200) {
      steerTowardDetectedFace();
    }

    gaze.sample(nowMs, gazeSample);
    const settled = !gazeSample.moving;
    const state = store.getState();
    if (state.gazeX !== gazeSample.x || state.gazeY !== gazeSample.y) {
      store.setState((current) => ({
        ...current,
        gazeX: gazeSample.x,
        gazeY: gazeSample.y,
      }));
    }
    sendMotion(settled);

    // Keep the loop alive while tracking faces so we pick up bounding box changes
    if (settled && !hasTrackedFaces()) {
      rafId = null;
      return;
    }

    rafId = requestAnimationFrame(tick);
  }

  /** Throttled while moving; the resting point is always sent so remote faces land on it. */
  function sendMotion(settled: boolean): void {
    if (!sender) {
      return;
    }
    const x = Number(gazeSample.x.toFixed(4));
    const y = Number(gazeSample.y.toFixed(4));
    if (x === lastSentX && y === lastSentY) {
      return;
    }
    const now = Date.now();
    if (!settled && now - lastMotionSentAt < MOTION_SEND_INTERVAL_MS) {
      return;
    }
    lastMotionSentAt = now;
    lastSentX = x;
    lastSentY = y;
    sender({
      type: 'face_motion',
      actor: mode === 'mini' ? 'small' : 'main',
      x,
      y,
      ts: now,
    });
  }

  function steerTowardDetectedFace(): boolean {
    if (thinkingGaze) {
      return false;
    }
    const state = store.getState();
    const frameWidth = state.faceFrameWidth;
    const frameHeight = state.faceFrameHeight;
    const faces = state.faceLastFaces;
    if (!state.faceCameraActive || !frameWidth || !frameHeight || faces.length === 0) {
      return false;
    }

    // Stay with the person we were looking at, wherever the detector lists them.
    let index = Number.isNaN(activeFaceX) ? 0 : nearestFaceIndex(faces, activeFaceX, activeFaceY);
    const now = Date.now();
    const switching = faces.length > 1 && now >= nextFaceSwitchAt;
    if (switching) {
      index = (index + 1) % faces.length;
      nextFaceSwitchAt = now + randBetween(FACE_TARGET_SWITCH_MIN_MS, FACE_TARGET_SWITCH_MAX_MS);
    }

    const face = faces[index];
    if (!face) {
      return false;
    }

    const [x1, y1, x2, y2] = face.box;
    activeFaceX = (x1 + x2) / 2;
    activeFaceY = (y1 + y2) / 2;
    const normalizedX = (activeFaceX / frameWidth) * 2 - 1;
    const normalizedY = (activeFaceY / frameHeight) * 2 - 1;

    // Camera feed is mirrored in the UI, so invert the horizontal target.
    const targetX = (-normalizedX) * 0.92;
    const targetY = normalizedY * 0.68;
    // A new person is one clean saccade away; the same person's box gets filtered.
    if (switching) {
      lookAt(targetX, targetY);
    } else {
      trackTarget(targetX, targetY);
    }
    return true;
  }
}

export type IdleAction = 'smile' | 'wander' | 'none';

/**
 * What one idle behaviour step does, for a dice roll in 0..1. Most steps do
 * nothing: the face lives through its breathing and gaze, and a smile that
 * comes every few seconds stops meaning anything.
 */
export function chooseIdleAction(roll: number, context: { tracking: boolean; idleForMs: number; sinceWanderMs: number }): IdleAction {
  if (roll < IDLE_SMILE_CHANCE) {
    return context.idleForMs >= IDLE_SETTLE_MS ? 'smile' : 'none';
  }
  // Only wander when not tracking a face, and not right after the last time.
  if (roll >= 1 - WANDER_CHANCE && !context.tracking && context.sinceWanderMs >= WANDER_MIN_GAP_MS) {
    return 'wander';
  }
  return 'none';
}

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clearManagedTimer(timer: number | null): void {
  if (timer != null) {
    clearTimeout(timer);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function easeInput(value: number): number {
  const clamped = clamp(value, -1, 1);
  const sign = Math.sign(clamped);
  const magnitude = Math.abs(clamped);
  if (magnitude <= INPUT_DEADZONE) {
    return 0;
  }
  const normalized = (magnitude - INPUT_DEADZONE) / (1 - INPUT_DEADZONE);
  return sign * clamp(Math.pow(normalized, INPUT_SHAPE_EXPONENT), 0, 1);
}
