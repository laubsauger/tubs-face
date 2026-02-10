import { STATE } from '../state.js';
import { initCameraListeners } from './camera.js';
import { isWorkerReady, initDelaySlider } from './detection.js';
import { toggleDebug } from './debug.js';
import { enrollFace } from './enrollment.js';

export const faceManager = {
    init() {
        initCameraListeners();
        initDelaySlider();
    },
    enrollFace,
    toggleDebug,
    get isActive() { return STATE.cameraActive; },
    get isReady() { return isWorkerReady(); },
};
