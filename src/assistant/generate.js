const {
  VISION_SYSTEM_ADDENDUM,
  APPEARANCE_SYSTEM_ADDENDUM,
  MAX_OUTPUT_SENTENCES,
  DONATION_MARKER,
  DONATION_MARKER_RE,
  DEFAULT_VENMO_HANDLE,
  DUAL_HEAD_RESPONSE_SCHEMA,
  hasVisionIntent,
} = require('./constants');
const {
  normalizeInput,
  stripFormatting,
  clampOutput,
  estimateTokens,
  estimateCostUsd,
} = require('./text');
const {
  splitTrailingEmotionEmoji,
  defaultDualHeadSpeakEmotion,
} = require('./emotion');
const {
  buildDonationPayload,
  extractDonationSignal,
  stripDonationMarkers,
  maybeInjectDonationNudge,
} = require('./donation');
const {
  getAssistantReplyCount,
  incrementAssistantReplyCount,
  getHasWarnedMissingApiKey,
  setHasWarnedMissingApiKey,
  extractMemory,
  pushHistory,
  getHistoryMeta,
  buildContents,
  buildProactiveContents,
  sanitizeContentsForTelemetry,
  emitTurnContextMeta,
  buildSystemInstruction,
} = require('./context');
const {
  shouldUseDualHeadDirectedMode,
  buildDualHeadSystemInstruction,
  parseDualHeadScript,
  rescueBeatsFromRawText,
  hasRequiredDualHeadCoverage,
  mergeDonationSignalFromBeats,
  summarizeDualHeadBeatsForLog,
} = require('./dual-head');
const { runtimeConfig } = require('../config');
const { pickGreetingResponse } = require('../persona');
const { generateGeminiContent, streamGeminiContent } = require('../gemini-client');
const { generateDemoResponse } = require('../demo-response');

