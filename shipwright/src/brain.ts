import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import OpenAI from "openai"
import type { AppFile, AppSpec, Assertion, Brain, BrainOptions, Failure, TestSpec } from "./types.js"

const DEFAULT_MODEL = "gpt-5.6-sol"

export function createBrain(opts: BrainOptions): Brain {
  if (opts.mode === "stub") return stubBrain()
  return openaiBrain(opts.model ?? DEFAULT_MODEL)
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
    files: {
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
    },
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

function openaiBrain(model: string): Brain {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Export it or put it in .env, or run with --stub to use the fixtures.",
    )
  }
  const client = new OpenAI({ apiKey })

  return {
    async generate(idea: string) {
      return callModel(
        client,
        model,
        `Build a static web app for this idea, then write its end-to-end tests.\n\nIdea: ${idea}`,
      )
    },

    async fix(spec: AppSpec, failures: Failure[]) {
      const input = [
        `The app "${spec.name}" below failed its end-to-end tests. Diagnose the cause and return the complete corrected app.`,
        "Keep the same design and the same file set unless a fix genuinely requires a change. Return every file in full, not a diff.",
        "Return the same tests unless a test itself is wrong.",
        "",
        "Current files:",
        ...spec.files.map((f) => `--- ${f.path} ---\n${f.content}`),
        "",
        "Failures:",
        ...failures.map(formatFailure),
      ].join("\n")
      return callModel(client, model, input)
    },
  }
}

function formatFailure(f: Failure): string {
  const errors = f.consoleErrors.length ? `\n  console: ${f.consoleErrors.join(" | ")}` : ""
  return `- [${f.test}] ${f.message}${errors}`
}

async function callModel(client: OpenAI, model: string, input: string): Promise<AppSpec> {
  // Non-streaming overload: openai/resources/responses/responses.d.ts:51.
  const res = await client.responses.create({
    model,
    instructions: SYSTEM_PROMPT,
    input,
    text: {
      format: { type: "json_schema", name: "app_spec", schema: APP_SPEC_SCHEMA, strict: true },
    },
  })

  const text = res.output_text
  if (!text) {
    const why = res.error?.message ?? res.incomplete_details?.reason ?? res.status ?? "unknown"
    throw new Error(`Model ${model} returned no output (${why}).`)
  }
  return parseAppSpec(text)
}

// ---------------------------------------------------------------- validation

function parseAppSpec(raw: string): AppSpec {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Model output was not valid JSON. First 300 chars: ${raw.slice(0, 300)}`)
  }
  const root = asObject(data, "response")

  const name = asString(root["name"], "name")
  const files = asArray(root["files"], "files").map((f, i) => toFile(f, `files[${i}]`))
  if (files.length === 0) throw new Error("Model returned no files.")
  if (!files.some((f) => f.path === "index.html")) {
    throw new Error(`Model returned no index.html. Got: ${files.map((f) => f.path).join(", ")}`)
  }

  const tests = asArray(root["tests"], "tests").map((t, i) => toTest(t, `tests[${i}]`))
  if (tests.length === 0) throw new Error("Model returned no tests.")

  return { name, files, tests }
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
