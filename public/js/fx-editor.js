// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FX Editor — Glitch FX + Expression Profile Editor
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from './state.js';
import { getGlitchFxConfig, setGlitchFxConfig, setGlitchFxBaseColor } from './glitch-fx.js';
import { DEFAULT_CONFIG, EXPRESSION_PROFILES, updateExpressionProfile } from './glitch-fx/constants.js';
import { setExpression } from './expressions.js';

const STORAGE_KEY = 'tubs.fxEditorConfig';
const STORAGE_KEY_PROFILES = 'tubs.fxEditorProfiles';

let isOpen = false;
let activeTab = 'glitch';
let selectedExpression = 'idle';
let previewSpeaking = false;
let previewSpeakTimer = null;

// ── Control definitions ──────────────────

const GLITCH_CONTROL_GROUPS = [
    {
        title: 'Pixel Grid',
        prefix: 'pixel',
        controls: [
            { key: 'size', label: 'Size', min: 2, max: 60, step: 1 },
            { key: 'gap', label: 'Gap', min: 0, max: 30, step: 1 },
            { key: 'edgeSoftness', label: 'Edge Softness', min: 0, max: 20, step: 1 },
            { key: 'borderRadius', label: 'Border Radius', min: 0, max: 20, step: 1 },
        ],
    },
    {
        title: 'Base Shapes — Left Eye',
        prefix: 'svg.shapes.0',
        controls: [
            { key: 'x', label: 'X', min: -10, max: 60, step: 0.1 },
            { key: 'y', label: 'Y', min: -10, max: 40, step: 0.1 },
            { key: 'w', label: 'Width', min: 1, max: 30, step: 0.1 },
            { key: 'h', label: 'Height', min: 1, max: 40, step: 0.1 },
            { key: 'rx', label: 'Radius X', min: 0, max: 15, step: 0.1 },
            { key: 'ry', label: 'Radius Y', min: 0, max: 15, step: 0.1 },
        ],
    },
    {
        title: 'Base Shapes — Right Eye',
        prefix: 'svg.shapes.1',
        controls: [
            { key: 'x', label: 'X', min: 0, max: 60, step: 0.1 },
            { key: 'y', label: 'Y', min: -10, max: 40, step: 0.1 },
            { key: 'w', label: 'Width', min: 1, max: 30, step: 0.1 },
            { key: 'h', label: 'Height', min: 1, max: 40, step: 0.1 },
            { key: 'rx', label: 'Radius X', min: 0, max: 15, step: 0.1 },
            { key: 'ry', label: 'Radius Y', min: 0, max: 15, step: 0.1 },
        ],
    },
    {
        title: 'Base Shapes — Mouth',
        prefix: 'svg.shapes.2',
        controls: [
            { key: 'x', label: 'X', min: 0, max: 60, step: 0.1 },
            { key: 'y', label: 'Y', min: 0, max: 40, step: 0.1 },
            { key: 'w', label: 'Width', min: 1, max: 30, step: 0.1 },
            { key: 'h', label: 'Height', min: 1, max: 20, step: 0.1 },
            { key: 'rx', label: 'Radius X', min: 0, max: 15, step: 0.1 },
            { key: 'ry', label: 'Radius Y', min: 0, max: 15, step: 0.1 },
        ],
    },
    {
        title: 'Color',
        prefix: 'color',
        controls: [
            { key: 'base', label: 'Base Color', type: 'color' },
            { key: 'hueVariation', label: 'Hue Variation', min: 0, max: 60, step: 1 },
            { key: 'brightnessVariation', label: 'Brightness Var', min: 0, max: 40, step: 1 },
            { key: 'opacityMin', label: 'Opacity Min', min: 0, max: 1, step: 0.05 },
        ],
    },
    {
        title: 'Glow',
        prefix: 'glow',
        controls: [
            { key: 'pixelGlow', label: 'Pixel Glow', min: 0, max: 40, step: 1 },
            { key: 'outerBloom', label: 'Outer Bloom', min: 0, max: 30, step: 1 },
            { key: 'bloomIntensity', label: 'Bloom Intensity', min: 0, max: 3, step: 0.1 },
            { key: 'color', label: 'Glow Color', type: 'color' },
            { key: 'falloffCurve', label: 'Falloff Curve', min: 0.5, max: 5, step: 0.1 },
        ],
    },
    {
        title: 'Brightness Pulse',
        prefix: 'brightnessPulse',
        controls: [
            { key: 'enabled', label: 'Enabled', type: 'toggle' },
            { key: 'dim', label: 'Dim', min: 0.3, max: 1, step: 0.01 },
            { key: 'bright', label: 'Bright', min: 0.5, max: 1.5, step: 0.01 },
            { key: 'speed', label: 'Speed', min: 0.5, max: 15, step: 0.5 },
        ],
    },
    {
        title: 'Scan Beam',
        prefix: 'scanBeam',
        controls: [
            { key: 'enabled', label: 'Enabled', type: 'toggle' },
            { key: 'speed', label: 'Speed', min: 1, max: 40, step: 1 },
            { key: 'lineWidth', label: 'Line Width', min: 1, max: 30, step: 1 },
            { key: 'brightness', label: 'Brightness', min: 0, max: 1, step: 0.05 },
            { key: 'glowStrength', label: 'Glow Strength', min: 0, max: 60, step: 1 },
            { key: 'jitter', label: 'Jitter', min: 0, max: 10, step: 0.5 },
            { key: 'color', label: 'Color', type: 'color' },
        ],
    },
    {
        title: 'Chromatic Aberration',
        prefix: 'chromatic',
        controls: [
            { key: 'enabled', label: 'Enabled', type: 'toggle' },
            { key: 'offsetX', label: 'Offset X', min: -10, max: 10, step: 0.5 },
            { key: 'offsetY', label: 'Offset Y', min: -10, max: 10, step: 0.5 },
            { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.05 },
            { key: 'animate', label: 'Animate', type: 'toggle' },
            { key: 'animateSpeed', label: 'Animate Speed', min: 1, max: 20, step: 1 },
        ],
    },
    {
        title: 'Glitch Slice',
        prefix: 'glitchSlice',
        controls: [
            { key: 'enabled', label: 'Enabled', type: 'toggle' },
            { key: 'sliceCount', label: 'Slice Count', min: 2, max: 60, step: 1 },
            { key: 'maxOffset', label: 'Max Offset', min: 0, max: 30, step: 1 },
            { key: 'speed', label: 'Speed', min: 1, max: 60, step: 1 },
            { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01 },
            { key: 'colorShift', label: 'Color Shift', min: 0, max: 0.2, step: 0.01 },
            { key: 'gapChance', label: 'Gap Chance', min: 0, max: 0.5, step: 0.01 },
            { key: 'interval', label: 'Interval (ms)', min: 1000, max: 60000, step: 1000 },
            { key: 'burstDuration', label: 'Burst Duration (ms)', min: 200, max: 8000, step: 100 },
        ],
    },
    {
        title: 'Scanlines & Flicker',
        prefix: 'glitch',
        controls: [
            { key: 'scanlines', label: 'Scanlines', type: 'toggle' },
            { key: 'scanlineIntensity', label: 'Intensity', min: 0, max: 1, step: 0.01 },
            { key: 'scanlineSpacing', label: 'Spacing', min: 1, max: 20, step: 1 },
            { key: 'scanlineThickness', label: 'Thickness', min: 1, max: 10, step: 1 },
            { key: 'scanlineMove', label: 'Movement', type: 'toggle' },
            { key: 'scanlineSpeed', label: 'Speed', min: 1, max: 60, step: 1 },
            { key: 'pixelJitter', label: 'Pixel Jitter', min: 0, max: 10, step: 0.5 },
            { key: 'flicker', label: 'Flicker', type: 'toggle' },
            { key: 'flickerSpeed', label: 'Flicker Speed', min: 1, max: 30, step: 1 },
            { key: 'flickerDepth', label: 'Flicker Depth', min: 0, max: 0.2, step: 0.005 },
        ],
    },
];

