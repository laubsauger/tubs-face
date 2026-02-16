const DEFAULT_MAX_SEGMENT_CHARS = 36;

function segmentText(text, maxSegmentChars = DEFAULT_MAX_SEGMENT_CHARS) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const segments = [];
    let current = [];
    let len = 0;

    for (const word of words) {
        const added = len === 0 ? word.length : len + 1 + word.length;
        if (added > maxSegmentChars && current.length > 0) {
            segments.push(current);
            current = [word];
            len = word.length;
        } else {
            current.push(word);
            len = added;
        }
    }

    if (current.length) segments.push(current);
    return segments;
}

export function createSubtitleController(element, options = {}) {
    const subtitleEl = element || null;
    const maxSegmentChars = Number(options.maxSegmentChars) || DEFAULT_MAX_SEGMENT_CHARS;

    let subtitleTimer = null;
    let subtitleRafId = null;
    let subtitleAudioRef = null;

    function renderSegment(words) {
        if (!subtitleEl) return;
        subtitleEl.innerHTML = words.map((word) => `<span class="word">${word}</span> `).join('');
        subtitleEl.classList.add('visible');
    }

    function stop() {
        if (subtitleRafId) {
            cancelAnimationFrame(subtitleRafId);
            subtitleRafId = null;
        }
        subtitleAudioRef = null;
        if (subtitleTimer) {
            clearInterval(subtitleTimer);
            subtitleTimer = null;
        }
        if (!subtitleEl) return;
        subtitleEl.classList.remove('visible');
        subtitleEl.innerHTML = '';
    }

    function start(text, source) {
        stop();
        if (!subtitleEl) return;

        const normalizedText = String(text || '').trim();
        if (!normalizedText) return;

        const segments = segmentText(normalizedText, maxSegmentChars);
        const totalWords = segments.reduce((count, seg) => count + seg.length, 0);
        if (!totalWords) return;

        let cumulative = 0;
        const segBounds = segments.map((seg) => {
            const startWord = cumulative;
            cumulative += seg.length;
            return { start: startWord, end: cumulative, words: seg };
        });

        // Character-weighted timing: longer words get proportionally more duration
        const allWords = segBounds.flatMap(s => s.words);
        const weights = allWords.map(w => Math.max(w.length, 2));
        const totalWeight = weights.reduce((sum, w) => sum + w, 0);
        // cumWeight[i] = sum of weights[0..i-1]
        const cumWeight = [0];
        for (let i = 0; i < weights.length; i++) cumWeight.push(cumWeight[i] + weights[i]);

        function timeToWordIndex(t) {
            const target = t * totalWeight;
            let lo = 0, hi = allWords.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (cumWeight[mid] <= target) lo = mid; else hi = mid - 1;
            }
            return lo;
        }

        let currentSegIdx = -1;
        let lastWordInSeg = -1;

        function updateHighlightTo(globalIdx) {
            let segIdx = 0;
            for (let i = 0; i < segBounds.length; i++) {
                if (globalIdx >= segBounds[i].start && globalIdx < segBounds[i].end) {
                    segIdx = i;
                    break;
                }
            }

            if (segIdx !== currentSegIdx) {
                currentSegIdx = segIdx;
                renderSegment(segBounds[segIdx].words);
                lastWordInSeg = -1;
            }

            const localIdx = globalIdx - segBounds[segIdx].start;
            if (localIdx > lastWordInSeg) {
                const wordEls = subtitleEl.querySelectorAll('.word');
                for (let i = lastWordInSeg + 1; i <= localIdx; i++) {
                    if (i > 0 && wordEls[i - 1]) {
                        wordEls[i - 1].classList.remove('active');
                        wordEls[i - 1].classList.add('spoken');
                    }
                    if (wordEls[i]) wordEls[i].classList.add('active');
                }
                lastWordInSeg = localIdx;
            }
        }

        subtitleEl.classList.add('visible');

        if (source instanceof HTMLAudioElement && isFinite(source.duration) && source.duration > 0) {
            subtitleAudioRef = source;
            const duration = source.duration;

            currentSegIdx = 0;
            renderSegment(segBounds[0].words);

            function tick() {
                if (!subtitleAudioRef || subtitleAudioRef.ended) return;

                const t = Math.min(subtitleAudioRef.currentTime / duration, 0.99);
                const globalIdx = Math.min(timeToWordIndex(t), totalWords - 1);
                if (globalIdx >= 0) updateHighlightTo(globalIdx);

                subtitleRafId = requestAnimationFrame(tick);
            }

            subtitleRafId = requestAnimationFrame(tick);
            return;
        }

        const duration = (typeof source === 'number' && source > 0) ? source : totalWords * 0.35;
        const totalDurationMs = duration * 0.85 * 1000;
        const startTime = performance.now();

        currentSegIdx = 0;
        renderSegment(segBounds[0].words);

        function timerTick() {
            const elapsed = performance.now() - startTime;
            if (elapsed >= totalDurationMs) {
                stop();
                return;
            }
            const t = Math.min(elapsed / totalDurationMs, 0.99);
            const globalIdx = Math.min(timeToWordIndex(t), totalWords - 1);
            if (globalIdx >= 0) updateHighlightTo(globalIdx);
            subtitleRafId = requestAnimationFrame(timerTick);
        }
        subtitleRafId = requestAnimationFrame(timerTick);
    }

    function finish() {
        if (subtitleRafId) { cancelAnimationFrame(subtitleRafId); subtitleRafId = null; }
        subtitleAudioRef = null;
        if (subtitleTimer) { clearInterval(subtitleTimer); subtitleTimer = null; }
        if (!subtitleEl) return;
        subtitleEl.querySelectorAll('.word').forEach(el => {
            el.classList.remove('active');
            el.classList.add('spoken');
        });
    }

    return { start, stop, finish };
}

