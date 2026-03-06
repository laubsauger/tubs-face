export interface LlmContentPart {
  text: string;
}

export interface LlmContent {
  role: 'user' | 'model';
  parts: LlmContentPart[];
}

export interface LlmUsage extends Record<string, unknown> {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface LlmAuthState {
  ready: boolean;
  warningMessage: string | null;
  auth: Record<string, string> | null;
}

export interface LlmGenerateArgs {
  auth?: Record<string, string> | null;
  model: string;
  systemInstruction: string;
  contents: LlmContent[];
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmGenerateResult {
  text: string;
  usage: LlmUsage;
  model: string;
}

export interface LlmProvider {
  id: 'gemini' | 'realtime';
  getAuthState(): LlmAuthState;
  generateContent(args: LlmGenerateArgs): Promise<LlmGenerateResult>;
}
