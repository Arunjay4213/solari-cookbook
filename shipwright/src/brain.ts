import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import OpenAI, { RateLimitError } from "openai"
import type {
  AppFile,
  AppSpec,
  Assertion,
  Brain,
  BrainOptions,
  Failure,
  ScreenCapture,
  TestSpec,
  TokenUsage,
  VisualReview,
} from "./types.js"

const DEFAULT_MODEL = "gpt-5.6-sol"
/**
 * Visual review runs on a different model by default: a review payload carries
 * two screenshots, and on a low tier that request alone exceeds the per-minute
 * token allowance for the build model, which fails as a 429 no retry can fix.
 */
const DEFAULT_VISUAL_MODEL = "gpt-5.6-luna"

export function createBrain(opts: BrainOptions): Brain {
  if (opts.mode === "stub") return stubBrain()
  return openaiBrain(opts.model ?? DEFAULT_MODEL, opts.visualModel ?? DEFAULT_VISUAL_MODEL)
}

// ---------------------------------------------------------------- stub mode

/** The three files every fixture app is made of. */
const FIXTURE_FILES = ["index.html", "style.css", "app.js"]

function stubBrain(): Brain {
  return {
    async generate() {
      return loadFixture("todo-buggy")
    },
    async fix() {
      return loadFixture("todo-fixed")
    },
  }
}

// Resolved against this module, not the cwd: the CLI can be started anywhere.
function fixturePath(...parts: string[]): string {
  return fileURLToPath(new URL(["..", "fixtures", ...parts].join("/"), import.meta.url))
}

function loadFixture(dir: string): AppSpec {
  const files: AppFile[] = FIXTURE_FILES.map((path) => ({
    path,
    content: readFileSync(fixturePath(dir, path), "utf8"),
  }))
  const tests = JSON.parse(readFileSync(fixturePath("tests.json"), "utf8")) as TestSpec[]
  return { name: "shipwright-todo", files, tests }
}

// -------------------------------------------------------------- openai mode

/** The flat file list, shared by the generation and visual-review schemas. */
const FILES_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "relative path, e.g. index.html or js/app.js" },
      content: { type: "string", description: "complete file contents" },
    },
  },
}

/**
 * Strict structured-output schema. Strict mode demands `additionalProperties:
 * false` plus every property listed in `required`, so the four Assertion
 * variants are flattened into one object with nullable extras and narrowed back
 * into the real union by `toAssertion`.
 */
const APP_SPEC_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name", "files", "tests"],
  properties: {
    name: { type: "string", description: "kebab-case app name" },
    files: FILES_SCHEMA,
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "path", "viewport", "assertions"],
        properties: {
          name: { type: "string", description: "unique kebab-case test name" },
          path: { type: "string", description: "URL path to open, e.g. / or /about.html" },
          viewport: {
            type: "object",
            additionalProperties: false,
            required: ["width", "height"],
            properties: { width: { type: "integer" }, height: { type: "integer" } },
          },
          assertions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "selector", "contains", "value", "submitSelector", "thenExists"],
              properties: {
                kind: { type: "string", enum: ["exists", "text", "click", "fill"] },
                selector: { type: "string", description: "CSS selector the assertion acts on" },
                contains: { type: ["string", "null"], description: "text kind only" },
                value: { type: ["string", "null"], description: "fill kind only" },
                submitSelector: { type: ["string", "null"], description: "fill kind only" },
                thenExists: { type: ["string", "null"], description: "click and fill kinds only" },
              },
            },
          },
        },
      },
    },
  },
}

/**
 * Verdict schema for the visual review. `files` is the same flat file list as
 * generation, nullable so an approval can omit it; the tests are deliberately
 * absent, because a visual pass must never rewrite them.
 */
const VISUAL_REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "issues", "files"],
  properties: {
    approved: { type: "boolean", description: "true only when nothing is left to fix" },
    issues: {
      type: "array",
      description: "concrete visual problems, empty when approved",
      items: { type: "string" },
    },
    files: {
      ...FILES_SCHEMA,
      type: ["array", "null"],
      description: "the complete corrected app, null when approved",
    },
  },
}

