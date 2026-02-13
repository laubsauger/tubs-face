function randBetween(min, max) {
    return min + Math.random() * (max - min);
}

function pickIdleVariant() {
    return Math.random() < 0.74 ? 'soft' : 'flat';
}

function pickLookTarget() {
    return {
        x: (Math.random() * 2 - 1) * 0.32,
        y: (Math.random() * 2 - 1) * 0.2,
    };
}

export function startIdleBehavior({
    isSleeping,
    isSpeaking,
    getExpression,
    setExpression,
    setIdleVariant = null,
    blink = null,
    lookAt = null,
    resetGaze = null,
    canLookAround = null,
} = {}) {
    let stopped = false;
    let blinkTimer = null;
    let behaviorTimer = null;
    let smileResetTimer = null;
    let lookResetTimer = null;

    const shouldAnimate = () => !stopped && !isSleeping() && !isSpeaking();
    const shouldIdleAnimate = () => shouldAnimate() && getExpression() === 'idle';

    function clearTimer(ref) {
        if (!ref) return null;
        clearTimeout(ref);
        return null;
    }

    function scheduleBlink() {
        blinkTimer = setTimeout(() => {
            if (stopped) return;
            if (!isSleeping() && typeof blink === 'function') {
                blink();
            }
            scheduleBlink();
        }, randBetween(3800, 6400));
    }

    function scheduleBehavior() {
        behaviorTimer = setTimeout(() => {
            if (stopped) return;
            runBehaviorStep();
            scheduleBehavior();
        }, randBetween(3600, 5800));
    }

    function runBehaviorStep() {
        if (!shouldIdleAnimate()) return;

        const roll = Math.random();

        if (roll < 0.42) {
            setExpression('smile');
            smileResetTimer = clearTimer(smileResetTimer);
            smileResetTimer = setTimeout(() => {
                if (!shouldAnimate()) return;
                if (getExpression() === 'smile') setExpression('idle');
            }, randBetween(900, 1800));
            return;
        }

        if (roll < 0.82) {
            if (typeof setIdleVariant === 'function') {
                setIdleVariant(pickIdleVariant());
            }
            return;
        }

        const allowLookAround = typeof canLookAround === 'function' ? canLookAround() : true;
        if (!allowLookAround || typeof lookAt !== 'function' || typeof resetGaze !== 'function') {
            return;
        }

        const target = pickLookTarget();
        lookAt(target.x, target.y);
        lookResetTimer = clearTimer(lookResetTimer);
        lookResetTimer = setTimeout(() => {
            if (!stopped) resetGaze();
        }, randBetween(650, 1350));
    }

    scheduleBlink();
    scheduleBehavior();

    return () => {
        stopped = true;
        blinkTimer = clearTimer(blinkTimer);
        behaviorTimer = clearTimer(behaviorTimer);
        smileResetTimer = clearTimer(smileResetTimer);
        lookResetTimer = clearTimer(lookResetTimer);
    };
}
