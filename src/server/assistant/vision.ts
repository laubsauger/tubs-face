import { generateGeminiContent } from '../llm/gemini-client.js';
import { updateVisualContext } from './context.js';
import { runtimeConfig } from '../config/runtime.js';

export async function processVisualContext(frameDataUrl: string) {
  const mimeTypeMatch = String(frameDataUrl).match(/^data:(image\/\w+);base64,(.+)/);
  if (!mimeTypeMatch) return;
  const mimeType = mimeTypeMatch[1]!;
  const b64Data = mimeTypeMatch[2]!;

  // Factual inventory; Tubs adds the attitude. Same prompt for a new visitor
  // (appearance_frame) and the periodic refresh (camera_frame), so the first
  // impression includes clothing too.
  const prompt = 'Describe what the camera sees for a robot host: each person\'s clothing, accessories, hair colour and expression; anything they hold; the setting. With several people, go left to right as the image shows them and start each with Left:, Middle: or Right:. Factual, no judgments, no guesses about age, body, ethnicity or gender. Under 60 words.';

  try {
    const res = await generateGeminiContent({
      apiKey: process.env.GEMINI_API_KEY || '',
      model: runtimeConfig.llmModel,
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
