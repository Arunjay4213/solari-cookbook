/**
 * Deploy static app files into one Solari sandbox and serve them publicly.
 *
 * The whole fix loop reuses a single sandbox: `python3 -m http.server` reads
 * from disk on every request, so a redeploy is just rewriting the files.
 */
import { SolariClient } from "@solarisdk/sdk"
import type { AppFile, Deployment } from "./types.js"

const APP_DIR = "/app"
const PORT = 8080
const DEFAULT_IDLE_MS = 5 * 60_000
const READY_TIMEOUT_MS = 60_000

export async function deploy(
  files: AppFile[],
  opts?: { timeoutMs?: number },
): Promise<Deployment> {
  const solari = new SolariClient({ apiKey: requireApiKey() })

  // timeoutMs is a rolling idle window, not a deadline.
  const sandbox = await solari.sandboxes.create({
    template: "base",
    timeoutMs: opts?.timeoutMs ?? DEFAULT_IDLE_MS,
  })

  let killed = false
  const kill = async (): Promise<void> => {
    if (killed) return
    killed = true
    await sandbox.kill()
  }

  try {
    await sandbox.connect()
    await writeFiles(sandbox, files)

    // `commands.run` waits for the process to exit, so the server has to be
    // backgrounded by a shell. Not `{ background: true }`: that option leaves a
    // never-awaited exit promise registered on the control channel, and kill()
    // rejects it, which crashes the process with an unhandled rejection.
    // The shell exits at once, so this exit code only catches sh-level failures;
    // waitForOk below is the real check that the server came up.
    const started = await sandbox.commands.run("sh", {
      args: ["-c", `cd ${APP_DIR} && nohup python3 -m http.server ${PORT} >/dev/null 2>&1 &`],
    })
    if (started.exitCode !== 0) {
      throw new Error(
        `http.server failed to start (exit ${started.exitCode}): ${started.stderr.trim()}`,
      )
    }

    // The preview URL carries a required `pt_token` query parameter. Callers
    // building sub-paths must keep it: `new URL("/about.html", url)` drops the
    // query and the gateway answers 401.
    const { url } = await sandbox.previewUrl(PORT)
    await waitForOk(url)

    return {
      url,
      redeploy: async (next: AppFile[]) => {
        await clearAppDir(sandbox)
        await writeFiles(sandbox, next)
      },
      kill,
    }
  } catch (err) {
    // A half-created sandbox must never leak; a kill failure must not mask the
    // real error.
    await kill().catch(() => {})
    throw err
  }
}

type SandboxHandle = Awaited<ReturnType<SolariClient["sandboxes"]["create"]>>

function requireApiKey(): string {
  const key = process.env.SOLARI_API_KEY
  if (!key) throw new Error("SOLARI_API_KEY is not set (put it in .env)")
  return key
}

async function writeFiles(sandbox: SandboxHandle, files: AppFile[]): Promise<void> {
  for (const file of files) {
    // files.write creates missing parent directories.
    await sandbox.files.write(`${APP_DIR}/${file.path}`, file.content)
  }
}

/**
 * Empty /app without removing it: the running http.server holds /app as its
 * working directory, so replacing the directory itself would leave it serving a
 * deleted inode.
 */
async function clearAppDir(sandbox: SandboxHandle): Promise<void> {
  const entries = await sandbox.files.list(APP_DIR)
  for (const entry of entries) {
    await sandbox.files.remove(`${APP_DIR}/${entry.name}`, true)
  }
}

async function waitForOk(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last = "no response yet"
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
      last = `HTTP ${res.status}`
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  // Drop the query: it holds the signed preview token, which never belongs in a log.
  const shown = url.split("?")[0]
  throw new Error(
    `preview URL ${shown} never returned 200 within ${READY_TIMEOUT_MS / 1000}s (last: ${last})`,
  )
}
