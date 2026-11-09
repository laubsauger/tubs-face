// The Studio tab's vision picker (routes/vision-routes.ts): servers, models, a test.

export interface VisionServer {
  label: string;
  /** What visionBaseUrl takes. */
  baseUrl: string;
  /** null: not known (a preset); false: the hub says it is not healthy. */
  healthy: boolean | null;
}

/** GET /vision/servers */
export interface VisionServersResponse {
  servers: VisionServer[];
  /** Why no fleet boxes are listed (the hub does not answer), if so. */
  problem?: string;
}

export interface VisionModel {
  id: string;
  /** Set on a thinking variant: it may spend every token thinking and answer nothing. */
  warning?: string;
}

/** GET /vision/models?base=... */
export interface VisionModelsResponse {
  base: string;
  models: VisionModel[];
  /** The -instruct model to use instead of a thinking one, when there is one (or should be). */
  suggested?: string;
  error?: string;
}

/** POST /vision/test {provider, model, baseUrl, frame} */
export interface VisionTestResult {
  ok: boolean;
  ms: number;
  /** host:port that answered (fleet:vision resolved), or "Gemini API". */
  where: string | null;
  text: string | null;
  error?: string;
}