const EXPRESSION_CONTROLS = [
    { key: 'eyeH', label: 'Eye Height', min: 0.05, max: 2, step: 0.01 },
    { key: 'eyeW', label: 'Eye Width', min: 0.3, max: 2, step: 0.01 },
    { key: 'eyeDy', label: 'Eye Offset Y', min: -10, max: 15, step: 0.5 },
    { key: 'eyeSkew', label: 'Eye Skew', min: -0.5, max: 0.5, step: 0.01 },
    { key: 'mouthW', label: 'Mouth Width', min: 0.1, max: 2, step: 0.01 },
    { key: 'mouthH', label: 'Mouth Height', min: 0.1, max: 4, step: 0.01 },
    { key: 'mouthRound', label: 'Mouth Round', type: 'toggle' },
    { key: 'tears', label: 'Tears', type: 'toggle' },
    { key: 'eyeShape', label: 'Eye Shape', type: 'select', options: ['rect', 'heart'] },
    { key: 'mouthShape', label: 'Mouth Shape', type: 'select', options: ['rect', 'frown', 'smile-arc', 'round'] },
    { key: 'colorHex', label: 'Color Override', type: 'color' },
    { key: 'tearColorHex', label: 'Tear Color', type: 'color' },
];

// ── Presets ───────────────────────────────

