const DEFAULT_MAX_SEGMENT_CHARS = 36;

function segmentText(text: string, maxSegmentChars = DEFAULT_MAX_SEGMENT_CHARS): string[][] {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const segments: string[][] = [];
  let current: string[] = [];
  let length = 0;

  for (const word of words) {
    const added = length === 0 ? word.length : length + 1 + word.length;
    if (added > maxSegmentChars && current.length > 0) {
      segments.push(current);
      current = [word];
      length = word.length;
    } else {
      current.push(word);
      length = added;
    }
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

export interface SubtitleController {
  start(text: string, source?: HTMLAudioElement | number): void;
  stop(): void;
  finish(): void;
}

export function createSubtitleController(element: HTMLElement | null, maxSegmentChars = DEFAULT_MAX_SEGMENT_CHARS): SubtitleController {
  let rafId = 0;
  let audioRef: HTMLAudioElement | null = null;

  function renderSegment(words: string[]): void {
    if (!element) {
      return;
    }
    element.innerHTML = words.map((word) => `<span class="subtitle-word">${escapeHtml(word)}</span>`).join(' ');
    element.classList.add('is-visible');
  }

  function stop(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    audioRef = null;
    if (!element) {
      return;
    }
    element.classList.remove('is-visible');
    element.innerHTML = '';
  }

  function finish(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    audioRef = null;
    if (!element) {
      return;
    }
    element.querySelectorAll<HTMLElement>('.subtitle-word').forEach((node) => {
      node.classList.remove('is-active');
      node.classList.add('is-spoken');
    });
  }

  function start(text: string, source?: HTMLAudioElement | number): void {
    stop();
    if (!element) {
      return;
    }

    const normalized = String(text || '').trim();
    if (!normalized) {
      return;
    }

    const segments = segmentText(normalized, maxSegmentChars);
    const allWords = segments.flat();
    if (allWords.length === 0) {
      return;
    }

    const weights = allWords.map((word) => Math.max(2, word.length));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const cumulativeWeights = [0];
    for (const weight of weights) {
      const previousWeight = cumulativeWeights[cumulativeWeights.length - 1] ?? 0;
      cumulativeWeights.push(previousWeight + weight);
    }

    const segmentBounds = segments.map((words, index) => ({
      start: segments.slice(0, index).reduce((sum, segment) => sum + segment.length, 0),
      end: segments.slice(0, index + 1).reduce((sum, segment) => sum + segment.length, 0),
      words,
    }));

    let currentSegmentIndex = 0;
    let lastWordIndex = -1;
    renderSegment(segmentBounds[0]?.words ?? []);

    const timeToWordIndex = (ratio: number): number => {
      const target = ratio * totalWeight;
      let low = 0;
      let high = allWords.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((cumulativeWeights[mid] ?? 0) <= target) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      return low;
    };

    const updateHighlight = (globalIndex: number) => {
      const segmentIndex = segmentBounds.findIndex((segment) => globalIndex >= segment.start && globalIndex < segment.end);
      const nextSegmentIndex = segmentIndex === -1 ? 0 : segmentIndex;
      const activeSegment = segmentBounds[nextSegmentIndex];
      if (!activeSegment) {
        return;
      }

      if (nextSegmentIndex !== currentSegmentIndex) {
        currentSegmentIndex = nextSegmentIndex;
        renderSegment(activeSegment.words);
        lastWordIndex = -1;
      }

      const localIndex = globalIndex - activeSegment.start;
      if (localIndex <= lastWordIndex) {
        return;
      }

      const wordNodes = element.querySelectorAll<HTMLElement>('.subtitle-word');
      for (let index = lastWordIndex + 1; index <= localIndex; index += 1) {
        const previousNode = wordNodes[index - 1];
        const currentNode = wordNodes[index];
        if (index > 0 && previousNode) {
          previousNode.classList.remove('is-active');
          previousNode.classList.add('is-spoken');
        }
        if (currentNode) {
          currentNode.classList.add('is-active');
        }
      }
      lastWordIndex = localIndex;
    };

    const durationSeconds = typeof source === 'number'
      ? source
      : source instanceof HTMLAudioElement && Number.isFinite(source.duration) && source.duration > 0
        ? source.duration
        : allWords.length * 0.35;

    if (source instanceof HTMLAudioElement) {
      audioRef = source;
    }

    const startedAt = performance.now();
    const tick = () => {
      const ratio = audioRef
        ? Math.min(0.99, audioRef.currentTime / Math.max(audioRef.duration, 0.1))
        : Math.min(0.99, (performance.now() - startedAt) / Math.max(durationSeconds * 850, 1));
      const wordIndex = Math.min(allWords.length - 1, timeToWordIndex(ratio));
      updateHighlight(wordIndex);

      if (ratio >= 0.99 || (audioRef && audioRef.ended)) {
        finish();
        return;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
  }

  return {
    start,
    stop,
    finish,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
