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
import { captureScreens, verify } from "./verify.js"
import type { AppFile, AppSpec, Brain, Deployment, TokenUsage } from "./types.js"

const DEFAULT_MODEL = "gpt-5.6-sol"
const DEFAULT_MAX_ITERS = 3
/** Mirrors brain.ts's default; the CLI always passes one explicitly. */
const DEFAULT_VISUAL_MODEL = "gpt-5.6-luna"
const DEFAULT_VISUAL_ITERS = 2

/** What the model is shown each visual round: one desktop and one phone. */
const VISUAL_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]

/** The shipwright directory, resolved against this module so the CLI can be started anywhere. */
const ROOT = fileURLToPath(new URL("..", import.meta.url))

const USAGE = `Usage: npm start -- "<idea>" [options]

Options:
  --stub              use the bundled fixtures instead of OpenAI (no OpenAI cost)
  --model <id>        OpenAI model id (default ${DEFAULT_MODEL})
  --max-iters N       stop after N verify rounds (default ${DEFAULT_MAX_ITERS})
  --visual-iters N    visual review rounds after the tests pass, 0 skips (default ${DEFAULT_VISUAL_ITERS})
  --visual-model <id> model for the visual review (default ${DEFAULT_VISUAL_MODEL})

Examples:
  npm start -- "a pomodoro timer"
  npm start -- --stub "todo app"`

// ---------------------------------------------------------------------- args

interface Options {
  idea: string
  stub: boolean
  model: string
  maxIters: number
  visualIters: number
  visualModel: string
}

function parseArgs(argv: string[]): Options {
  let stub = false
  let model = DEFAULT_MODEL
  let maxIters = DEFAULT_MAX_ITERS
  let visualIters = DEFAULT_VISUAL_ITERS
  let visualModel = DEFAULT_VISUAL_MODEL
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
    } else if (arg === "--visual-iters") {
      const raw = optionValue(argv, ++i, "--visual-iters")
      visualIters = Number(raw)
      // 0 is valid and means "skip phase 2 entirely".
      if (!Number.isInteger(visualIters) || visualIters < 0) {
        usageError(`--visual-iters must be a non-negative integer, got "${raw}"`)
      }
    } else if (arg === "--visual-model") {
      visualModel = optionValue(argv, ++i, "--visual-model")
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
  return { idea: positionals[0], stub, model, maxIters, visualIters, visualModel }
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
  /** Tokens spent producing this iteration's app: generate on 1, the fix after that. Absent in stub mode. */
  usage?: TokenUsage
  passed: boolean
  testsRun: number
  failures: string[]
  screenshots: string[]
  replays: string[]
}

/** One pass of phase 2: look at the running app, judge it, maybe restyle it. */
interface VisualRound {
  round: number
  model: string
  approved: boolean
  issues: string[]
  /** The screenshots the model was shown. */
  captures?: string[]
  /** Tokens this round spent, review plus any functional fix it triggered. */
  usage?: TokenUsage
  /** Absent when the round changed nothing (approved, or stopped before applying). */
  filesChanged?: string[]
  /** The functional tests, rerun after this round's restyle. */
  functionalRecheck?: {
    passed: boolean
    /** True when the restyle broke a test and a functional fix round was spent. */
    functionalFixApplied: boolean
    failures: string[]
    screenshots: string[]
    replays: string[]
  }
  /** Set when the loop stopped at this round for a reason other than approval. */
  stoppedBecause?: string
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
  /** Phase 2 rounds, in order. Empty when it was skipped. */
  visual: VisualRound[]
  /** Why phase 2 did not run, or null when it did. */
  visualSkipped: string | null
  /** Measured totals for the whole run. Null in stub mode, which calls no model. */
  usage: TokenUsage | null
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
    visual: [],
    visualSkipped: null,
    usage: null,
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
  // Read in the finally as well, so a run that crashes still reports what it spent.
  let readUsage: (() => TokenUsage) | undefined