const PRESETS = {
    default: structuredClone(DEFAULT_CONFIG),
    cyberpunk: {
        ...structuredClone(DEFAULT_CONFIG),
        pixel: { size: 16, gap: 5, edgeSoftness: 0, borderRadius: 0 },
        color: { base: '#00ffcc', hueVariation: 15, brightnessVariation: 12, opacityMin: 0.4 },
        glow: { pixelGlow: 20, outerBloom: 8, bloomIntensity: 1.5, color: '#00ff88', falloffCurve: 2.2 },
        chromatic: { enabled: true, offsetX: 2, offsetY: 5, intensity: 0.8, animate: true, animateSpeed: 10 },
        glitchSlice: {
            enabled: true, sliceCount: 32, maxOffset: 10, speed: 35,
            intensity: 0.7, colorShift: 0.06, gapChance: 0.1,
            interval: 8000, burstDuration: 2400,
        },
        glitch: {
            scanlines: true, scanlineIntensity: 0.55, scanlineSpacing: 4,
            scanlineThickness: 2, scanlineMove: true, scanlineSpeed: 30,
            pixelJitter: 1.5, flicker: true, flickerSpeed: 14, flickerDepth: 0.04,
        },
    },
    minimal: {
        ...structuredClone(DEFAULT_CONFIG),
        pixel: { size: 26, gap: 10, edgeSoftness: 0, borderRadius: 0 },
        color: { base: '#e0e0e0', hueVariation: 2, brightnessVariation: 3, opacityMin: 0.7 },
        glow: { pixelGlow: 8, outerBloom: 0, bloomIntensity: 0.5, color: '#ffffff', falloffCurve: 3 },
        brightnessPulse: { enabled: false, dim: 0.95, bright: 1, speed: 2 },
        scanBeam: { enabled: false, speed: 10, lineWidth: 7, brightness: 0.3, glowStrength: 10, jitter: 0, color: '#ffffff' },
        chromatic: { enabled: false, offsetX: 0, offsetY: 0, intensity: 0, animate: false, animateSpeed: 5 },
        glitchSlice: {
            enabled: false, sliceCount: 10, maxOffset: 2, speed: 20,
            intensity: 0.2, colorShift: 0, gapChance: 0,
            interval: 30000, burstDuration: 800,
        },
        glitch: {
            scanlines: false, scanlineIntensity: 0.1, scanlineSpacing: 6,
            scanlineThickness: 1, scanlineMove: false, scanlineSpeed: 10,
            pixelJitter: 0, flicker: false, flickerSpeed: 5, flickerDepth: 0,
        },
    },
    warm: {
        ...structuredClone(DEFAULT_CONFIG),
        color: { base: '#ff8844', hueVariation: 12, brightnessVariation: 10, opacityMin: 0.5 },
        glow: { pixelGlow: 16, outerBloom: 4, bloomIntensity: 1.2, color: '#ff4400', falloffCurve: 2.5 },
        scanBeam: { enabled: true, speed: 6, lineWidth: 10, brightness: 0.5, glowStrength: 20, jitter: 0.5, color: '#ff6600' },
        brightnessPulse: { enabled: true, dim: 0.85, bright: 1, speed: 2 },
    },
};

// ── Helpers ──────────────────────────────

function getNestedValue(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur == null) return undefined;
        // support array index like shapes.0
        cur = cur[isNaN(p) ? p : Number(p)];
    }
    return cur;
}

function setNestedValue(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = isNaN(parts[i]) ? parts[i] : Number(parts[i]);
        if (cur[p] == null) cur[p] = {};
        cur = cur[p];
    }
    const last = isNaN(parts[parts.length - 1]) ? parts[parts.length - 1] : Number(parts[parts.length - 1]);
    cur[last] = value;
}

function buildConfigPatch(prefix, key, value) {
    const config = getGlitchFxConfig();
    const fullPath = prefix + '.' + key;
    setNestedValue(config, fullPath, value);
    return config;
}

function formatValue(val) {
    if (typeof val === 'number') {
        return Number.isInteger(val) ? String(val) : val.toFixed(val < 10 ? 2 : 1);
    }
    return String(val);
}

// ── Pause / Resume ──────────────────────

function pauseAppProcessing() {
    STATE.editorMode = true;
}

function resumeAppProcessing() {
    STATE.editorMode = false;
}

