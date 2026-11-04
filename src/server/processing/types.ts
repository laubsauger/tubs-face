export interface TranscriptionResult {
  text: string;
  language?: string;
  probability?: number;
}

export interface TtsProxyTarget {
  hostname: string;
  port: number;
  path: string;
}
