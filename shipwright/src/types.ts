// Frozen module contract for shipwright. Do not change shapes without updating
// DESIGN.md and every module that consumes them.

export interface AppFile {
  /** Path relative to the app root, e.g. "index.html", "js/app.js". No leading slash. */
  path: string
  content: string
}

export type Assertion =
  | { kind: "exists"; selector: string }
  | { kind: "text"; selector: string; contains: string }
  | { kind: "click"; selector: string; thenExists: string }
  | { kind: "fill"; selector: string; value: string; submitSelector: string; thenExists: string }

export interface TestSpec {
  /** Unique, human-readable, e.g. "add-todo-mobile". */
  name: string
  /** URL path to open, e.g. "/" or "/about.html". */
  path: string
  viewport: { width: number; height: number }
  assertions: Assertion[]
}

export interface AppSpec {
  /** kebab-case app name. */
  name: string
  files: AppFile[]
  tests: TestSpec[]
}

export interface Failure {
  /** TestSpec.name, or "generic" for page-load/console checks. */
  test: string
  /** Text a model can act on: failed assertion, console error, HTTP status. */
  message: string
  consoleErrors: string[]
}

export interface VerifyResult {
  passed: boolean
  failures: Failure[]
  /** Local files under runDir, downloaded before returning. */
  replayPaths: string[]
  screenshotPaths: string[]
}

export interface VerifyOptions {
  /** Max concurrent browser sessions. Default 10, never exceed 10. */
  concurrency?: number
}

export interface Deployment {
  /** Public preview URL serving the app root. */
  url: string
  /** Overwrite app files in the same sandbox; static server needs no restart. */
  redeploy(files: AppFile[]): Promise<void>
  /** Destroys the VM (kill, not close). Idempotent. */
  kill(): Promise<void>
}

/** Measured token usage, as reported by the API. Never estimated. */
export interface TokenUsage {
  /** Model calls made, whether or not the response reported token counts. */
  calls: number
  inputTokens: number
  outputTokens: number
}

/** A viewport-sized screenshot of the deployed app, for the visual review loop. */
export interface ScreenCapture {
  /** e.g. "desktop-1280x800". */
  name: string
  viewport: { width: number; height: number }
  /** PNG bytes of the viewport (never full page). */
  png: Uint8Array
  /** Local file the capture was saved to. */
  path: string
  /** True when the page scrolls horizontally at this viewport. */
  overflowX: boolean
}

export interface VisualReview {
  approved: boolean
  /** Empty when approved. */
  issues: string[]
  /** Complete corrected app; null when approved. */
  spec: AppSpec | null
}

export interface Brain {
  generate(idea: string): Promise<AppSpec>
  fix(spec: AppSpec, failures: Failure[]): Promise<AppSpec>
  /** Reviews screenshots of the running app. Absent in stub mode. */
  visualReview?(spec: AppSpec, screens: ScreenCapture[]): Promise<VisualReview>
  /** Cumulative usage so far. Absent in stub mode, which calls no model. */
  usage?(): TokenUsage
}

export interface BrainOptions {
  mode: "openai" | "stub"
  /** OpenAI model id, default "gpt-5.6-sol". Ignored in stub mode. */
  model?: string
  /**
   * Model for visualReview, default "gpt-5.6-luna": image payloads exceed
   * low-tier per-minute token limits on gpt-5.6-sol.
   */
  visualModel?: string
}