// ── Control rendering ───────────────────

function createSlider(ctrl, currentValue, onChange) {
    const row = document.createElement('div');
    row.className = 'fx-ctrl-row';

    const label = document.createElement('span');
    label.className = 'fx-ctrl-label';
    label.textContent = ctrl.label;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = ctrl.min;
    input.max = ctrl.max;
    input.step = ctrl.step;
    input.value = currentValue ?? ctrl.min;

    const valSpan = document.createElement('span');
    valSpan.className = 'fx-ctrl-value';
    valSpan.textContent = formatValue(Number(input.value));

    input.addEventListener('input', () => {
        const v = Number(input.value);
        valSpan.textContent = formatValue(v);
        onChange(v);
    });

    row.append(label, input, valSpan);
    return { row, input, valSpan };
}

function createToggle(ctrl, currentValue, onChange) {
    const row = document.createElement('div');
    row.className = 'fx-ctrl-row';

    const label = document.createElement('span');
    label.className = 'fx-ctrl-label';
    label.textContent = ctrl.label;

    const wrapper = document.createElement('label');
    wrapper.className = 'toggle-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(currentValue);
    const slider = document.createElement('span');
    slider.className = 'slider';
    wrapper.append(input, slider);

    input.addEventListener('change', () => {
        onChange(input.checked);
    });

    row.append(label, wrapper);
    return { row, input };
}

function createColorPicker(ctrl, currentValue, onChange) {
    const row = document.createElement('div');
    row.className = 'fx-ctrl-row';

    const label = document.createElement('span');
    label.className = 'fx-ctrl-label';
    label.textContent = ctrl.label;

    const input = document.createElement('input');
    input.type = 'color';
    input.value = currentValue || '#a855f7';

    input.addEventListener('input', () => {
        onChange(input.value);
    });

    row.append(label, input);
    return { row, input };
}

function createSelect(ctrl, currentValue, onChange) {
    const row = document.createElement('div');
    row.className = 'fx-ctrl-row';

    const label = document.createElement('span');
    label.className = 'fx-ctrl-label';
    label.textContent = ctrl.label;

    const select = document.createElement('select');
    for (const opt of ctrl.options) {
        const option = document.createElement('option');
        option.value = opt;
        option.textContent = opt;
        if (opt === currentValue) option.selected = true;
        select.append(option);
    }

    select.addEventListener('change', () => {
        onChange(select.value);
    });

    row.append(label, select);
    return { row, select };
}

// ── Tab: Glitch FX ──────────────────────

function buildGlitchTab(container) {
    container.innerHTML = '';
    const config = getGlitchFxConfig();

    for (const group of GLITCH_CONTROL_GROUPS) {
        const groupEl = document.createElement('div');
        groupEl.className = 'fx-ctrl-group';

        const title = document.createElement('div');
        title.className = 'fx-ctrl-group-title';
        title.textContent = group.title;
        groupEl.append(title);

        for (const ctrl of group.controls) {
            const fullPath = group.prefix + '.' + ctrl.key;
            const currentValue = getNestedValue(config, fullPath);

            const onChange = (val) => {
                // Special handling for base color
                if (group.prefix === 'color' && ctrl.key === 'base') {
                    setGlitchFxBaseColor(val);
                    STATE.glitchFxBaseColor = val;
                    saveToLocalStorage();
                    return;
                }

                const updated = getGlitchFxConfig();
                setNestedValue(updated, fullPath, val);
                setGlitchFxConfig(updated);
                saveToLocalStorage();
            };

            if (ctrl.type === 'toggle') {
                const { row } = createToggle(ctrl, currentValue, onChange);
                groupEl.append(row);
            } else if (ctrl.type === 'color') {
                const { row } = createColorPicker(ctrl, currentValue, onChange);
                groupEl.append(row);
            } else if (ctrl.type === 'select') {
                const { row } = createSelect(ctrl, currentValue, onChange);
                groupEl.append(row);
            } else {
                const { row } = createSlider(ctrl, currentValue, onChange);
                groupEl.append(row);
            }
        }

        container.append(groupEl);
    }
}

// ── Tab: Expression Designer ─────────────

