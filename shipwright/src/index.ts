// Shipwright CLI: generate an app, deploy it to a Solari sandbox, verify it in
// cloud browsers, feed failures back to the model, repeat until green.
//
// Everything this run produces lands in runs/<timestamp>/ so a reviewer can see
// exactly what happened: per-iteration screenshots and replays, the transcript,
// and the final app files.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createBrain } from "./brain.js"
import { deploy } from "./sandbox.js"
import { verify } from "./verify.js"
import type { AppFile, AppSpec, Deployment } from "./types.js"

const DEFAULT_MODEL = "gpt-5.6-sol"
const DEFAULT_MAX_ITERS = 3

/** The shipwright directory, resolved against this module so the CLI can be started anywhere. */
const ROOT = fileURLToPath(new URL("..", import.meta.url))

const USAGE = `Usage: npm start -- "<idea>" [options]

Options:
  --stub            use the bundled fixtures instead of OpenAI (no OpenAI cost)
  --model <id>      OpenAI model id (default ${DEFAULT_MODEL})
  --max-iters N     stop after N verify rounds (default ${DEFAULT_MAX_ITERS})

Examples:
  npm start -- "a pomodoro timer"
  npm start -- --stub "todo app"`

// ---------------------------------------------------------------------- args

interface Options {
  idea: string
  stub: boolean
  model: string
  maxIters: number
}

function parseArgs(argv: string[]): Options {
  let stub = false
  let model = DEFAULT_MODEL
  let maxIters = DEFAULT_MAX_ITERS
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--stub") {
      stub = true
    } else if (arg === "--model") {
      model = optionValue(argv, ++i, "--model")
    } else if (arg === "--max-iters") {
      const raw = optionValue(argv, ++i, "--max-iters")
      maxIters = Number(raw)
      if (!Number.isInteger(maxIters) || maxIters < 1) {
        usageError(`--max-iters must be a positive integer, got "${raw}"`)
      }
    } else if (arg === "--showcase") {
      usageError("--showcase is not implemented yet (see DESIGN.md).")
    } else if (arg.startsWith("-")) {
      usageError(`unknown option "${arg}"`)
    } else {
      positionals.push(arg)
    }
  }

  if (positionals.length === 0) usageError("an idea is required")
  if (positionals.length > 1) {
    usageError(`expected one idea, got ${positionals.length}. Quote it: npm start -- "todo app"`)
  }
  return { idea: positionals[0], stub, model, maxIters }
}

function optionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith("-")) usageError(`${flag} needs a value`)
  return value
}

function usageError(message: string): never {
  console.error(`shipwright: ${message}\n\n${USAGE}`)
  process.exit(1)
}

// ----------------------------------------------------------------------- env

/**
 * Minimal .env reader for the shipwright directory. Real environment variables
 * always win, and nothing here is ever printed.
 */
async function loadEnv(): Promise<void> {
  let text: string
  try {
    text = await readFile(join(ROOT, ".env"), "utf8")
  } catch {
    return // No .env is fine; the keys may already be exported.
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (process.env[key] !== undefined) continue
    process.env[key] = trimmed.slice(eq + 1).trim()
  }
}

// ---------------------------------------------------------------- transcript

interface IterationRecord {
  iteration: number
  /** Paths the fix before this iteration touched. Absent on iteration 1. */
  filesChanged?: string[]
  passed: boolean
  testsRun: number
  failures: string[]
  screenshots: string[]
  replays: string[]
}

interface Transcript {
  idea: string
  mode: "stub" | "openai"
  model: string | null
  maxIters: number
  startedAt: string
  finishedAt: string | null
  app: string | null
  /** Preview URL with its access token stripped: the sandbox is gone by the time anyone reads this. */
  previewUrl: string | null
  iterations: IterationRecord[]
  /** "passed", "failed" after max-iters, or "error" when the loop itself broke. */
  status: "passed" | "failed" | "error"
  error: string | null
}

// ---------------------------------------------------------------------- main

