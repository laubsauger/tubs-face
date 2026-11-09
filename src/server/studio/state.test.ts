import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyStudioPatch,
  notePageConnection,
  notePageStatus,
  noteLauncherError,
  recognizerOf,
  resetStudioReports,
  studioConfigMessage,
  studioSettingsFromEnv,
  toStudioResponse,
} from './state.js';

beforeEach(() => resetStudioReports());

// Studio mode is something you ask for. Without it tubs-face is the normal
// app: no pages launched, no streams, the operator face keeps its mic.
describe('studio settings', () => {
  it('are off by default, with the studio site node and the local mic', () => {
    expect(studioSettingsFromEnv({})).toEqual({
      enabled: false,
      site: 'http://127.0.0.1:8889',
      micSource: 'local',
      // No studio camera unless one is chosen: pictures cost money (docs/vision.md).
      visionSource: 'off',
      prefix: 'tubs-',
      launch: 'chrome',
      // Faces are recognised in the browser unless FACE_SERVICE says otherwise (docs/face-service.md).
      faceService: false,
      // Every switch on; the face windows off the screen, so nobody finds a pile of Tubs windows.
      cameraOn: true,
      micOn: true,
      faceRecognition: true,
      windows: 'offscreen',
    });
  });

  it('take their defaults from the environment', () => {
    const settings = studioSettingsFromEnv({
      TUBS_STUDIO: '1',
      TUBS_STUDIO_SITE: 'http://10.0.0.5:8889/',
      TUBS_MIC_SOURCE: 'site:mic-room',
      TUBS_STUDIO_LAUNCH: 'external',
    });
    expect(settings).toMatchObject({ enabled: true, site: 'http://10.0.0.5:8889', micSource: 'site:mic-room', launch: 'external' });
  });

  // A bad env value should stop the server at start, loudly, not run with a surprise.
  it('refuse a bad mic source or site in the environment', () => {
    expect(() => studioSettingsFromEnv({ TUBS_MIC_SOURCE: 'usb' })).toThrow(/TUBS_MIC_SOURCE/);
    expect(() => studioSettingsFromEnv({ TUBS_STUDIO_SITE: 'rtsp://x' })).toThrow(/TUBS_STUDIO_SITE/);
  });
});

describe('POST /studio', () => {
  it('changes only what it names and says what changed', () => {
    const settings = studioSettingsFromEnv({});
    expect(applyStudioPatch({ micSource: 'site:cam-c920' }, settings)).toEqual(['micSource']);
    expect(settings).toMatchObject({ enabled: false, micSource: 'site:cam-c920' });
    expect(applyStudioPatch({ micSource: 'site:cam-c920', enabled: true }, settings)).toEqual(['enabled']);
  });

  // Half a patch applied would switch the mic and then fail on the site, say.
  it('takes a vision source in the mic\'s grammar, plus snapshot URLs', () => {
    const settings = studioSettingsFromEnv({});
    expect(applyStudioPatch({ visionSource: 'snapshot:http://10.0.0.7:8080/api/snapshot/color.jpg' }, settings)).toEqual(['visionSource']);
    expect(applyStudioPatch({ visionSource: 'site:cam-c920' }, settings)).toEqual(['visionSource']);
    expect(() => applyStudioPatch({ visionSource: 'snapshot:file:///etc/passwd' }, settings)).toThrow(/visionSource/);
    expect(() => applyStudioPatch({ visionSource: 'webcam' }, settings)).toThrow(/visionSource/);
    expect(settings.visionSource).toBe('site:cam-c920');
  });

  it('applies nothing when any field is bad', () => {
    const settings = studioSettingsFromEnv({});
    expect(() => applyStudioPatch({ enabled: true, micSource: 'nope' }, settings)).toThrow(/micSource/);
    expect(() => applyStudioPatch({ enabled: 'yes' }, settings)).toThrow(/enabled/);
    expect(() => applyStudioPatch({ site: 'not a url' }, settings)).toThrow(/site/);
    expect(() => applyStudioPatch([], settings)).toThrow();
    expect(settings.enabled).toBe(false);
    expect(settings.micSource).toBe('local');
  });
});