function buildExpressionTab(container) {
    container.innerHTML = '';

    // Expression selector
    const selectorGroup = document.createElement('div');
    selectorGroup.className = 'fx-ctrl-group';

    const selectorTitle = document.createElement('div');
    selectorTitle.className = 'fx-ctrl-group-title';
    selectorTitle.textContent = 'Expression';
    selectorGroup.append(selectorTitle);

    const selectorRow = document.createElement('div');
    selectorRow.className = 'fx-ctrl-row';
    const selectorLabel = document.createElement('span');
    selectorLabel.className = 'fx-ctrl-label';
    selectorLabel.textContent = 'Select';

    const selector = document.createElement('select');
    selector.className = 'fx-expression-select';
    for (const name of Object.keys(EXPRESSION_PROFILES)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === selectedExpression) opt.selected = true;
        selector.append(opt);
    }

    selector.addEventListener('change', () => {
        selectedExpression = selector.value;
        setExpression(selectedExpression, { force: true, skipHold: true });
        buildExpressionControls(controlsContainer);
    });
    selectorRow.append(selectorLabel, selector);
    selectorGroup.append(selectorRow);
    container.append(selectorGroup);

    // Force the expression for preview
    setExpression(selectedExpression, { force: true, skipHold: true });

    // Controls for selected expression
    const controlsContainer = document.createElement('div');
    controlsContainer.id = 'fx-expression-controls';
    container.append(controlsContainer);
    buildExpressionControls(controlsContainer);

    // Stages section
    const stagesContainer = document.createElement('div');
    stagesContainer.id = 'fx-stages-container';
    container.append(stagesContainer);
    buildStagesUI(stagesContainer);
}

function buildExpressionControls(container) {
    container.innerHTML = '';

    const profile = EXPRESSION_PROFILES[selectedExpression];

    if (selectedExpression === 'idle' && profile === null) {
        const note = document.createElement('div');
        note.className = 'fx-ctrl-group';
        note.innerHTML = '<div class="fx-ctrl-group-title">Idle (no modifiers)</div>';
        container.append(note);
        return;
    }

    const group = document.createElement('div');
    group.className = 'fx-ctrl-group';

    const title = document.createElement('div');
    title.className = 'fx-ctrl-group-title';
    title.textContent = selectedExpression + ' Profile';
    group.append(title);

    const currentProfile = profile ? { ...profile } : {};

    for (const ctrl of EXPRESSION_CONTROLS) {
        const currentValue = currentProfile[ctrl.key];

        const onChange = (val) => {
            const p = EXPRESSION_PROFILES[selectedExpression] || {};
            if (val === undefined || val === '' || val === false || val === 'rect') {
                delete p[ctrl.key];
            } else {
                p[ctrl.key] = val;
            }
            // If all keys removed, set to null for idle, else keep object
            const isEmpty = Object.keys(p).length === 0;
            updateExpressionProfile(selectedExpression, isEmpty && selectedExpression === 'idle' ? null : (isEmpty ? {} : p));
            // Force rebuild of pixel grid by re-setting expression
            setExpression(selectedExpression, { force: true, skipHold: true });
            saveProfilesToLocalStorage();
        };

        if (ctrl.type === 'toggle') {
            const { row } = createToggle(ctrl, Boolean(currentValue), onChange);
            group.append(row);
        } else if (ctrl.type === 'color') {
            const { row } = createColorPicker(ctrl, currentValue || '#a855f7', (val) => {
                onChange(val);
            });
            group.append(row);
        } else if (ctrl.type === 'select') {
            const { row } = createSelect(ctrl, currentValue || ctrl.options[0], onChange);
            group.append(row);
        } else {
            // For expression sliders, show current value or a sensible default (1.0 = no change for scales)
            const defaultVal = ctrl.key.includes('Dy') || ctrl.key.includes('Skew') ? 0 : 1;
            const { row } = createSlider(ctrl, currentValue ?? defaultVal, onChange);
            group.append(row);
        }
    }

    container.append(group);
}

// ── Stages UI ───────────────────────────

let activeStageIndex = 0;

