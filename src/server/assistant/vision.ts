import { generateGeminiContent } from '../llm/gemini-client.js';
import { updateVisualContext } from './context.js';

export async function processVisualContext(frameDataUrl: string, isVisionMode: boolean) {
  const mimeTypeMatch = String(frameDataUrl).match(/^data:(image\/\w+);base64,(.+)/);
  if (!mimeTypeMatch) return;
  const mimeType = mimeTypeMatch[1]!;
  const b64Data = mimeTypeMatch[2]!;

  const prompt = isVisionMode
    ? "Describe the user's appearance, clothing, objects, and setting based on this image. Be brutal, honest, and very succinct. Do not address them."
    : "Describe the user's expression, posture, and visible surroundings. Be very succinct.";

  try {
    const res = await generateGeminiContent({
      apiKey: process.env.GEMINI_API_KEY || '',
      model: process.env.GEMINI_MODEL || 'gemini-3.0-flash',
      systemInstruction: "You are a visual context extraction tool.",
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: b64Data,
              }
            }
          ]
        }
      ],
      maxOutputTokens: 100,
    });
    if (res && res.text) {
      console.log(`[Vision] Background description ready: ${res.text}`);
      updateVisualContext(res.text);
    }
  } catch (err) {
    if (err instanceof Error) {
      console.error(`[Vision] Background description failed: ${err.message}`);
    }
  }
}
