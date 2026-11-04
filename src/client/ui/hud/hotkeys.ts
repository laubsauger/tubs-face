// What a key press means in the operator views. Pure, so "typing reaches the
// chat input" and friends can be tested without a browser.

/**
 * Single-key shortcuts. Typing any other printable key goes to a chat input,
 * so an operator can just start typing to Tubs. Space is push-to-talk (voice
 * runtime), backtick folds the dock.
 */
export const SHORTCUT_KEYS = new Set([' ', '`', 'c', 'd', 'e', 'f', 'm', 'o', 's', 't', 'x', 'z']);

export type HotkeyAction =
  | 'fx-toggle'
  | 'fx-close'
  | 'sleep-toggle'
  | 'mute'
  | 'camera'
  | 'enroll'
  | 'debug'
  | 'transcript-toggle'
  | 'dock-fold'
  | 'fullscreen'
  | 'perform-toggle'
  | 'open-mini'
  /** The dock's chat input (Chat tab open, or the dashboard's chat column). */
  | 'focus-chat'
  /** The compact input on the floating transcript, when the Chat tab is not on screen. */
  | 'focus-quick';

export interface HotkeyContext {
  key: string;
  /** KeyboardEvent.code, for keys whose `key` depends on the layout (backtick). */
  code: string;
  modifier: boolean;
  inTextField: boolean;
  view: 'face' | 'dashboard';
  fxOpen: boolean;
  /** Perform mode: the screen belongs to the audience. */
  perform: boolean;
  /** The dock's chat input is on screen (Chat tab open in an unfolded dock). */
  chatInputVisible: boolean;
}

// Shortcuts that act on the face window itself; the dashboard has no face.
const FACE_ONLY: ReadonlySet<HotkeyAction> = new Set(['enroll', 'transcript-toggle', 'fullscreen', 'perform-toggle', 'open-mini']);

const LETTER_ACTIONS: Record<string, HotkeyAction> = {
  e: 'fx-toggle',
  m: 'mute',
  s: 'sleep-toggle',
  c: 'camera',
  f: 'enroll',
  d: 'debug',
  t: 'transcript-toggle',
  x: 'fullscreen',
  z: 'perform-toggle',
  o: 'open-mini',
};

export function resolveHotkey(ctx: HotkeyContext): HotkeyAction | null {
  // Escape works even while typing: it closes the FX editor, else sleeps / wakes.
  if (ctx.key === 'Escape') {
    return ctx.fxOpen ? 'fx-close' : 'sleep-toggle';
  }
  if (ctx.modifier || ctx.inTextField) {
    return null;
  }
  if (ctx.key === '`' || ctx.code === 'Backquote') {
    return ctx.view === 'face' && ctx.perform ? null : 'dock-fold';
  }

  const letterAction = LETTER_ACTIONS[ctx.key.toLowerCase()];
  if (letterAction && ctx.key.length === 1) {
    return ctx.view === 'dashboard' && FACE_ONLY.has(letterAction) ? null : letterAction;
  }

  if (ctx.key === 'Enter' || (ctx.key.length === 1 && !SHORTCUT_KEYS.has(ctx.key.toLowerCase()))) {
    return routeTyping(ctx);
  }
  return null;
}

function routeTyping(ctx: HotkeyContext): HotkeyAction | null {
  if (ctx.view === 'dashboard' || ctx.chatInputVisible) {
    return 'focus-chat';
  }
  // No input pops up on the audience's screen; Z brings the operator view back.
  if (ctx.perform) {
    return null;
  }
  return 'focus-quick';
}