function buildStagesUI(container) {
    container.innerHTML = '';

    const profile = EXPRESSION_PROFILES[selectedExpression];
    const isMultiStage = profile && profile.stages && Array.isArray(profile.stages);

    const group = document.createElement('div');
    group.className = 'fx-ctrl-group';

    const title = document.createElement('div');
    title.className = 'fx-ctrl-group-title';
    title.textContent = 'Interpolation Stages';
    group.append(title);

    if (!isMultiStage) {
        // Show a "Convert to multi-stage" button
        const convertRow = document.createElement('div');
        convertRow.className = 'fx-ctrl-row';
        const convertLabel = document.createElement('span');
        convertLabel.className = 'fx-ctrl-label';
        convertLabel.textContent = 'Single-state profile';
        const convertBtn = document.createElement('button');
        convertBtn.className = 'fx-editor-btn';
        convertBtn.textContent = 'Add Stages';
        convertBtn.addEventListener('click', () => {
            const currentProfile = EXPRESSION_PROFILES[selectedExpression] || {};
            // Convert to multi-stage with current as first and last keyframe
            const staged = {
                stages: [
                    { t: 0, profile: { ...currentProfile } },
                    { t: 1.0, profile: { ...currentProfile } },
                ],
                durationMs: 400,
            };
            updateExpressionProfile(selectedExpression, staged);
            saveProfilesToLocalStorage();
            activeStageIndex = 0;
            // Rebuild entire expression tab
            rebuildActiveTab();
        });
        convertRow.append(convertLabel, convertBtn);
        group.append(convertRow);
        container.append(group);
        return;
    }

    // Multi-stage controls
    const stages = profile.stages;

    // Duration slider
    const durationCtrl = { label: 'Duration (ms)', min: 100, max: 3000, step: 50 };
    const { row: durationRow } = createSlider(durationCtrl, profile.durationMs || 400, (val) => {
        profile.durationMs = val;
        updateExpressionProfile(selectedExpression, profile);
        saveProfilesToLocalStorage();
    });
    group.append(durationRow);

    // Timeline visualization
    const timeline = document.createElement('div');
    timeline.className = 'fx-stages-timeline';

    stages.forEach((stage, idx) => {
        if (idx > 0) {
            const line = document.createElement('div');
            line.className = 'fx-stage-line';
            timeline.append(line);
        }
        const dot = document.createElement('div');
        dot.className = 'fx-stage-dot';
        if (idx === activeStageIndex) dot.classList.add('active');
        dot.title = `t=${stage.t.toFixed(2)}`;
        dot.addEventListener('click', () => {
            activeStageIndex = idx;
            buildStagesUI(container);
            buildStageProfileControls(stageControlsEl, profile, idx);
        });
        timeline.append(dot);
    });

    // Add/remove buttons
    const actions = document.createElement('div');
    actions.className = 'fx-stage-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'fx-editor-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add stage';
    addBtn.addEventListener('click', () => {
        const lastStage = stages[stages.length - 1];
        const newT = Math.min(1, (lastStage?.t ?? 0.5) + 0.1);
        stages.push({ t: newT, profile: { ...(lastStage?.profile || {}) } });
        // Sort by t
        stages.sort((a, b) => a.t - b.t);
        updateExpressionProfile(selectedExpression, profile);
        saveProfilesToLocalStorage();
        activeStageIndex = stages.length - 1;
        buildStagesUI(container);
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'fx-editor-btn';
    removeBtn.textContent = '-';
    removeBtn.title = 'Remove selected stage';
    removeBtn.addEventListener('click', () => {
        if (stages.length <= 2) return; // need at least 2 stages
        stages.splice(activeStageIndex, 1);
        activeStageIndex = Math.min(activeStageIndex, stages.length - 1);
        updateExpressionProfile(selectedExpression, profile);
        saveProfilesToLocalStorage();
        buildStagesUI(container);
    });

    const revertBtn = document.createElement('button');
    revertBtn.className = 'fx-editor-btn';
    revertBtn.textContent = 'Flatten';
    revertBtn.title = 'Revert to single-state profile';
    revertBtn.addEventListener('click', () => {
        const lastProfile = stages[stages.length - 1]?.profile || {};
        updateExpressionProfile(selectedExpression, { ...lastProfile });
        saveProfilesToLocalStorage();
        rebuildActiveTab();
    });

    actions.append(addBtn, removeBtn, revertBtn);
    timeline.append(actions);
    group.append(timeline);

    // Stage t-value slider
    const tCtrl = { label: 'Time (t)', min: 0, max: 1, step: 0.01 };
    const { row: tRow } = createSlider(tCtrl, stages[activeStageIndex]?.t ?? 0, (val) => {
        stages[activeStageIndex].t = val;
        stages.sort((a, b) => a.t - b.t);
        // Find new index after sort
        activeStageIndex = stages.findIndex(s => s === stages.find(s2 => s2.t === val)) || activeStageIndex;
        updateExpressionProfile(selectedExpression, profile);
        saveProfilesToLocalStorage();
    });
    group.append(tRow);

    container.append(group);

    // Stage profile controls
    const stageControlsEl = document.createElement('div');
    stageControlsEl.id = 'fx-stage-profile-controls';
    container.append(stageControlsEl);
    buildStageProfileControls(stageControlsEl, profile, activeStageIndex);
}

function buildStageProfileControls(container, stagedProfile, stageIdx) {
    container.innerHTML = '';

    const stages = stagedProfile.stages;
    if (!stages || stageIdx >= stages.length) return;

    const stageProfile = stages[stageIdx].profile || {};

    const group = document.createElement('div');
    group.className = 'fx-ctrl-group';

    const title = document.createElement('div');
    title.className = 'fx-ctrl-group-title';
    title.textContent = `Stage ${stageIdx + 1} Profile`;
    group.append(title);

    for (const ctrl of EXPRESSION_CONTROLS) {
        const currentValue = stageProfile[ctrl.key];

        const onChange = (val) => {
            if (val === undefined || val === '' || val === false || val === 'rect') {
                delete stageProfile[ctrl.key];
            } else {
                stageProfile[ctrl.key] = val;
            }
            stages[stageIdx].profile = stageProfile;
            updateExpressionProfile(selectedExpression, stagedProfile);
            setExpression(selectedExpression, { force: true, skipHold: true });
            saveProfilesToLocalStorage();
        };

        if (ctrl.type === 'toggle') {
            const { row } = createToggle(ctrl, Boolean(currentValue), onChange);
            group.append(row);
        } else if (ctrl.type === 'color') {
            const { row } = createColorPicker(ctrl, currentValue || '#a855f7', onChange);
            group.append(row);
        } else if (ctrl.type === 'select') {
            const { row } = createSelect(ctrl, currentValue || ctrl.options[0], onChange);
            group.append(row);
        } else {
            const defaultVal = ctrl.key.includes('Dy') || ctrl.key.includes('Skew') ? 0 : 1;
            const { row } = createSlider(ctrl, currentValue ?? defaultVal, onChange);
            group.append(row);
        }
    }

    container.append(group);
}

// ── Persistence ─────────────────────────

function saveToLocalStorage() {
    try {
        const config = getGlitchFxConfig();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch { /* ignore */ }
}

function saveProfilesToLocalStorage() {
    try {
        localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(EXPRESSION_PROFILES));
    } catch { /* ignore */ }
}

function loadFromLocalStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const config = JSON.parse(raw);
            setGlitchFxConfig(config);
            if (config.color?.base) {
                setGlitchFxBaseColor(config.color.base);
                STATE.glitchFxBaseColor = config.color.base;
            }
        }
    } catch { /* ignore */ }

    try {
        const raw = localStorage.getItem(STORAGE_KEY_PROFILES);
        if (raw) {
            const profiles = JSON.parse(raw);
            for (const [name, profile] of Object.entries(profiles)) {
                updateExpressionProfile(name, profile);
            }
        }
    } catch { /* ignore */ }
}

