// Verify: run each TestSpec in its own recorded Solari browser, in parallel.
// Failure messages are the product here - they are the only thing the model
// sees when it tries to fix the app, so they say what was expected, what
// happened, and where.

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Solari, SolariError } from "@solarisdk/browser"
import type { BrowserSession } from "@solarisdk/browser"
import type { Assertion, Failure, TestSpec, VerifyOptions, VerifyResult } from "./types.js"

// Playwright's own types come from a transitive package; deriving them from the
// SDK keeps this file honest about what it actually calls.
type Page = Awaited<ReturnType<BrowserSession["newPage"]>>

const MAX_CONCURRENCY = 10
/** Locator waits and clicks. Long enough for a static page, short enough to fail fast. */
const ACTION_TIMEOUT_MS = 5_000
const GOTO_TIMEOUT_MS = 30_000
/** rrweb batches events; give it a moment to flush before the session is released. */
const RRWEB_FLUSH_MS = 2_000
const REPLAY_ATTEMPTS = 10
const REPLAY_INTERVAL_MS = 3_000
/** Console errors are unbounded in principle; the model only needs a sample. */
const CONSOLE_ERRORS_KEPT = 50
const CONSOLE_ERRORS_IN_MESSAGE = 5

interface TestOutcome {
  failure?: Failure
  screenshotPath?: string
  replayPath?: string
}

export async function verify(
  url: string,
  tests: TestSpec[],
  runDir: string,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    throw new Error("verify: SOLARI_API_KEY is not set (put it in .env)")
  }

  const shotDir = join(runDir, "screenshots")
  const replayDir = join(runDir, "replays")
  await mkdir(shotDir, { recursive: true })
  await mkdir(replayDir, { recursive: true })

  const concurrency = Math.min(Math.max(1, opts?.concurrency ?? MAX_CONCURRENCY), MAX_CONCURRENCY)
  const solari = new Solari({ apiKey })

  let outcomes: TestOutcome[]
  try {
    outcomes = await pool(tests, concurrency, (test) => runTest(solari, url, test, shotDir, replayDir))
  } finally {
    // Required in Node: the client holds a loopback proxy open and the process
    // never exits without this.
    await solari.close()
  }

  const failures = outcomes.flatMap((o) => (o.failure ? [o.failure] : []))
  return {
    passed: failures.length === 0,
    failures,
    replayPaths: outcomes.flatMap((o) => (o.replayPath ? [o.replayPath] : [])),
    screenshotPaths: outcomes.flatMap((o) => (o.screenshotPath ? [o.screenshotPath] : [])),
  }
}

async function runTest(
  solari: Solari,
  url: string,
  test: TestSpec,
  shotDir: string,
  replayDir: string,
): Promise<TestOutcome> {
  const consoleErrors: string[] = []
  const target = joinUrl(url, test.path)
  // Failure messages travel: to the console, into transcript.json, and into the
  // model's input. The preview token belongs in none of them, and the model
  // never needs it, so every message below names the page without its query.
  const shown = stripQuery(target)
  const outcome: TestOutcome = {}
  let sessionId: string | undefined

  try {
    const browser = await solari.launch({ recording: true })
    sessionId = browser.id
    try {
      // newPage() uses the default viewport, so the context carries ours.
      const context = await browser.newContext({ viewport: test.viewport })
      const page = await context.newPage()
      page.on("console", (msg) => {
        if (msg.type() === "error" && consoleErrors.length < CONSOLE_ERRORS_KEPT) {
          consoleErrors.push(msg.text())
        }
      })
      page.on("pageerror", (err) => {
        if (consoleErrors.length < CONSOLE_ERRORS_KEPT) consoleErrors.push(`uncaught ${err.message}`)
      })

      // Errors are folded into `outcome.failure` rather than thrown, so the
      // screenshot below still happens on the failed state.
      try {
        const response = await page.goto(target, {
          waitUntil: "domcontentloaded",
          timeout: GOTO_TIMEOUT_MS,
        })
        if (!response) {
          outcome.failure = fail(test, `opened ${shown} but the navigation produced no response`, consoleErrors)
        } else if (response.status() >= 400) {
          outcome.failure = fail(
            test,
            `opened ${shown} and the server answered HTTP ${response.status()}; no assertion could run`,
            consoleErrors,
          )
        } else {
          outcome.failure = await runAssertions(page, test, shown, consoleErrors)
        }
      } catch (err) {
        outcome.failure = fail(test, `opening ${shown} failed: ${describe(err)}`, consoleErrors)
      }

      // Console errors fail the test only when nothing else already did.
      if (!outcome.failure && consoleErrors.length > 0) {
        outcome.failure = fail(
          test,
          `every assertion passed on ${shown}, but the page logged ${consoleErrors.length} console error(s)`,
          consoleErrors,
        )
      }

      outcome.screenshotPath = await screenshot(page, join(shotDir, `${safeName(test.name)}.png`))
      await sleep(RRWEB_FLUSH_MS)
    } finally {
      // Also releases the session (which starts the replay upload).
      await browser.close()
    }
  } catch (err) {
    // `??=` so a close() error never hides the real assertion failure.
    outcome.failure ??= fail(test, `browser session failed: ${describe(err)}`, consoleErrors)
  }

  if (sessionId) {
    outcome.replayPath = await downloadReplay(solari, sessionId, replayDir, test.name)
  }
  return outcome
}

