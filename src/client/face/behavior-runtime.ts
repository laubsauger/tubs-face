import type { WsClientMessage } from '../../shared/contracts/ws.js';
import type { AppStore } from '../state/app-state.js';

const BLINK_MIN_MS = 3800;
const BLINK_MAX_MS = 6400;
const BEHAVIOR_MIN_MS = 3600;
const BEHAVIOR_MAX_MS = 5800;
const WANDER_X_RANGE = 0.32;
const WANDER_Y_RANGE = 0.2;
const INPUT_DEADZONE = 0.035;
const INPUT_SHAPE_EXPONENT = 0.82;
const SPRING_STIFFNESS = 185;
const SPRING_DAMPING = 22;
const STOP_POS_EPS = 0.0012;
const STOP_VEL_EPS = 0.0012;
const FACE_TARGET_SWITCH_MIN_MS = 1900;
const FACE_TARGET_SWITCH_MAX_MS = 3600;
const PARTNER_MOTION_IDLE_BLOCK_MS = 1800;
const PARTNER_BLINK_MIN_GAP_MS = 900;

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
  let currentX = 0;
  let currentY = 0;
  let velocityX = 0;
  let velocityY = 0;
  let targetX = 0;
  let targetY = 0;
  let lastTickMs = 0;
  let lastPointerAt = 0;
  let activeFaceIndex = 0;
  let nextFaceSwitchAt = 0;
  let partnerMotionAt = 0;
  let partnerBlinkTimer: number | null = null;
  let lastPartnerBlinkAt = 0;
  let partnerMotionHandler: ((event: Event) => void) | null = null;
  let partnerBlinkHandler: ((event: Event) => void) | null = null;

  return {
    bind(root: HTMLElement): void {
      rootEl = root.querySelector<HTMLElement>('.visual-shell');
      if (!rootEl) {
        return;
      }

      rootEl.onpointermove = (event) => {
        const rect = rootEl?.getBoundingClientRect();
        if (!rect) {
          return;
        }
        const normalizedX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const normalizedY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
        lastPointerAt = Date.now();
        lookAt(normalizedX * 0.8, normalizedY * 0.6);
      };

      rootEl.onpointerleave = () => {
        resetGaze();
      };
    },
    init(): void {
      attachPartnerHandlers();
      scheduleBlink();
      scheduleBehavior();
      resetGaze();
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
    return shouldAnimate() && state.currentExpression === 'idle';
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
    if (steerTowardDetectedFace()) {
      return;
    }

    if (mode === 'mini' && Date.now() - partnerMotionAt <= PARTNER_MOTION_IDLE_BLOCK_MS) {
      return;
    }

    const roll = Math.random();
    if (roll < 0.42) {
      store.setState((current) => ({
        ...current,
        currentExpression: 'smile',
      }));
      clearManagedTimer(smileResetTimer);
      smileResetTimer = window.setTimeout(() => {
        const state = store.getState();
        if (!shouldAnimate() || state.currentExpression !== 'smile') {
          return;
        }
        store.setState((current) => ({
          ...current,
          currentExpression: 'idle',
        }));
      }, randBetween(900, 1800));
      return;
    }

    if (roll < 0.82) {
      store.setState((current) => ({
        ...current,
        idleVariant: Math.random() < 0.74 ? 'soft' : 'flat',
      }));
      return;
    }

    const nextX = (Math.random() * 2 - 1) * WANDER_X_RANGE;
    const nextY = (Math.random() * 2 - 1) * WANDER_Y_RANGE;
    lookAt(nextX, nextY);
    clearManagedTimer(lookResetTimer);
    lookResetTimer = window.setTimeout(() => {
      resetGaze();
    }, randBetween(650, 1350));
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
      partnerMotionAt = Number(detail.ts) || Date.now();
      lookAt(detail.x, detail.y);
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
      if (Math.random() < 0.35) {
        return;
      }
      clearManagedTimer(partnerBlinkTimer);
      partnerBlinkTimer = window.setTimeout(() => {
        partnerBlinkTimer = null;
        lastPartnerBlinkAt = Date.now();
        blink();
      }, randBetween(90, 420));
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

  function lookAt(x: number, y: number): void {
    targetX = easeInput(x);
    targetY = easeInput(y);
    startAnimationLoop();
  }

  function resetGaze(): void {
    targetX = 0;
    targetY = 0;
    startAnimationLoop();
  }

  function startAnimationLoop(): void {
    if (rafId != null) {
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function tick(nowMs: number): void {
    if (Date.now() - lastPointerAt > 1200) {
      steerTowardDetectedFace();
    }

    if (!lastTickMs) {
      lastTickMs = nowMs;
    }
    const deltaSeconds = clamp((nowMs - lastTickMs) / 1000, 0.008, 0.04);
    lastTickMs = nowMs;

    [currentX, velocityX] = stepAxis(currentX, velocityX, targetX, deltaSeconds);
    [currentY, velocityY] = stepAxis(currentY, velocityY, targetY, deltaSeconds);

    store.setState((current) => ({
      ...current,
      gazeX: currentX,
      gazeY: currentY,
    }));
    sender?.({
      type: 'face_motion',
      actor: mode === 'mini' ? 'small' : 'main',
      x: Number(currentX.toFixed(4)),
      y: Number(currentY.toFixed(4)),
      ts: Date.now(),
    });

    const doneX = Math.abs(targetX - currentX) < STOP_POS_EPS && Math.abs(velocityX) < STOP_VEL_EPS;
    const doneY = Math.abs(targetY - currentY) < STOP_POS_EPS && Math.abs(velocityY) < STOP_VEL_EPS;
    if (doneX && doneY) {
      currentX = targetX;
      currentY = targetY;
      velocityX = 0;
      velocityY = 0;
      lastTickMs = 0;
      rafId = null;
      return;
    }

    rafId = requestAnimationFrame(tick);
  }

  function steerTowardDetectedFace(): boolean {
    const state = store.getState();
    const frameWidth = state.faceFrameWidth;
    const frameHeight = state.faceFrameHeight;
    const faces = state.faceLastFaces;
    if (!state.faceCameraActive || !frameWidth || !frameHeight || faces.length === 0) {
      return false;
    }

    const now = Date.now();
    if (faces.length === 1) {
      activeFaceIndex = 0;
    } else if (now >= nextFaceSwitchAt) {
      activeFaceIndex = (activeFaceIndex + 1) % faces.length;
      nextFaceSwitchAt = now + randBetween(FACE_TARGET_SWITCH_MIN_MS, FACE_TARGET_SWITCH_MAX_MS);
    }

    const face = faces[Math.min(activeFaceIndex, faces.length - 1)];
    if (!face) {
      return false;
    }

    const [x1, y1, x2, y2] = face.box;
    const centerX = (x1 + x2) / 2;
    const centerY = (y1 + y2) / 2;
    const normalizedX = (centerX / frameWidth) * 2 - 1;
    const normalizedY = (centerY / frameHeight) * 2 - 1;

    // Camera feed is mirrored in the UI, so invert the horizontal target.
    lookAt((-normalizedX) * 0.92, normalizedY * 0.68);
    return true;
  }
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

function stepAxis(current: number, velocity: number, target: number, deltaSeconds: number): [number, number] {
  const acceleration = (target - current) * SPRING_STIFFNESS;
  const nextVelocity = (velocity + acceleration * deltaSeconds) * Math.exp(-SPRING_DAMPING * deltaSeconds);
  const nextCurrent = current + nextVelocity * deltaSeconds;
  return [nextCurrent, nextVelocity];
}