// GET /studio is what studio-manager and the director read to know whether
// the faces are really on the site node; it must not claim more than the
// pages report.
describe('GET /studio', () => {
  it('has the contract shape, one entry per head with its stream path', () => {
    const settings = studioSettingsFromEnv({ TUBS_STUDIO: '1' });
    notePageConnection('main', true);
    notePageStatus('main', { publishing: true, mic: { source: 'local', listening: true } });
    const response = toStudioResponse(settings);
    expect(response).toMatchObject({ enabled: true, site: 'http://127.0.0.1:8889', micSource: 'local' });
    expect(response.actors).toEqual([
      { id: 'main', stream: 'tubs-main', publishing: true },
      { id: 'small', stream: 'tubs-small', publishing: false, error: 'face page not connected' },
    ]);
    expect(response.mic).toEqual({ source: 'local', listening: true });
  });

  it('stops counting a head as publishing once its page is gone', () => {
    const settings = studioSettingsFromEnv({ TUBS_STUDIO: '1' });
    notePageConnection('small', true);
    notePageStatus('small', { publishing: true });
    notePageConnection('small', false);
    expect(toStudioResponse(settings).actors[1]).toEqual({ id: 'small', stream: 'tubs-small', publishing: false, error: 'face page not connected' });
  });

  it('shows why a page could not be kept up', () => {
    const settings = studioSettingsFromEnv({ TUBS_STUDIO: '1' });
    noteLauncherError('main', 'Chrome exited (code 1); reopening in 2 s');
    expect(toStudioResponse(settings).actors[0]).toMatchObject({ publishing: false, error: 'Chrome exited (code 1); reopening in 2 s' });
  });

  it('reports nothing as publishing, and no errors, while studio mode is off', () => {
    const settings = studioSettingsFromEnv({});
    notePageConnection('main', true);
    notePageStatus('main', { publishing: true });
    expect(toStudioResponse(settings).actors.map((actor) => actor.publishing)).toEqual([false, false]);
    expect(toStudioResponse(settings).actors.some((actor) => 'error' in actor)).toBe(false);
  });

  it('tells the pages each head\'s stream path', () => {
    const settings = studioSettingsFromEnv({ TUBS_STUDIO_PREFIX: 'show-' });
    expect(studioConfigMessage(settings).streams).toEqual({ main: 'show-main', small: 'show-small' });
  });
});

// The listener page's browser worker is what broke unseen ("LOADING WORKER");
// with FACE_SERVICE set it must not run at all for a camera the server reads,
// or every face would be greeted twice and the models downloaded for nothing.
describe('who recognises faces', () => {
  const on = (env: Record<string, string>) => studioSettingsFromEnv({ TUBS_STUDIO: '1', ...env });

  it('is the face service for a site stream or a snapshot URL once FACE_SERVICE is set, and the pages are told', () => {
    for (const source of ['site:cam-flo-mac', 'snapshot:http://10.0.0.7/api/snapshot/color.jpg']) {
      const settings = on({ FACE_SERVICE: 'local', TUBS_VISION_SOURCE: source });
      expect(recognizerOf(settings)).toBe('service');
      expect(studioConfigMessage(settings).faces).toBe('service');
    }
    expect(on({ FACE_SERVICE: 'http://10.0.0.5:3004', TUBS_VISION_SOURCE: 'site:cam-1' }).faceService).toBe(true);
  });

  it('stays the browser worker for this Mac\'s camera, and without FACE_SERVICE (the message unchanged)', () => {
    const local = on({ FACE_SERVICE: 'local', TUBS_VISION_SOURCE: 'local:FaceTime HD Camera' });
    expect(recognizerOf(local)).toBe('browser');
    expect('faces' in studioConfigMessage(local)).toBe(false);
    for (const value of ['', 'off']) {
      const settings = on({ FACE_SERVICE: value, TUBS_VISION_SOURCE: 'site:cam-1' });
      expect(recognizerOf(settings)).toBe('browser');
      expect('faces' in studioConfigMessage(settings)).toBe(false);
    }
  });

  it('is nobody without a camera or with studio mode off', () => {
    expect(recognizerOf(on({ FACE_SERVICE: 'local', TUBS_VISION_SOURCE: 'off' }))).toBe('off');
    expect(recognizerOf(studioSettingsFromEnv({ FACE_SERVICE: 'local', TUBS_VISION_SOURCE: 'site:cam-1' }))).toBe('off');
  });

  it('follows a vision source changed live', () => {
    const settings = on({ FACE_SERVICE: 'local', TUBS_VISION_SOURCE: 'site:cam-1' });
    applyStudioPatch({ visionSource: 'local' }, settings);
    expect(studioConfigMessage(settings).faces).toBeUndefined();
    applyStudioPatch({ visionSource: 'site:cam-2' }, settings);
    expect(studioConfigMessage(settings).faces).toBe('service');
  });
});