async function generateAssistantReply(userText) {
  const normalizedInput = normalizeInput(userText);
  if (!normalizedInput) {
    return {
      text: 'I did not catch that. Try again.',
      source: 'empty',
      model: runtimeConfig.llmModel,
      tokens: { in: 1, out: 8 },
      latencyMs: 0,
    };
  }

  const startedAt = Date.now();
  const greeting = pickGreetingResponse(normalizedInput);
  extractMemory(normalizedInput);

  if (greeting) {
    const parsed = splitTrailingEmotionEmoji(greeting);
    const greetingText = parsed.text || 'Hey.';
    pushHistory('user', normalizedInput);
    pushHistory('model', greetingText);
    incrementAssistantReplyCount();
    return {
      text: greetingText,
      source: 'greeting',
      model: 'fast-greeting',
      tokens: { in: estimateTokens(normalizedInput), out: estimateTokens(greetingText) },
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      donation: buildDonationPayload(false),
      emotion: parsed.emotion,
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !getHasWarnedMissingApiKey()) {
    setHasWarnedMissingApiKey(true);
    console.warn('[LLM] GEMINI_API_KEY missing. Falling back to demo responses.');
  }

  let responseText = '';
  let rawEmotion = null;
  let preclampDonation = null;
  let source = 'llm';
  let model = runtimeConfig.llmModel;
  let usageIn = 0;
  let usageOut = 0;

  if (apiKey) {
    try {
      const llmResult = await generateGeminiContent({
        apiKey,
        model: runtimeConfig.llmModel,
        systemInstruction: buildSystemInstruction(),
        contents: buildContents(normalizedInput),
        maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
        temperature: 1,
      });
      console.log(`[LLM] Raw response (${llmResult.text.length} chars): ${llmResult.text}`);
      const cleanedText = stripFormatting(llmResult.text);
      const rawEmoji = splitTrailingEmotionEmoji(cleanedText);
      rawEmotion = rawEmoji.emotion;
      preclampDonation = extractDonationSignal(rawEmoji.text);
      responseText = clampOutput(preclampDonation.text);
      console.log(`[LLM] After clampOutput (${responseText.length} chars, emoji=${rawEmoji.emoji || 'none'}): ${responseText}`);
      model = llmResult.model || model;
      usageIn = Number(llmResult.usage.promptTokenCount || 0);
      usageOut = Number(llmResult.usage.candidatesTokenCount || 0);
    } catch (err) {
      console.error('[LLM] Gemini call failed:', err.message);
      source = 'fallback';
      model = 'fallback-demo';
    }
  } else {
    source = 'fallback';
    model = 'fallback-demo';
  }

  if (!responseText) {
    const fallbackText = generateDemoResponse(normalizedInput);
    const fallbackEmoji = splitTrailingEmotionEmoji(fallbackText);
    rawEmotion = rawEmotion || fallbackEmoji.emotion;
    preclampDonation = extractDonationSignal(fallbackEmoji.text);
    responseText = clampOutput(preclampDonation.text);
  }

  const emotion = rawEmotion;

  const donationSignal = preclampDonation || extractDonationSignal(responseText);
  const nudged = maybeInjectDonationNudge(donationSignal.text, donationSignal.donation.show, getAssistantReplyCount());
  responseText = clampOutput(nudged.text);
  console.log(`[LLM] After 2nd clampOutput (${responseText.length} chars): ${responseText}`);
  if (!responseText) {
    responseText = `Please help my wheel fund on Venmo @${DEFAULT_VENMO_HANDLE} so Rapha can see Thailand.`;
  }

  const finalDonation = nudged.forcedQr
    ? buildDonationPayload(true, 'periodic_nudge')
    : donationSignal.donation;

  pushHistory('user', normalizedInput);
  pushHistory('model', responseText);
  incrementAssistantReplyCount();

  const tokensIn = usageIn || estimateTokens(normalizedInput);
  const tokensOut = usageOut || estimateTokens(responseText);
  const costUsd = estimateCostUsd(tokensIn, tokensOut);

  return {
    text: responseText,
    source,
    model,
    tokens: {
      in: tokensIn,
      out: tokensOut,
    },
    costUsd,
    donation: finalDonation,
    emotion,
    latencyMs: Date.now() - startedAt,
  };
}

async function generateDualHeadProactiveReply({ context, broadcast, turnId, startedAt }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  console.log(`[LLM:dual-proactive] turn=${turnId} enabled=${runtimeConfig.dualHeadEnabled} mode=${runtimeConfig.dualHeadMode}`);

  const proactiveAddendum =
    'PROACTIVE: You are starting conversation unprompted. ' + context + '\n' +
    'One punchy sentence from main. Small head should chime in with something creative \u2014 a roast, a jab, an unhinged observation. Tiny Tubs has no filter.';

  const systemInst = buildDualHeadSystemInstruction(buildSystemInstruction()) + '\n\n' + proactiveAddendum;
  const contents = buildProactiveContents();

  let model = runtimeConfig.llmModel;
  let usageIn = 0;
  let usageOut = 0;
  let script;
  let llmRawText = '';
  const dualMaxOutputTokens = Number(runtimeConfig.llmMaxOutputTokens || 256);

  try {
    const llmResult = await generateGeminiContent({
      apiKey,
      model: runtimeConfig.llmModel,
      systemInstruction: systemInst,
      contents,
      maxOutputTokens: dualMaxOutputTokens,
      temperature: 0.7,
      timeoutMs: 18000,
      responseMimeType: 'application/json',
      responseSchema: DUAL_HEAD_RESPONSE_SCHEMA,
    });

    llmRawText = llmResult.text;
    model = llmResult.model || model;
    usageIn = Number(llmResult.usage.promptTokenCount || 0);
    usageOut = Number(llmResult.usage.candidatesTokenCount || 0);
    console.log(`[LLM:dual-proactive] Raw response (${llmRawText.length} chars): ${llmRawText}`);
    script = parseDualHeadScript(llmResult.text);
  } catch (err) {
    console.error('[LLM:dual-proactive] Gemini call failed:', err.message);
    return null;
  }

  if (!script) {
    console.warn('[LLM:dual-proactive] Invalid script JSON, attempting regex rescue from raw text.');
    const rescued = rescueBeatsFromRawText(llmRawText);
    if (rescued) {
      if (hasRequiredDualHeadCoverage(rescued.beats)) {
        script = rescued;
      } else {
        console.warn('[LLM:dual-proactive] Rescue output missing playable speak beats.');
      }
    }
  }
  if (!script || !hasRequiredDualHeadCoverage(script.beats)) {
    console.warn('[LLM:dual-proactive] No valid dual-head script returned by LLM.');
    return null;
  }

  const merged = mergeDonationSignalFromBeats(script.beats);
  let beats = merged.beats;
  let donation = merged.donation;
  let fullText = beats
    .filter((beat) => beat.action === 'speak')
    .map((beat) => beat.text)
    .join(' ')
    .trim();

  const nudged = maybeInjectDonationNudge(fullText, donation.show, getAssistantReplyCount());
  if (nudged.forcedQr) {
    donation = buildDonationPayload(true, 'periodic_nudge');
    const nudgeText = `Venmo @${DEFAULT_VENMO_HANDLE}.`;
    beats = [...beats, { actor: 'main', action: 'speak', text: nudgeText, emotion: defaultDualHeadSpeakEmotion('main') }];
    fullText = `${fullText} ${nudgeText}`.trim();
  }

  fullText = clampOutput(fullText);
  if (!fullText) {
    return null;
  }

  broadcast({
    type: 'turn_script',
    turnId,
    beats,
    donation,
    fullText,
  });
  console.log(`[LLM:dual-proactive] turn_script turn=${turnId} beats=${beats.length} donation=${donation?.show ? donation.reason : 'none'} ${summarizeDualHeadBeatsForLog(beats)}`);

  pushHistory('model', fullText);
  incrementAssistantReplyCount();

  const primaryEmotion = beats.find((beat) => beat.actor === 'main' && beat.emotion)?.emotion || null;
  const tokensIn = usageIn || estimateTokens(context);
  const tokensOut = usageOut || estimateTokens(fullText);
  const costUsd = estimateCostUsd(tokensIn, tokensOut);

  return {
    text: fullText,
    source: 'llm-dual-head-proactive',
    model,
    tokens: { in: tokensIn, out: tokensOut },
    costUsd,
    donation,
    emotion: primaryEmotion,
    latencyMs: Date.now() - startedAt,
    beats,
  };
}

async function generateProactiveReply(context) {
  const startedAt = Date.now();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const proactiveInstruction = buildSystemInstruction() + '\n\n' +
    'PROACTIVE: You are starting conversation unprompted. ' + context + '\n' +
    'One punchy sentence. Be curious, weird, or provocative \u2014 make them want to respond.';

  const contents = buildProactiveContents();

  let responseText = '';
  let rawEmotion = null;
  let donationSignal = null;
  let model = runtimeConfig.llmModel;
  let usageIn = 0;
  let usageOut = 0;

  try {
    const llmResult = await generateGeminiContent({
      apiKey,
      model: runtimeConfig.llmModel,
      systemInstruction: proactiveInstruction,
      contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: 1,
    });
    console.log(`[LLM:proactive] Raw response (${llmResult.text.length} chars): ${llmResult.text}`);
    const cleanedText = stripFormatting(llmResult.text);
    const rawEmoji = splitTrailingEmotionEmoji(cleanedText);
    rawEmotion = rawEmoji.emotion;
    const preclampSignal = extractDonationSignal(rawEmoji.text);
    donationSignal = preclampSignal;
    responseText = clampOutput(preclampSignal.text);
    console.log(`[LLM:proactive] After clampOutput (${responseText.length} chars, emoji=${rawEmoji.emoji || 'none'}): ${responseText}`);
    model = llmResult.model || model;
    usageIn = Number(llmResult.usage.promptTokenCount || 0);
    usageOut = Number(llmResult.usage.candidatesTokenCount || 0);
  } catch (err) {
    console.error('[LLM] Proactive generation failed:', err.message);
    return null;
  }

  if (!responseText) return null;

  const emotion = rawEmotion;

  if (!donationSignal) donationSignal = extractDonationSignal(responseText);
  responseText = clampOutput(donationSignal.text);
  console.log(`[LLM:proactive] Final (${responseText.length} chars): ${responseText}`);
  if (!responseText) return null;

  pushHistory('model', responseText);
  incrementAssistantReplyCount();

  const tokensIn = usageIn || estimateTokens(context);
  const tokensOut = usageOut || estimateTokens(responseText);
  const costUsd = estimateCostUsd(tokensIn, tokensOut);

  return {
    text: responseText,
    source: 'proactive',
    model,
    tokens: { in: tokensIn, out: tokensOut },
    costUsd,
    donation: donationSignal.donation,
    emotion,
    latencyMs: Date.now() - startedAt,
  };
}

async function generateDualHeadDirectedReply({
  normalizedInput,
  apiKey,
  turnId,
  broadcast,
  frame,
  appearanceFrame,
  startedAt,
  timingHooks,
}) {
  console.log(`[LLM:dual] turn=${turnId} enabled=${runtimeConfig.dualHeadEnabled} mode=${runtimeConfig.dualHeadMode}`);
  const useVision = hasVisionIntent(normalizedInput) && frame;
  const useAppearance = !useVision && appearanceFrame?.data;
  const imageToSend = useVision ? frame : useAppearance ? appearanceFrame.data : null;
  const mode = useVision ? 'vision' : useAppearance ? 'appearance' : 'text';

  let systemInst = buildDualHeadSystemInstruction(buildSystemInstruction());
  if (useVision) {
    systemInst += '\n\n' + VISION_SYSTEM_ADDENDUM;
  } else if (useAppearance) {
    systemInst += '\n\n' + APPEARANCE_SYSTEM_ADDENDUM;
  }
  const contentBundle = buildContents(normalizedInput, imageToSend, { returnMeta: true });
  const contextMeta = {
    mode,
    imageAttached: contentBundle.imageAttached,
    historyMessages: contentBundle.historyMessages,
    historyChars: contentBundle.historyChars,
  };
  emitTurnContextMeta({ turnId, broadcast, timingHooks, meta: contextMeta });

  let model = runtimeConfig.llmModel;
  let usageIn = 0;
  let usageOut = 0;
  let script;
  let llmRawText = '';
  const llmStartAt = Date.now();
  let llmEndAt = null;
  const dualMaxOutputTokens = Number(runtimeConfig.llmMaxOutputTokens || 256);

  try {
    const llmResult = await generateGeminiContent({
      apiKey,
      model: runtimeConfig.llmModel,
      systemInstruction: systemInst,
      contents: contentBundle.contents,
      maxOutputTokens: dualMaxOutputTokens,
      temperature: 0.7,
      timeoutMs: 18000,
      responseMimeType: 'application/json',
      responseSchema: DUAL_HEAD_RESPONSE_SCHEMA,
    });

    llmEndAt = Date.now();
    llmRawText = llmResult.text;
    console.log(`[LLM:dual] Raw response (${llmRawText.length} chars): ${llmRawText}`);
    model = llmResult.model || model;
    usageIn = Number(llmResult.usage.promptTokenCount || 0);
    usageOut = Number(llmResult.usage.candidatesTokenCount || 0);
    script = parseDualHeadScript(llmResult.text);
  } catch (err) {
    llmEndAt = Date.now();
    console.error('[LLM:dual] Gemini call failed:', err.message);
    return null;
  }

  if (!script) {
    console.warn('[LLM:dual] Invalid script JSON, attempting regex rescue from raw text.');
    const rescued = rescueBeatsFromRawText(llmRawText);
    if (rescued) {
      if (hasRequiredDualHeadCoverage(rescued.beats)) {
        script = rescued;
      } else {
        console.warn('[LLM:dual] Rescue output missing playable speak beats.');
      }
    }
  }
  if (!script || !hasRequiredDualHeadCoverage(script.beats)) {
    console.warn('[LLM:dual] No valid dual-head script returned by LLM.');
    return null;
  }

  const merged = mergeDonationSignalFromBeats(script.beats);
  let beats = merged.beats;
  let donation = merged.donation;
  let fullText = beats
    .filter((beat) => beat.action === 'speak')
    .map((beat) => beat.text)
    .join(' ')
    .trim();

  const nudged = maybeInjectDonationNudge(fullText, donation.show, getAssistantReplyCount());
  if (nudged.forcedQr) {
    donation = buildDonationPayload(true, 'periodic_nudge');
    const nudgeText = `Venmo @${DEFAULT_VENMO_HANDLE}.`;
    beats = [...beats, { actor: 'main', action: 'speak', text: nudgeText, emotion: defaultDualHeadSpeakEmotion('main') }];
    fullText = `${fullText} ${nudgeText}`.trim();
  }

  fullText = clampOutput(fullText);
  if (!fullText) {
    return null;
  }

  broadcast({
    type: 'turn_script',
    turnId,
    beats,
    donation,
    fullText,
  });
  if (timingHooks?.onFirstToken) {
    timingHooks.onFirstToken('turn_script');
  }
  console.log(`[LLM:dual] turn_script turn=${turnId} beats=${beats.length} donation=${donation?.show ? donation.reason : 'none'} ${summarizeDualHeadBeatsForLog(beats)}`);

  pushHistory('user', normalizedInput);
  pushHistory('model', fullText);
  incrementAssistantReplyCount();

  const primaryEmotion = beats.find((beat) => beat.actor === 'main' && beat.emotion)?.emotion || null;
  const tokensIn = usageIn || estimateTokens(normalizedInput);
  const tokensOut = usageOut || estimateTokens(fullText);
  const costUsd = estimateCostUsd(tokensIn, tokensOut);

  return {
    text: fullText,
    source: 'llm-dual-head',
    model,
    tokens: { in: tokensIn, out: tokensOut },
    costUsd,
    donation,
    emotion: primaryEmotion,
    latencyMs: Date.now() - startedAt,
    beats,
    telemetry: {
      context: contextMeta,
      llmRequest: {
        systemInstruction: systemInst,
        contents: sanitizeContentsForTelemetry(contentBundle.contents),
      },
      llmStartAt,
      llmEndAt,
    },
  };
}

function createSentenceSplitter(onSentence) {
  let buffer = '';
  const SENTENCE_END_RE = /[.!?](?=\s|$)/;
  const CLAUSE_END_RE = /[,;:](?=\s)/;
  const SOFT_SPLIT_MIN_CHARS = 56;
  const HARD_SPLIT_MAX_CHARS = 120;

  function skipDelimiterRemainder(index) {
    let cursor = index;
    while (cursor < buffer.length && /\s/.test(buffer[cursor])) cursor += 1;
    return cursor;
  }

  function emitNextChunk() {
    if (!buffer) return false;

    const sentenceMatch = SENTENCE_END_RE.exec(buffer);
    if (sentenceMatch) {
      const endIdx = sentenceMatch.index + sentenceMatch[0].length;
      const sentence = buffer.slice(0, endIdx).trim();
      buffer = buffer.slice(skipDelimiterRemainder(endIdx));
      if (sentence) onSentence(sentence);
      return true;
    }

    if (buffer.length >= SOFT_SPLIT_MIN_CHARS) {
      let clauseMatch = null;
      for (const match of buffer.matchAll(new RegExp(CLAUSE_END_RE, 'g'))) {
        clauseMatch = match;
      }
      if (clauseMatch) {
        const endIdx = clauseMatch.index + clauseMatch[0].length;
        const sentence = buffer.slice(0, endIdx).trim();
        buffer = buffer.slice(skipDelimiterRemainder(endIdx));
        if (sentence) onSentence(sentence);
        return true;
      }
    }

    if (buffer.length >= HARD_SPLIT_MAX_CHARS) {
      const splitAtSpace = buffer.lastIndexOf(' ', HARD_SPLIT_MAX_CHARS);
      const endIdx = splitAtSpace > 28 ? splitAtSpace : HARD_SPLIT_MAX_CHARS;
      const sentence = buffer.slice(0, endIdx).trim();
      buffer = buffer.slice(skipDelimiterRemainder(endIdx));
      if (sentence) onSentence(sentence);
      return true;
    }

    return false;
  }

  return {
    push(delta) {
      buffer += delta;
      while (emitNextChunk()) { }
    },
    flush() {
      const remaining = buffer.trim();
      buffer = '';
      if (remaining) onSentence(remaining);
    },
  };
}

async function generateStreamingAssistantReply(userText, { broadcast, turnId, abortController, frame, appearanceFrame, timingHooks = null }) {
  const normalizedInput = normalizeInput(userText);
  if (!normalizedInput) {
    const emptyContextMeta = { mode: 'text', imageAttached: false, ...getHistoryMeta() };
    emitTurnContextMeta({ turnId, broadcast, timingHooks, meta: emptyContextMeta });
    if (timingHooks?.onFirstToken) timingHooks.onFirstToken('empty-fastpath');
    if (timingHooks?.onLlmDone) timingHooks.onLlmDone();
    broadcast({ type: 'speak', text: 'I did not catch that. Try again.', ts: Date.now() });
    return {
      text: 'I did not catch that. Try again.',
      source: 'empty',
      model: runtimeConfig.llmModel,
      tokens: { in: 1, out: 8 },
      latencyMs: 0,
      telemetry: {
        context: emptyContextMeta,
        llmRequest: null,
        llmStartAt: null,
        llmEndAt: null,
      },
    };
  }

  const startedAt = Date.now();
  let llmStartMarked = false;
  let llmDoneMarked = false;
  let llmStartAt = null;
  let llmEndAt = null;
  const markLlmStart = () => {
    if (llmStartMarked) return;
    llmStartMarked = true;
    llmStartAt = Date.now();
    if (timingHooks?.onLlmStart) timingHooks.onLlmStart();
  };
  const markLlmDone = () => {
    if (llmDoneMarked) return;
    llmDoneMarked = true;
    llmEndAt = Date.now();
    if (timingHooks?.onLlmDone) timingHooks.onLlmDone();
  };
  const greeting = pickGreetingResponse(normalizedInput);
  extractMemory(normalizedInput);
  console.log(`[LLM] turn=${turnId} dualEnabled=${runtimeConfig.dualHeadEnabled} dualMode=${runtimeConfig.dualHeadMode} directed=${shouldUseDualHeadDirectedMode()}`);

  // Fast-path: greetings use the existing non-streaming speak message
  // In dual-head mode, skip fast-path so the LLM generates both heads' content
  if (greeting && !shouldUseDualHeadDirectedMode()) {
    const contextMeta = { mode: 'text', imageAttached: false, ...getHistoryMeta() };
    emitTurnContextMeta({ turnId, broadcast, timingHooks, meta: contextMeta });
    const parsed = splitTrailingEmotionEmoji(greeting);
    const greetingText = parsed.text || 'Hey.';
    const greetingEmotion = parsed.emotion || defaultDualHeadSpeakEmotion('main');
    pushHistory('user', normalizedInput);
    pushHistory('model', greetingText);
    incrementAssistantReplyCount();
    if (timingHooks?.onFirstToken) timingHooks.onFirstToken('greeting-fastpath');
    markLlmDone();
    broadcast({
      type: 'speak',
      text: greetingText,
      donation: buildDonationPayload(false),
      emotion: parsed.emotion || null,
      ts: Date.now(),
    });
    return {
      text: greetingText,
      source: 'greeting',
      model: 'fast-greeting',
      tokens: { in: estimateTokens(normalizedInput), out: estimateTokens(greetingText) },
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      donation: buildDonationPayload(false),
      emotion: greetingEmotion,
      beats: null,
      telemetry: {
        context: contextMeta,
        llmRequest: null,
        llmStartAt,
        llmEndAt,
      },
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !getHasWarnedMissingApiKey()) {
    setHasWarnedMissingApiKey(true);
    console.warn('[LLM] GEMINI_API_KEY missing. Falling back to demo responses.');
  }

  // No API key -> fall back to non-streaming demo response
  if (!apiKey) {
    const contextMeta = { mode: 'text', imageAttached: false, ...getHistoryMeta() };
    emitTurnContextMeta({ turnId, broadcast, timingHooks, meta: contextMeta });
    const fallbackText = generateDemoResponse(normalizedInput);
    const fallbackEmoji = splitTrailingEmotionEmoji(fallbackText);
    const responseText = clampOutput(fallbackEmoji.text);
    const donationSignal = extractDonationSignal(responseText);
    const fallbackEmotion = fallbackEmoji.emotion || defaultDualHeadSpeakEmotion('main');
    pushHistory('user', normalizedInput);
    pushHistory('model', donationSignal.text);
    incrementAssistantReplyCount();
    if (timingHooks?.onFirstToken) timingHooks.onFirstToken('fallback-fastpath');
    markLlmDone();
    broadcast({
      type: 'speak',
      text: donationSignal.text,
      donation: donationSignal.donation,
      emotion: fallbackEmotion,
      ts: Date.now(),
    });
    return {
      text: donationSignal.text,
      source: 'fallback',
      model: 'fallback-demo',
      tokens: { in: estimateTokens(normalizedInput), out: estimateTokens(donationSignal.text) },
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      donation: donationSignal.donation,
      emotion: fallbackEmotion,
      beats: null,
      telemetry: {
        context: contextMeta,
        llmRequest: null,
        llmStartAt,
        llmEndAt,
      },
    };
  }

  if (shouldUseDualHeadDirectedMode()) {
    markLlmStart();
    const dualReply = await generateDualHeadDirectedReply({
      normalizedInput,
      apiKey,
      turnId,
      broadcast,
      frame,
      appearanceFrame,
      startedAt,
      timingHooks,
    });
    if (dualReply) {
      markLlmDone();
      return dualReply;
    }
    console.warn('[LLM:dual] Falling back to single-head streaming path (no valid dual script from one-shot LLM call).');
  }

  // Streaming LLM path
  let chunkIndex = 0;
  let sentenceCount = 0;
  let fullText = '';
  let rawEmotion = null;
  let emotionExtracted = false;
  let donationMarkerDetected = false;
  let firstTokenMarked = false;

  const markFirstToken = (source = 'speak_chunk') => {
    if (firstTokenMarked) return;
    firstTokenMarked = true;
    if (timingHooks?.onFirstToken) timingHooks.onFirstToken(source);
  };

  const splitter = createSentenceSplitter((sentence) => {
    if (sentenceCount >= MAX_OUTPUT_SENTENCES) return;

    let text = sentence;
    if (!emotionExtracted) {
      const parsed = splitTrailingEmotionEmoji(text);
      if (parsed.emotion) {
        rawEmotion = parsed.emotion;
        emotionExtracted = true;
      }
      text = parsed.text;
    }

    if (text.includes(DONATION_MARKER) || DONATION_MARKER_RE.test(text)) {
      donationMarkerDetected = true;
    }

    text = stripFormatting(text);
    text = stripDonationMarkers(text);
    if (!text) return;

    sentenceCount++;
    fullText += (fullText ? ' ' : '') + text;
    markFirstToken('speak_chunk');
    broadcast({ type: 'speak_chunk', text, chunkIndex, turnId });
    chunkIndex++;
  });

  let usageIn = 0;
  let usageOut = 0;
  let model = runtimeConfig.llmModel;
  let contextMeta = null;
  let llmRequest = null;

  const useVision = hasVisionIntent(normalizedInput) && frame;
  const useAppearance = !useVision && appearanceFrame?.data;
  const imageToSend = useVision ? frame : useAppearance ? appearanceFrame.data : null;
  const mode = useVision ? 'vision' : useAppearance ? 'appearance' : 'text';
  const contentBundle = buildContents(normalizedInput, imageToSend, { returnMeta: true });
  contextMeta = {
    mode,
    imageAttached: contentBundle.imageAttached,
    historyMessages: contentBundle.historyMessages,
    historyChars: contentBundle.historyChars,
  };
  emitTurnContextMeta({ turnId, broadcast, timingHooks, meta: contextMeta });

  if (useVision) {
    console.log('[Vision] Intent detected \u2014 including camera frame in LLM request');
  } else if (useAppearance) {
    console.log(`[Vision] Appearance frame available (faces: ${(appearanceFrame.faces || []).join(', ') || 'unknown'}) \u2014 including in LLM request`);
  }

  try {
    markLlmStart();
    let systemInst = buildSystemInstruction();
    if (useVision) {
      systemInst += '\n\n' + VISION_SYSTEM_ADDENDUM;
    } else if (useAppearance) {
      systemInst += '\n\n' + APPEARANCE_SYSTEM_ADDENDUM;
    }
    llmRequest = {
      systemInstruction: systemInst,
      contents: sanitizeContentsForTelemetry(contentBundle.contents),
    };
    const llmResult = await streamGeminiContent({
      apiKey,
      model: runtimeConfig.llmModel,
      systemInstruction: systemInst,
      contents: contentBundle.contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: 1,
      onChunk: (delta) => splitter.push(delta),
      abortSignal: abortController?.signal,
    });
    console.log(`[LLM:stream] Raw response (${llmResult.text.length} chars): ${llmResult.text}`);

    // Flush remaining buffer
    if (sentenceCount < MAX_OUTPUT_SENTENCES) {
      splitter.flush();
    }

    model = llmResult.model || model;
    usageIn = Number(llmResult.usage.promptTokenCount || 0);
    usageOut = Number(llmResult.usage.candidatesTokenCount || 0);

    // If no chunks were emitted (e.g. very short response), extract emotion from full text
    if (!emotionExtracted && llmResult.text) {
      const rawResText = llmResult.text;
      if (rawResText.includes(DONATION_MARKER) || DONATION_MARKER_RE.test(rawResText)) {
        donationMarkerDetected = true;
      }
      const parsed = splitTrailingEmotionEmoji(stripFormatting(rawResText));
      rawEmotion = parsed.emotion;
      if (parsed.text) {
        fullText = clampOutput(stripDonationMarkers(parsed.text));
        markFirstToken('speak_chunk_fallback');
        broadcast({ type: 'speak_chunk', text: fullText, chunkIndex, turnId });
        chunkIndex++;
      }
    }

    if (llmResult.aborted) {
      console.log(`[LLM:stream] Aborted after ${chunkIndex} chunks`);
    }
  } catch (err) {
    console.error('[LLM:stream] Gemini streaming failed:', err.message);
    if (!fullText) {
      const fallbackText = generateDemoResponse(normalizedInput);
      const fallbackEmoji = splitTrailingEmotionEmoji(fallbackText);
      rawEmotion = rawEmotion || fallbackEmoji.emotion;
      fullText = clampOutput(fallbackEmoji.text);
      markFirstToken('speak_chunk_demo');
      broadcast({ type: 'speak_chunk', text: fullText, chunkIndex, turnId });
      chunkIndex++;
      model = 'fallback-demo';
    }
  }

  if (!fullText) {
    fullText = `Please help my wheel fund on Venmo @tubs-wheel-fund so Rapha can see Thailand.`;
    markFirstToken('speak_chunk_default');
    broadcast({ type: 'speak_chunk', text: fullText, chunkIndex, turnId });
    chunkIndex++;
  }

  // Donation handling
  let donationSignal = extractDonationSignal(fullText);

  if (donationMarkerDetected && !donationSignal.donation.show) {
    donationSignal = {
      text: fullText,
      donation: buildDonationPayload(true, 'marker_tracked')
    };
  }

  const nudged = maybeInjectDonationNudge(donationSignal.text, donationSignal.donation.show, getAssistantReplyCount());
  const finalDonation = nudged.forcedQr
    ? buildDonationPayload(true, 'periodic_nudge')
    : donationSignal.donation;

  // Send speak_end
  broadcast({
    type: 'speak_end',
    turnId,
    emotion: rawEmotion || null,
    donation: finalDonation,
    fullText,
  });
  markLlmDone();

  pushHistory('user', normalizedInput);
  pushHistory('model', fullText);
  incrementAssistantReplyCount();

  const tokensIn = usageIn || estimateTokens(normalizedInput);
  const tokensOut = usageOut || estimateTokens(fullText);
  const costUsd = estimateCostUsd(tokensIn, tokensOut);

  return {
    text: fullText,
    source: 'llm',
    model,
    tokens: { in: tokensIn, out: tokensOut },
    costUsd,
    donation: finalDonation,
    emotion: rawEmotion,
    latencyMs: Date.now() - startedAt,
    beats: null,
    telemetry: {
      context: contextMeta || { mode: 'text', imageAttached: false, ...getHistoryMeta() },
      llmRequest,
      llmStartAt,
      llmEndAt,
    },
  };
}

module.exports = {
  generateAssistantReply,
  generateStreamingAssistantReply,
  generateProactiveReply,
  generateDualHeadProactiveReply,
  generateDualHeadDirectedReply,
  createSentenceSplitter,
};
