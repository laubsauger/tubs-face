const WAKE_PREFIXES = new Set(['hey', 'hi', 'yo', 'okay', 'ok', 'oi', 'ey', 'ay']);
const WAKE_NOISE_PREFIXES = new Set(['a', 'at', 'ah', 'uh', 'oh', 'um', 'hm', 'hmm']);
const WAKE_MATCHER_VERSION = '2026-02-10.3';
const WAKE_ALIASES = new Set([
  'tubs', 'tub', 'tubbs', 'top', 'tops', 'tab', 'tap', 'tup',
  'tob', 'toob', 'dub', 'dubs', 'tobbs', 'etab', 'hotops',
]);
const WAKE_GLUE_PREFIXES = ['h', 'ho', 'hey', 'e', 'eh', 'a', 'at', 'yo', 'ok', 'okay'];

function normalizeWakeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}

function isWakeAlias(token) {
  if (!token || token.length < 3 || token.length > 8) return false;
  const candidates = new Set([token, token.replace(/(.)\1+/g, '$1')]);

  for (const prefix of WAKE_GLUE_PREFIXES) {
    if (token.startsWith(prefix) && token.length > prefix.length + 2) {
      const stripped = token.slice(prefix.length);
      candidates.add(stripped);
      candidates.add(stripped.replace(/(.)\1+/g, '$1'));
    }
  }

  for (const candidate of candidates) {
    if (WAKE_ALIASES.has(candidate)) return true;
    if (candidate.length < 3 || candidate.length > 6) continue;

    if (levenshteinDistance(candidate, 'tubs') <= 1) return true;
    if (levenshteinDistance(candidate, 'tub') <= 1) return true;
    if (/^[td]/.test(candidate) && candidate.length >= 4 && levenshteinDistance(candidate, 'tubs') <= 2) {
      return true;
    }
  }

  return false;
}

function findWakeToken(tokens) {
  const directIndex = tokens.findIndex(isWakeAlias);
  if (directIndex !== -1) {
    return { index: directIndex, token: tokens[directIndex], source: 'token' };
  }

  if (tokens.length <= 3) {
    const compact = tokens.join('');
    if (isWakeAlias(compact)) {
      return { index: 0, token: compact, source: 'compact' };
    }

    for (let i = 0; i < tokens.length - 1; i++) {
      const merged = `${tokens[i]}${tokens[i + 1]}`;
      if (isWakeAlias(merged)) {
        return { index: i, token: merged, source: 'merged' };
      }
    }
  }

  return { index: -1, token: null, source: null };
}

function detectWakeWord(text) {
  const normalized = normalizeWakeText(text);
  if (!normalized) {
    return {
      detected: false,
      reason: 'empty',
      normalized,
      tokens: [],
      matchedToken: null,
      matchedSource: null,
    };
  }

  const tokens = normalized.split(' ');
  const wakeMatch = findWakeToken(tokens);
  const wakeIndex = wakeMatch.index;
  const prefixIndex = tokens.findIndex(token => WAKE_PREFIXES.has(token));

  const hasWakeToken = wakeIndex !== -1;
  const greetingNearWake = prefixIndex !== -1 && prefixIndex <= 1 && wakeIndex <= prefixIndex + 2;
  const greetingWithTrailingWake = hasWakeToken && prefixIndex === 0 && wakeIndex === tokens.length - 1 && tokens.length <= 8;
  const wakeFirst = wakeIndex === 0 && tokens.length <= 6;
  const standaloneWake = hasWakeToken && (
    tokens.length === 1 ||
    (tokens.length === 2 && (
      wakeIndex === 0 ||
      WAKE_PREFIXES.has(tokens[0]) ||
      WAKE_NOISE_PREFIXES.has(tokens[0])
    ))
  );

  const detected = hasWakeToken && (greetingNearWake || greetingWithTrailingWake || wakeFirst || standaloneWake);
  const reason = !hasWakeToken
    ? 'no_wake_token'
    : greetingNearWake
      ? 'greeting_near_wake'
      : greetingWithTrailingWake
        ? 'greeting_with_trailing_wake'
      : wakeFirst
        ? 'wake_first'
        : standaloneWake
          ? 'standalone_wake'
          : 'wake_token_not_addressed';

  return {
    detected,
    reason,
    normalized,
    tokens,
    matchedToken: hasWakeToken ? wakeMatch.token : null,
    matchedSource: wakeMatch.source,
  };
}

module.exports = { detectWakeWord, findWakeToken, isWakeAlias, WAKE_MATCHER_VERSION };