  try {
    const brain = createBrain({
      mode: opts.stub ? "stub" : "openai",
      model: opts.model,
      visualModel: opts.visualModel,
    })
    readUsage = brain.usage

    // Brain totals are cumulative; each iteration records only what it added.
    let counted = brain.usage?.()
    const usageSinceLast = (): TokenUsage | undefined => {
      const total = brain.usage?.()
      const delta = usageDelta(counted, total)
      counted = total
      return delta
    }

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
        usage: usageSinceLast(),
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

    if (!last.passed) {
      transcript.status = "failed"
      console.log(`\nStill failing after ${opts.maxIters} iteration(s). Last failures:`)
      for (const message of last.failures) console.log(indent(message))
      return 1
    }

    console.log(`\nGreen after ${last.iteration} iteration(s).`)
    console.log(`  preview  ${deployment.url} (live until the sandbox is killed, below)`)

    // Phase 2 grades how the app looks, which only a real model can do.
    let skipped: string | null = null
    if (opts.visualIters === 0) skipped = "--visual-iters 0"
    else if (!brain.visualReview) skipped = "stub mode has no model to review with"
    transcript.visualSkipped = skipped

    if (skipped) {
      console.log(`  visual review skipped: ${skipped}`)
      transcript.status = "passed"
      return 0
    }

    const visual = await visualRounds(brain, deployment, spec, opts, runDir, transcript.visual)
    spec = visual.spec
    transcript.status = visual.green ? "passed" : "failed"
    return visual.green ? 0 : 1
  } catch (err) {
    transcript.status = "error"
    transcript.error = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    // Write the record first: a crashed run should still leave a true story.
    transcript.finishedAt = new Date().toISOString()
    transcript.usage = readUsage?.() ?? null
    if (transcript.usage) {
      const { calls, inputTokens, outputTokens } = transcript.usage
      console.log(`\nopenai usage: ${inputTokens} in / ${outputTokens} out tokens over ${calls} call(s)`)
    }
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

// ------------------------------------------------------------------ phase 2

/**
 * Visual review: screenshot the running app, let the model grade its own UI,
 * apply what it asks for, and prove the app still works before going again.
 *
 * Rounds are pushed into `rounds` as they start and filled in as they progress,
 * so a crash mid-round still leaves the transcript telling the truth.
 * Returns the final spec and whether the app is still functionally green.
 */
async function visualRounds(
  brain: Brain,
  deployment: Deployment,
  startSpec: AppSpec,
  opts: Options,
  runDir: string,
  rounds: VisualRound[],
): Promise<{ spec: AppSpec; green: boolean }> {
  const review = brain.visualReview
  if (!review) throw new Error("visual review was requested but this brain has no reviewer")

  let spec = startSpec
  let previousIssues: string[] | undefined
  const sizes = VISUAL_VIEWPORTS.map((v) => `${v.width}x${v.height}`).join(" and ")
  console.log(`\nVisual review: up to ${opts.visualIters} round(s) on ${opts.visualModel}`)

  for (let n = 1; n <= opts.visualIters; n++) {
    const roundDir = join(runDir, `visual-${n}`)
    const before = brain.usage?.()
    const record: VisualRound = { round: n, model: opts.visualModel, approved: false, issues: [] }
    rounds.push(record)

    console.log(`\nVisual round ${n} of ${opts.visualIters}`)
    console.log(`  capturing ${sizes}...`)
    const screens = await captureScreens(deployment.url, VISUAL_VIEWPORTS, roundDir)
    record.captures = screens.map((s) => s.path)
    for (const s of screens) {
      console.log(`  ${s.name}  horizontal overflow: ${s.overflowX ? "yes" : "no"}`)
    }

    console.log("  asking the model to review its own UI...")
    const verdict = await review(spec, screens)
    record.approved = verdict.approved
    record.issues = verdict.issues
    record.usage = usageDelta(before, brain.usage?.())

    if (verdict.approved) {
      console.log("  APPROVED  the model found nothing further to fix")
      return { spec, green: true }
    }

    console.log(`  CHANGES REQUESTED  ${verdict.issues.length} issue(s)`)
    for (const issue of verdict.issues) console.log(`    - ${issue}`)

    // Identical issues twice running means the model is not converging, and
    // applying the same edit again would only burn tokens.
    if (previousIssues && sameIssues(previousIssues, verdict.issues)) {
      record.stoppedBecause = "the issues were identical to the previous round's"
      console.log("  Stopping: these are exactly the previous round's issues, so the loop is not converging.")
      return { spec, green: true }
    }
    previousIssues = verdict.issues

    if (!verdict.spec) throw new Error("visual review rejected the design but returned no files")
    record.filesChanged = changedPaths(spec.files, verdict.spec.files)
    spec = verdict.spec
    console.log(`  files changed  ${record.filesChanged.length ? record.filesChanged.join(", ") : "none"}`)
    console.log("  redeploying and rerunning the functional tests...")
    await deployment.redeploy(spec.files)

    let result = await verify(deployment.url, spec.tests, join(roundDir, "recheck"))
    let functionalFixApplied = false

    if (!result.passed) {
      console.log(`  the restyle broke ${result.failures.length} test(s); spending one functional fix...`)
      for (const failure of result.failures) console.log(indent(failure.message))
      spec = await brain.fix(spec, result.failures)
      functionalFixApplied = true
      record.usage = usageDelta(before, brain.usage?.())
      await deployment.redeploy(spec.files)
      result = await verify(deployment.url, spec.tests, join(roundDir, "recheck-after-fix"))
    }

    record.functionalRecheck = {
      passed: result.passed,
      functionalFixApplied,
      failures: result.failures.map((f) => f.message),
      screenshots: result.screenshotPaths,
      replays: result.replayPaths,
    }

    if (!result.passed) {
      console.log(`  FAIL  still failing ${result.failures.length} test(s) after the functional fix`)
      for (const failure of result.failures) console.log(indent(failure.message))
      return { spec, green: false }
    }
    console.log("  functional tests still green")
  }

  console.log(`\nVisual review stopped at the --visual-iters cap of ${opts.visualIters}.`)
  return { spec, green: true }
}

function sameIssues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((issue, i) => issue === b[i])
}

/** after - before, or undefined when the brain reports no usage (stub mode). */
function usageDelta(
  before: TokenUsage | undefined,
  after: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!after) return undefined
  if (!before) return after
  return {
    calls: after.calls - before.calls,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
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