async function runAssertions(
  page: Page,
  test: TestSpec,
  shown: string,
  consoleErrors: string[],
): Promise<Failure | undefined> {
  for (const [i, assertion] of test.assertions.entries()) {
    const problem = await checkAssertion(page, assertion)
    if (problem) {
      return fail(
        test,
        `assertion ${i + 1} of ${test.assertions.length} (${assertion.kind}) failed on ${shown}: ${problem}`,
        consoleErrors,
      )
    }
  }
  return undefined
}

/** Returns a human-readable problem, or null when the assertion holds. */
async function checkAssertion(page: Page, assertion: Assertion): Promise<string | null> {
  switch (assertion.kind) {
    case "exists":
      return await visible(page, assertion.selector)

    case "text": {
      const missing = await visible(page, assertion.selector)
      if (missing) return missing
      const actual = (await page.locator(assertion.selector).innerText()).trim()
      if (actual.includes(assertion.contains)) return null
      return `expected "${assertion.selector}" to contain "${assertion.contains}", but its text is "${snip(actual)}"`
    }

    case "click": {
      const clickProblem = await click(page, assertion.selector)
      if (clickProblem) return clickProblem
      const missing = await visible(page, assertion.thenExists)
      return missing ? `clicked "${assertion.selector}" but afterwards ${missing}` : null
    }

    case "fill": {
      try {
        await page.locator(assertion.selector).fill(assertion.value, { timeout: ACTION_TIMEOUT_MS })
      } catch (err) {
        return `could not type "${assertion.value}" into "${assertion.selector}" within ${ACTION_TIMEOUT_MS}ms: ${describe(err)}`
      }
      const clickProblem = await click(page, assertion.submitSelector)
      if (clickProblem) return `filled "${assertion.selector}" but then ${clickProblem}`
      const missing = await visible(page, assertion.thenExists)
      return missing ? `submitted "${assertion.submitSelector}" but afterwards ${missing}` : null
    }
  }
}

async function visible(page: Page, selector: string): Promise<string | null> {
  try {
    await page.locator(selector).waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS })
    return null
  } catch {
    return `nothing matching "${selector}" became visible within ${ACTION_TIMEOUT_MS}ms`
  }
}

async function click(page: Page, selector: string): Promise<string | null> {
  try {
    await page.locator(selector).click({ timeout: ACTION_TIMEOUT_MS })
    return null
  } catch {
    return `could not click "${selector}" within ${ACTION_TIMEOUT_MS}ms (missing, hidden, or covered by another element)`
  }
}

/** Screenshots are demo artifacts, never worth failing a test over. */
async function screenshot(page: Page, dest: string): Promise<string | undefined> {
  try {
    await page.screenshot({ path: dest, fullPage: true })
    return dest
  } catch (err) {
    console.warn(`[verify] screenshot ${dest} failed: ${describe(err)}`)
    return undefined
  }
}

/**
 * The replay upload starts only after the session is released, so the first
 * polls legitimately 404. A missing replay is a warning, never a failure.
 */
async function downloadReplay(
  solari: Solari,
  sessionId: string,
  replayDir: string,
  testName: string,
): Promise<string | undefined> {
  for (let attempt = 1; attempt <= REPLAY_ATTEMPTS; attempt++) {
    await sleep(REPLAY_INTERVAL_MS)
    try {
      const bytes = await solari.sessions.downloadReplay(sessionId)
      // The presigned fetch decompresses when the object carries
      // Content-Encoding: gzip; name the file for what actually arrived.
      const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b
      const dest = join(replayDir, `${safeName(testName)}.ndjson${gzipped ? ".gz" : ""}`)
      await writeFile(dest, bytes)
      return dest
    } catch (err) {
      if (err instanceof SolariError && err.status === 404) continue
      console.warn(`[verify] replay for "${testName}" could not be downloaded: ${describe(err)}`)
      return undefined
    }
  }
  console.warn(
    `[verify] no replay for "${testName}" after ~${(REPLAY_ATTEMPTS * REPLAY_INTERVAL_MS) / 1000}s - continuing without it`,
  )
  return undefined
}

function fail(test: TestSpec, message: string, consoleErrors: string[]): Failure {
  const sample = consoleErrors.slice(0, CONSOLE_ERRORS_IN_MESSAGE)
  const tail = sample.length
    ? `\nConsole errors (${consoleErrors.length}${consoleErrors.length > sample.length ? `, first ${sample.length} shown` : ""}):\n` +
      sample.map((e) => `  - ${snip(e)}`).join("\n")
    : ""
  return { test: test.name, message: `[${test.name}] ${message}${tail}`, consoleErrors: [...consoleErrors] }
}

/** Runs `worker` over `items` with at most `limit` in flight, results in order. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i])
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Solari preview URLs carry a required `?pt_token=...`, and they can also sit
 * under a base path. So append the test path to the base's pathname and leave
 * the query alone: plain concatenation would push the path inside the token
 * value and the gateway answers 401.
 */
export function joinUrl(base: string, path: string): string {
  const url = new URL(base)
  const root = url.pathname.replace(/\/+$/, "")
  url.pathname = root + (path.startsWith("/") ? path : `/${path}`)
  return url.toString()
}

/** The page without its `?pt_token=...`: safe to print, log, and hand to the model. */
function stripQuery(url: string): string {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "test"
}

function snip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
