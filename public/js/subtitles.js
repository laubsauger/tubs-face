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
                const globalIdx = Math.min(Math.floor(t * totalWords), totalWords - 1);
                if (globalIdx >= 0) updateHighlightTo(globalIdx);

                subtitleRafId = requestAnimationFrame(tick);
            }

            subtitleRafId = requestAnimationFrame(tick);
            return;
        }

        const duration = (typeof source === 'number' && source > 0) ? source : totalWords * 0.35;
        const msPerWord = (duration * 0.85 * 1000) / totalWords;
        let flatIdx = 0;

        currentSegIdx = 0;
        renderSegment(segBounds[0].words);

        subtitleTimer = setInterval(() => {
            if (flatIdx >= totalWords) {
                stop();
                return;
            }
            updateHighlightTo(flatIdx);
            flatIdx += 1;
        }, msPerWord);
    }

    return { start, stop };
}