function exportConfig() {
    const data = {
        config: getGlitchFxConfig(),
        profiles: structuredClone(EXPRESSION_PROFILES),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tubs-fx-config.json';
    a.click();
    URL.revokeObjectURL(url);
}

function importConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (data.config) {
                    setGlitchFxConfig(data.config);
                    if (data.config.color?.base) {
                        setGlitchFxBaseColor(data.config.color.base);
                        STATE.glitchFxBaseColor = data.config.color.base;
                    }
                    saveToLocalStorage();
                }
                if (data.profiles) {
                    for (const [name, profile] of Object.entries(data.profiles)) {
                        updateExpressionProfile(name, profile);
                    }
                    saveProfilesToLocalStorage();
                }
                // Rebuild current tab
                rebuildActiveTab();
            } catch (err) {
                console.error('[FX Editor] Import failed:', err);
            }
        };
        reader.readAsText(file);
    });
    input.click();
}

function applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    setGlitchFxConfig(structuredClone(preset));
    if (preset.color?.base) {
        setGlitchFxBaseColor(preset.color.base);
        STATE.glitchFxBaseColor = preset.color.base;
    }
    saveToLocalStorage();
    rebuildActiveTab();
}

function resetConfig() {
    setGlitchFxConfig(structuredClone(DEFAULT_CONFIG));
    setGlitchFxBaseColor(DEFAULT_CONFIG.color.base);
    STATE.glitchFxBaseColor = DEFAULT_CONFIG.color.base;
    saveToLocalStorage();
    rebuildActiveTab();
}

// ── Tab switching ───────────────────────

function rebuildActiveTab() {
    const controls = document.getElementById('fx-editor-controls');
    if (!controls) return;
    if (activeTab === 'glitch') {
        buildGlitchTab(controls);
    } else {
        buildExpressionTab(controls);
    }
}

function switchTab(tab) {
    activeTab = tab;
    const tabs = document.querySelectorAll('.fx-editor-tab');
    tabs.forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    rebuildActiveTab();
}

// ── Gaze pad ────────────────────────────