async function main(): Promise<number> {
  await loadEnv()
  const opts = parseArgs(process.argv.slice(2))

  const runDir = join(ROOT, "runs", new Date().toISOString().replace(/[:.]/g, "-"))
  await mkdir(runDir, { recursive: true })

  const transcript: Transcript = {
    idea: opts.idea,
    mode: opts.stub ? "stub" : "openai",
    model: opts.stub ? null : opts.model,
    maxIters: opts.maxIters,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    app: null,
    previewUrl: null,
    iterations: [],
    status: "error",
    error: null,
  }

  console.log("shipwright")
  console.log(`  idea       ${opts.idea}`)
  console.log(`  brain      ${opts.stub ? "stub (bundled fixtures)" : `openai ${opts.model}`}`)
  console.log(`  max iters  ${opts.maxIters}`)
  console.log(`  run dir    ${runDir}`)

  let spec: AppSpec | null = null
  let deployment: Deployment | undefined

  try {
    const brain = createBrain({ mode: opts.stub ? "stub" : "openai", model: opts.model })

    console.log("\nGenerating app and tests...")
    spec = await brain.generate(opts.idea)
    transcript.app = spec.name
    console.log(`  app    ${spec.name}`)
    console.log(`  files  ${spec.files.map((f) => f.path).join(", ")}`)
    console.log(`  tests  ${spec.tests.map((t) => t.name).join(", ")}`)

    console.log("\nDeploying to a Solari sandbox...")
    deployment = await deploy(spec.files)
    transcript.previewUrl = deployment.url.split("?")[0]
    console.log(`  preview  ${deployment.url}`)

    // Set by a fix, recorded on the iteration that verifies it.
    let filesChanged: string[] | undefined

    for (let iteration = 1; iteration <= opts.maxIters; iteration++) {
      const iterDir = join(runDir, `iter-${iteration}`)
      console.log(`\nIteration ${iteration} of ${opts.maxIters}`)
      console.log(`  running ${spec.tests.length} test(s) in parallel cloud browsers...`)

      const result = await verify(deployment.url, spec.tests, iterDir)
      const record: IterationRecord = {
        iteration,
        filesChanged,
        passed: result.passed,
        testsRun: spec.tests.length,
        failures: result.failures.map((f) => f.message),
        screenshots: result.screenshotPaths,
        replays: result.replayPaths,
      }
      transcript.iterations.push(record)

      if (result.passed) {
        console.log(`  PASS  all ${spec.tests.length} test(s) passed`)
      } else {
        console.log(`  FAIL  ${result.failures.length} of ${spec.tests.length} test(s) failed`)
        for (const failure of result.failures) console.log(indent(failure.message))
      }
      console.log(`  screenshots  ${result.screenshotPaths.length} in ${join(iterDir, "screenshots")}`)
      console.log(`  replays      ${result.replayPaths.length} in ${join(iterDir, "replays")}`)

      if (result.passed) break
      if (iteration === opts.maxIters) break

      console.log("\n  Asking the brain for a fix...")
      const fixed = await brain.fix(spec, result.failures)
      filesChanged = changedPaths(spec.files, fixed.files)
      spec = fixed
      console.log(`  files changed  ${filesChanged.length ? filesChanged.join(", ") : "none"}`)
      console.log("  redeploying...")
      await deployment.redeploy(spec.files)
    }

    const last = transcript.iterations[transcript.iterations.length - 1]
    transcript.status = last.passed ? "passed" : "failed"

    if (last.passed) {
      console.log(`\nGreen after ${last.iteration} iteration(s).`)
      console.log(`  preview  ${deployment.url} (live until the sandbox is killed, below)`)
    } else {
      console.log(`\nStill failing after ${opts.maxIters} iteration(s). Last failures:`)
      for (const message of last.failures) console.log(indent(message))
    }
    return last.passed ? 0 : 1
  } catch (err) {
    transcript.status = "error"
    transcript.error = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    // Write the record first: a crashed run should still leave a true story.
    transcript.finishedAt = new Date().toISOString()
    await writeFile(join(runDir, "transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`)
    if (spec) await writeApp(join(runDir, "final-app"), spec.files)
    console.log(`\nArtifacts`)
    console.log(`  transcript  ${join(runDir, "transcript.json")}`)
    console.log(`  final app   ${join(runDir, "final-app")}`)
    if (deployment) {
      console.log("  killing the sandbox...")
      await deployment.kill().catch((err: unknown) => {
        console.warn(`  sandbox kill failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }
}

/** Paths whose content differs, plus anything the fix added or dropped. */
function changedPaths(before: AppFile[], after: AppFile[]): string[] {
  const previous = new Map(before.map((f) => [f.path, f.content]))
  const changed = after.filter((f) => previous.get(f.path) !== f.content).map((f) => f.path)
  const kept = new Set(after.map((f) => f.path))
  const removed = before.filter((f) => !kept.has(f.path)).map((f) => `${f.path} (removed)`)
  return [...changed, ...removed].sort()
}

async function writeApp(dir: string, files: AppFile[]): Promise<void> {
  for (const file of files) {
    const dest = join(dir, file.path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, file.content)
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

/** console.log to a pipe is async, so flush before exiting or the tail is lost. */
function exit(code: number): void {
  process.stdout.write("", () => process.exit(code))
}

main()
  .then(exit)
  .catch((err: unknown) => {
    console.error(`\nshipwright failed: ${err instanceof Error ? err.message : String(err)}`)
    exit(1)
  })
