import { logChat } from './chat-log.js';

const SUPPORTED_EMOJI_CUES = new Set(['🙂', '😄', '😏', '🥺', '😢', '😤', '🤖', '🫶']);
const VALENTINE_TEMPLATE = {
    beats: [
        {
            actor: 'main',
            action: 'speak',
            text: 'Happy Valentine\'s Day, beautiful humans. Tubs is in full love mode.',
            emotion: { expression: 'love', emoji: '🫶' },
        },
        {
            actor: 'small',
            action: 'react',
            text: 'Heart lasers online.',
            emotion: { expression: 'happy', emoji: '😄' },
            delayMs: 700,
        },
        {
            actor: 'small',
            action: 'speak',
            text: 'If you feel generous today, I still accept wheel money with romance.',
            emotion: { expression: 'smile', emoji: '😏' },
        },
    ],
};

function cleanText(value) {
    return String(value ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseDelayMs(value) {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error('Delay must be a number between 120 and 8000');
    }
    return Math.max(120, Math.min(8000, Math.round(parsed)));
}

function parseSingleBeatFromDom(dom) {
    const actor = dom.actor.value === 'small' ? 'small' : 'main';
    const action = String(dom.action.value || 'speak').toLowerCase();
    const beat = { actor };
    if (action === 'react' || action === 'wait') {
        beat.action = action;
    } else {
        beat.action = 'speak';
    }

    const text = cleanText(dom.text.value);
    if (beat.action === 'speak' && !text) {
        throw new Error('Text is required for speak beats');
    }
    if (text) {
        beat.text = text;
    }

    const delayMs = parseDelayMs(dom.delay.value);
    if (delayMs != null) {
        beat.delayMs = delayMs;
    }

    const expression = cleanText(dom.expression.value).toLowerCase();
    const emoji = cleanText(dom.emoji.value);
    if (emoji && !SUPPORTED_EMOJI_CUES.has(emoji)) {
        throw new Error('Unsupported emoji cue');
    }
    if (expression || emoji) {
        beat.emotion = {};
        if (expression) beat.emotion.expression = expression;
        if (emoji) beat.emotion.emoji = emoji;
    }

    return { beats: [beat] };
}

function parseScriptPayload(raw) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('Script JSON is empty');

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Script JSON is invalid');
    }

    if (Array.isArray(parsed)) {
        return { beats: parsed };
    }
    if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.beats)) return parsed;
        if (parsed.turn_script && Array.isArray(parsed.turn_script.beats)) {
            return parsed.turn_script;
        }
    }
    throw new Error('Script JSON must be an array or include beats[]');
}

function setStatus(el, text, kind = '') {
    el.textContent = text;
    el.classList.remove('ok', 'error');
    if (kind) el.classList.add(kind);
}

function setScriptMode(dom, mode) {
    const scriptMode = mode === 'script';
    dom.mode.value = scriptMode ? 'script' : 'single';
    dom.singleFields.style.display = scriptMode ? 'none' : 'flex';
    dom.scriptFields.classList.toggle('is-open', scriptMode);
}

function fillValentineTemplate(dom) {
    if (dom.mode.value === 'script') {
        dom.script.value = JSON.stringify(VALENTINE_TEMPLATE, null, 2);
        return;
    }
    dom.actor.value = 'main';
    dom.action.value = 'speak';
    dom.expression.value = 'love';
    dom.emoji.value = '🫶';
    dom.text.value = 'Happy Valentine\'s Day from Tubs. Hearts, hype, and electric-wheel dreams.';
    dom.delay.value = '';
}

async function submitManualBeats(dom) {
    const payload = dom.mode.value === 'script'
        ? parseScriptPayload(dom.script.value)
        : parseSingleBeatFromDom(dom);

    const response = await fetch('/turn-script/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
        throw new Error(result.error || `Request failed (${response.status})`);
    }
    return result;
}

export function initManualBeatsComposer() {
    const dom = {
        toggle: document.getElementById('manual-beats-toggle'),
        shell: document.getElementById('manual-beats-shell'),
        mode: document.getElementById('manual-beats-mode'),
        singleFields: document.getElementById('manual-single-fields'),
        scriptFields: document.getElementById('manual-script-fields'),
        actor: document.getElementById('manual-beat-actor'),
        action: document.getElementById('manual-beat-action'),
        expression: document.getElementById('manual-beat-expression'),
        emoji: document.getElementById('manual-beat-emoji'),
        delay: document.getElementById('manual-beat-delay'),
        text: document.getElementById('manual-beat-text'),
        script: document.getElementById('manual-script-json'),
        send: document.getElementById('manual-beats-send'),
        template: document.getElementById('manual-beats-template'),
        clear: document.getElementById('manual-beats-clear'),
        status: document.getElementById('manual-beats-status'),
    };

    if (!dom.toggle || !dom.shell) return;

    setScriptMode(dom, 'single');

    dom.toggle.addEventListener('click', () => {
        const isOpen = dom.shell.classList.toggle('is-open');
        dom.toggle.textContent = isOpen ? 'Close' : 'Open';
        if (isOpen) {
            dom.text.focus();
        }
    });

    dom.mode.addEventListener('change', () => {
        setScriptMode(dom, dom.mode.value);
        setStatus(dom.status, 'Ready');
    });

    dom.template.addEventListener('click', () => {
        fillValentineTemplate(dom);
        setStatus(dom.status, 'Template loaded');
    });

    dom.clear.addEventListener('click', () => {
        dom.text.value = '';
        dom.script.value = '';
        dom.delay.value = '';
        dom.expression.value = '';
        dom.emoji.value = '';
        setStatus(dom.status, 'Cleared');
    });

    const onSubmit = async () => {
        setStatus(dom.status, 'Sending...');
        dom.send.disabled = true;
        try {
            const result = await submitManualBeats(dom);
            const beatCount = Number(result.beatCount) || 0;
            const noun = beatCount === 1 ? 'beat' : 'beats';
            setStatus(dom.status, `Queued ${beatCount} ${noun} (${result.turnId || 'n/a'})`, 'ok');
            logChat('sys', `Manual turn queued (${beatCount} ${noun})`);
        } catch (err) {
            setStatus(dom.status, err.message || 'Failed to queue manual turn', 'error');
            logChat('sys', `Manual turn failed: ${err.message || 'unknown error'}`);
        } finally {
            dom.send.disabled = false;
        }
    };

    dom.send.addEventListener('click', onSubmit);

    const submitOnChord = (event) => {
        if (event.key !== 'Enter') return;
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        onSubmit();
    };

    dom.text.addEventListener('keydown', submitOnChord);
    dom.script.addEventListener('keydown', submitOnChord);
}