const SYSTEM_PROMPT = `You are a senior front-end engineer. You produce complete, self-contained static web apps and the end-to-end tests that prove they work.

App rules:
- Plain HTML, CSS and JavaScript only. No build step, no frameworks, no npm packages.
- No external resources of any kind: no CDNs, no remote fonts, no remote images, no network calls. Everything is inline or in the files you emit.
- The app is served by a plain static file server, so "index.html" must exist at the app root.
- File paths are relative with no leading slash and no ".." segment, e.g. "index.html", "style.css", "app.js".
- Emit the complete contents of every file. Never emit diffs, patches or placeholder comments like "rest unchanged".
- Visual design matters: a polished, modern, uncluttered layout that reads well in both light and dark colour schemes, with a sensible responsive breakpoint for narrow viewports.

Test rules:
- Write 3 to 6 tests spread across 2 to 3 viewports, for example desktop 1280x800, tablet 820x1180, mobile 390x844.
- The tests must genuinely exercise the app's main interaction, not just check that elements are present.
- Every element a test targets must carry a stable id or class that the app markup actually defines.
- Assertions use exactly these four kinds and nothing else:
  - "exists": the element matching "selector" is present.
  - "text": the element matching "selector" contains the substring "contains".
  - "click": click the element matching "selector", then the element matching "thenExists" must appear.
  - "fill": type "value" into the element matching "selector", click the element matching "submitSelector", then the element matching "thenExists" must appear.
- Set the fields a kind does not use to null.
- A "thenExists" selector must match nothing before the interaction, otherwise the test proves nothing. Start lists and result areas empty.`