function initGazePad() {
    const pad = document.getElementById('fx-gaze-pad');
    const dot = document.getElementById('fx-gaze-dot');
    if (!pad || !dot) return;

    let dragging = false;

    function updateGaze(e) {
        const rect = pad.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
        const clampedX = Math.max(-1, Math.min(1, x));
        const clampedY = Math.max(-1, Math.min(1, y));
        dot.style.left = ((clampedX + 1) / 2 * 100) + '%';
        dot.style.top = ((clampedY + 1) / 2 * 100) + '%';

        // Dispatch a gaze event that the glitch-fx renderer picks up
        window.dispatchEvent(new CustomEvent('tubs:gaze-target', {
            detail: { x: clampedX * 0.3, y: clampedY * 0.2 },
        }));
    }

    pad.addEventListener('mousedown', (e) => {
        dragging = true;
        updateGaze(e);
    });
    document.addEventListener('mousemove', (e) => {
        if (dragging) updateGaze(e);
    });
    document.addEventListener('mouseup', () => {
        dragging = false;
    });
}

// ── Preview actions ─────────────────────

function initPreviewActions() {
    const blinkBtn = document.getElementById('fx-preview-blink');
    const speakBtn = document.getElementById('fx-preview-speak');

    if (blinkBtn) {
        blinkBtn.addEventListener('click', () => {
            // Trigger a blink via the expressions module
            import('./expressions.js').then(m => m.triggerBlink());
        });
    }

    if (speakBtn) {
        speakBtn.addEventListener('click', () => {
            previewSpeaking = !previewSpeaking;
            speakBtn.textContent = previewSpeaking ? 'Stop' : 'Speak';
            const face = document.getElementById('face');
            if (face) {
                face.classList.toggle('speaking', previewSpeaking);
            }
            if (previewSpeaking) {
                // Auto-stop after 5 seconds
                clearTimeout(previewSpeakTimer);
                previewSpeakTimer = setTimeout(() => {
                    previewSpeaking = false;
                    speakBtn.textContent = 'Speak';
                    if (face) face.classList.remove('speaking');
                }, 5000);
            } else {
                clearTimeout(previewSpeakTimer);
            }
        });
    }
}

// ── Open / Close ─────────────────────────

function openEditor() {
    if (isOpen) return;
    isOpen = true;

    const overlay = document.getElementById('fx-editor-overlay');
    if (!overlay) return;

    pauseAppProcessing();
    overlay.classList.add('open');
    rebuildActiveTab();
    initGazePad();
    initPreviewActions();
}

function closeEditor() {
    if (!isOpen) return;
    isOpen = false;

    const overlay = document.getElementById('fx-editor-overlay');
    if (!overlay) return;

    overlay.classList.remove('open');

    // Stop preview speaking
    previewSpeaking = false;
    clearTimeout(previewSpeakTimer);
    const face = document.getElementById('face');
    if (face) face.classList.remove('speaking');

    // Reset expression back to idle
    setExpression('idle', { force: true, skipHold: true });

    resumeAppProcessing();

    // Sync config to server
    syncConfigToServer();
}

export function toggleEditor() {
    if (isOpen) closeEditor();
    else openEditor();
}

export function isEditorOpen() {
    return isOpen;
}

function syncConfigToServer() {
    const config = getGlitchFxConfig();
    fetch('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            glitchFxBaseColor: config.color?.base || STATE.glitchFxBaseColor,
        }),
    }).catch(() => { });
}

// ── Init ────────────────────────────────

export function initFxEditor() {
    // Load saved config from localStorage
    loadFromLocalStorage();

    // Tab switching
    document.querySelectorAll('.fx-editor-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Header buttons
    const closeBtn = document.getElementById('fx-editor-close');
    if (closeBtn) closeBtn.addEventListener('click', closeEditor);

    const exportBtn = document.getElementById('fx-editor-export');
    if (exportBtn) exportBtn.addEventListener('click', exportConfig);

    const importBtn = document.getElementById('fx-editor-import');
    if (importBtn) importBtn.addEventListener('click', importConfig);

    const resetBtn = document.getElementById('fx-editor-reset');
    if (resetBtn) resetBtn.addEventListener('click', resetConfig);

    const presetSelect = document.getElementById('fx-editor-preset');
    if (presetSelect) {
        presetSelect.addEventListener('change', () => {
            const val = presetSelect.value;
            if (val) {
                applyPreset(val);
                presetSelect.value = ''; // reset dropdown
            }
        });
    }

    // Launch button
    const openBtn = document.getElementById('open-fx-editor');
    if (openBtn) openBtn.addEventListener('click', openEditor);
}
