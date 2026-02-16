const { generateGeminiContent, streamGeminiContent } = require('../../gemini-client');

function getAuthState() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      ready: false,
      warningMessage: '[LLM] GEMINI_API_KEY missing. Conversational requests will fail.',
      auth: null,
    };
  }
  return {
    ready: true,
    warningMessage: null,
    auth: { apiKey },
  };
}

async function generateContent(args) {
  const apiKey = args?.auth?.apiKey || process.env.GEMINI_API_KEY;
  return generateGeminiContent({
    apiKey,
    model: args.model,
    systemInstruction: args.systemInstruction,
    contents: args.contents,
    maxOutputTokens: args.maxOutputTokens,
    temperature: args.temperature,
    timeoutMs: args.timeoutMs,
    responseMimeType: args.responseMimeType,
    responseSchema: args.responseSchema,
  });
}

async function streamContent(args) {
  const apiKey = args?.auth?.apiKey || process.env.GEMINI_API_KEY;
  return streamGeminiContent({
    apiKey,
    model: args.model,
    systemInstruction: args.systemInstruction,
    contents: args.contents,
    maxOutputTokens: args.maxOutputTokens,
    temperature: args.temperature,
    timeoutMs: args.timeoutMs,
    onChunk: args.onChunk,
    abortSignal: args.abortSignal,
  });
}

module.exports = {
  id: 'gemini',
  getAuthState,
  generateContent,
  streamContent,
};