function openaiBrain(model: string, visualModel: string): Brain {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Export it or put it in .env, or run with --stub to use the fixtures.",
    )
  }
  const client = new OpenAI({ apiKey })
  // Accumulated across every call this brain makes, so one run reports one total.
  const tally: TokenUsage = { calls: 0, inputTokens: 0, outputTokens: 0 }

  return {
    usage: () => ({ ...tally }),

    async generate(idea: string) {
      const raw = await callModel(
        client,
        model,
        `Build a static web app for this idea, then write its end-to-end tests.\n\nIdea: ${idea}`,
        APP_SPEC_FORMAT,
        tally,
      )
      return parseAppSpec(raw)
    },

    async fix(spec: AppSpec, failures: Failure[]) {
      const input = [
        `The app "${spec.name}" below failed its end-to-end tests. Diagnose the cause and return the complete corrected app.`,
        "Keep the same design and the same file set unless a fix genuinely requires a change. Return every file in full, not a diff.",
        "Return the same tests unless a test itself is wrong.",
        "",
        "Current files:",
        ...spec.files.map(formatFile),
        "",
        "Failures:",
        ...failures.map(formatFailure),
      ].join("\n")
      const raw = await callModel(client, model, input, APP_SPEC_FORMAT, tally)
      return parseAppSpec(raw)
    },

    async visualReview(spec: AppSpec, screens: ScreenCapture[]) {
      if (screens.length === 0) throw new Error("visualReview needs at least one screenshot.")
      const brief = [
        `You built the static web app "${spec.name}". It already passes its end-to-end tests, so this pass is about how it looks, not what it does.`,
        "Screenshots of the deployed app follow, one per viewport, each labelled with its viewport and with whether the page scrolls horizontally there.",
        "Judge alignment, spacing and rhythm, visual hierarchy, colour contrast and readability, how well the layout adapts at each viewport shown, and overall polish.",
        'If anything meaningful is still wrong, set "approved" to false, list the concrete issues, and return the complete corrected app in "files": every file in full, under the same rules as the original build (static only, no external resources, index.html at the app root).',
        'If the design is genuinely done, set "approved" to true with an empty "issues" list and null "files". Do not invent nitpicks to look thorough.',
        "Never approve a viewport that reports horizontal overflow: that is always a real bug.",
        "The tests are fixed and are not part of this pass. Do not change any id, class or text that the app's markup exposes to them; restyle the markup instead.",
        "",
        "Current files:",
        ...spec.files.map(formatFile),
      ].join("\n")

      const content: OpenAI.Responses.ResponseInputMessageContentList = [
        { type: "input_text", text: brief },
      ]
      for (const s of screens) {
        content.push({
          type: "input_text",
          text: `${s.name}, horizontal overflow: ${s.overflowX ? "yes" : "no"}`,
        })
        // ResponseInputImage (responses.d.ts:3275): a base64 data URL is accepted
        // in place of a fetchable one, so nothing has to be uploaded first.
        content.push({
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.from(s.png).toString("base64")}`,
          detail: "auto",
        })
      }

      const raw = await callModel(
        client,
        visualModel,
        [{ role: "user", content }],
        { name: "visual_review", schema: VISUAL_REVIEW_SCHEMA },
        tally,
      )
      return parseVisualReview(raw, spec)
    },
  }
}

function formatFile(f: AppFile): string {
  return `--- ${f.path} ---\n${f.content}`
}

function formatFailure(f: Failure): string {
  const errors = f.consoleErrors.length ? `\n  console: ${f.consoleErrors.join(" | ")}` : ""
  return `- [${f.test}] ${f.message}${errors}`
}

/** The structured-output format a call asks for. */
interface OutputFormat {
  name: string
  schema: Record<string, unknown>
}

const APP_SPEC_FORMAT: OutputFormat = { name: "app_spec", schema: APP_SPEC_SCHEMA }

/** Returns the model's raw JSON text; each caller parses it into its own shape. */
async function callModel(
  client: OpenAI,
  model: string,
  input: OpenAI.Responses.ResponseCreateParams["input"],
  format: OutputFormat,
  tally: TokenUsage,
): Promise<string> {
  // Non-streaming overload: openai/resources/responses/responses.d.ts:51.
  let res: OpenAI.Responses.Response
  try {
    res = await client.responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input,
      text: {
        format: { type: "json_schema", name: format.name, schema: format.schema, strict: true },
      },
    })
  } catch (err) {
    throw explainTokenLimit(err, model)
  }

  // Recorded before the output check: an incomplete response is still billed.
  // `usage` is optional on Response (responses.d.ts:1010), so tokens are added
  // only when the API actually reported them; the call is always counted.
  tally.calls += 1
  if (res.usage) {
    tally.inputTokens += res.usage.input_tokens
    tally.outputTokens += res.usage.output_tokens
  }

  const text = res.output_text
  if (!text) {
    const why = res.error?.message ?? res.incomplete_details?.reason ?? res.status ?? "unknown"
    throw new Error(`Model ${model} returned no output (${why}).`)
  }
  return text
}

/**
 * A single request larger than the org's per-minute token allowance comes back
 * as a 429, which reads like ordinary rate limiting but no amount of waiting or
 * retrying fixes it: the payload has to shrink or move to another model. The
 * SDK raises 429s as RateLimitError, an APIError carrying `status` and `code`
 * (openai/core/error.d.ts:47 and :4). Anything else is passed through untouched.
 */
function explainTokenLimit(err: unknown, model: string): unknown {
  if (!(err instanceof RateLimitError)) return err
  if (!/too large|tokens per min/i.test(err.message)) return err
  return new Error(
    `${err.message}\nThis request exceeds the org's per-minute token limit for ${model}; try --visual-model gpt-5.6-luna or a smaller app.`,
  )
}

// ---------------------------------------------------------------- validation

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Model output was not valid JSON. First 300 chars: ${raw.slice(0, 300)}`)
  }
}

function parseAppSpec(raw: string): AppSpec {
  const root = asObject(parseJson(raw), "response")

  const name = asString(root["name"], "name")
  const files = toFiles(root["files"], "files")

  const tests = asArray(root["tests"], "tests").map((t, i) => toTest(t, `tests[${i}]`))
  if (tests.length === 0) throw new Error("Model returned no tests.")

  return { name, files, tests }
}

/**
 * The tests are taken from `spec`, never from the model: a visual pass fixes
 * pixels, and rewriting the tests it is about to be graded by would make the
 * next functional round meaningless.
 */
function parseVisualReview(raw: string, spec: AppSpec): VisualReview {
  const root = asObject(parseJson(raw), "response")

  const approved = root["approved"]
  if (typeof approved !== "boolean") {
    throw new Error(`approved must be a boolean, got ${describe(approved)}`)
  }
  if (approved) return { approved: true, issues: [], spec: null }

  const issues = asArray(root["issues"], "issues").map((s, i) => asString(s, `issues[${i}]`))
  if (issues.length === 0) throw new Error("Model rejected the design but listed no issues.")
  if (root["files"] == null) {
    throw new Error("Model rejected the design but returned no corrected files.")
  }

  const files = toFiles(root["files"], "files")
  return { approved: false, issues, spec: { name: spec.name, files, tests: spec.tests } }
}

function toFiles(value: unknown, where: string): AppFile[] {
  const files = asArray(value, where).map((f, i) => toFile(f, `${where}[${i}]`))
  if (files.length === 0) throw new Error("Model returned no files.")
  if (!files.some((f) => f.path === "index.html")) {
    throw new Error(`Model returned no index.html. Got: ${files.map((f) => f.path).join(", ")}`)
  }
  return files
}

function toFile(value: unknown, where: string): AppFile {
  const o = asObject(value, where)
  const path = asString(o["path"], `${where}.path`)
  const content = asString(o["content"], `${where}.content`)
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`${where}.path must be relative with no ".." segment, got "${path}"`)
  }
  if (content.trim() === "") throw new Error(`${where} ("${path}") is empty.`)
  return { path, content }
}

function toTest(value: unknown, where: string): TestSpec {
  const o = asObject(value, where)
  const viewport = asObject(o["viewport"], `${where}.viewport`)
  const assertions = asArray(o["assertions"], `${where}.assertions`).map((a, i) =>
    toAssertion(a, `${where}.assertions[${i}]`),
  )
  if (assertions.length === 0) throw new Error(`${where} has no assertions.`)
  return {
    name: asString(o["name"], `${where}.name`),
    path: asString(o["path"], `${where}.path`),
    viewport: {
      width: asNumber(viewport["width"], `${where}.viewport.width`),
      height: asNumber(viewport["height"], `${where}.viewport.height`),
    },
    assertions,
  }
}

function toAssertion(value: unknown, where: string): Assertion {
  const o = asObject(value, where)
  const kind = String(o["kind"])
  // Flattened schema: a field the kind needs may still arrive as null.
  const need = (key: string): string => {
    const v = o[key]
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`${where}: assertion kind "${kind}" needs a non-empty "${key}"`)
    }
    return v
  }

  switch (kind) {
    case "exists":
      return { kind: "exists", selector: need("selector") }
    case "text":
      return { kind: "text", selector: need("selector"), contains: need("contains") }
    case "click":
      return { kind: "click", selector: need("selector"), thenExists: need("thenExists") }
    case "fill":
      return {
        kind: "fill",
        selector: need("selector"),
        value: need("value"),
        submitSelector: need("submitSelector"),
        thenExists: need("thenExists"),
      }
    default:
      throw new Error(
        `${where}: unknown assertion kind "${kind}". Expected exists, text, click or fill.`,
      )
  }
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object, got ${describe(value)}`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array, got ${describe(value)}`)
  return value
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} must be a non-empty string, got ${describe(value)}`)
  }
  return value
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${where} must be a number, got ${describe(value)}`)
  }
  return value
}

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value
}
