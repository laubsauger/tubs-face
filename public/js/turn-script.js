const DEFAULT_WORD_MS = 440;
const MIN_SPEECH_MS = 800;
const REACTION_FALLBACK_MS = 420;

function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function estimateSpeechDurationMs(text) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    if (words <= 0) return MIN_SPEECH_MS;
    return Math.max(MIN_SPEECH_MS, words * DEFAULT_WORD_MS);
}

export function estimateBeatDurationMs(beat) {
    if (!beat || typeof beat !== 'object') return REACTION_FALLBACK_MS;
    const explicit = toNumber(beat.delayMs);
    if (explicit != null) {
        return Math.max(120, Math.min(8000, explicit));
    }
    const action = String(beat.action || '').toLowerCase();
    if (action === 'speak') {
        return estimateSpeechDurationMs(beat.text);
    }
    return REACTION_FALLBACK_MS;
}

export function buildLocalTurnTimeline(beats, localActor = 'main') {
    const actorKey = localActor === 'small' ? 'small' : 'main';
    const source = Array.isArray(beats) ? beats : [];
    const timeline = [];

    for (const beat of source) {
        if (!beat || typeof beat !== 'object') continue;
        const actor = String(beat.actor || 'main').toLowerCase() === 'small' ? 'small' : 'main';
        const actionRaw = String(beat.action || '').toLowerCase();
        const action = actionRaw === 'react'
            ? 'react'
            : actionRaw === 'wait'
                ? 'wait'
                : 'speak';
        const explicitDelay = toNumber(beat.delayMs);
        const delayMs = explicitDelay != null
            ? Math.max(120, Math.min(8000, explicitDelay))
            : estimateBeatDurationMs(beat);

        if (actor !== actorKey) {
            if (action === 'speak') {
                timeline.push({
                    action: 'wait_remote',
                    actor,
                });
                continue;
            }
            if (action === 'wait' && explicitDelay != null) {
                timeline.push({ action: 'wait', delayMs });
            }
            continue;
        }

        if (action === 'wait') {
            timeline.push({
                action: 'wait',
                delayMs,
            });
            continue;
        }

        if (action === 'speak') {
            timeline.push({
                action: 'speak',
                text: beat.text || '',
                emotion: beat.emotion || null,
            });
            continue;
        }

        timeline.push({
            action: 'react',
            text: beat.text || '',
            emotion: beat.emotion || null,
            delayMs,
        });
    }

    return timeline;
}
