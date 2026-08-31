# Shipwright - design

An agent that builds, deploys, and E2E-tests its own web apps on Solari.

## The loop

1. **Generate**: an OpenAI model (`gpt-5.6-sol` by default) turns a one-line idea into a complete static web app plus a test spec.
2. **Deploy**: the app files are written into a Solari sandbox (microVM) and served; a public preview URL is exposed via port preview.
3. **Verify**: a fan-out of Solari cloud browsers runs the test spec in parallel across pages and viewports, with session recording on.
4. **Fix**: failures (text only: failed assertions, console errors, HTTP statuses) go back to the model, which patches the files; the same sandbox is redeployed and verification reruns.
5. Loop until green or `--max-iters` (default 3) is reached, then report honestly either way.

Artifacts land in `runs/<timestamp>/`: one `iter-N/` directory per verify round holding that round's screenshots and replays, plus `transcript.json` and `final-app/`.
The transcript is written before the sandbox is killed, so a crashed run still leaves a true record.

## Hard constraints

- Generated apps are **static only**: plain HTML/CSS/JS files, no build step, no npm dependencies inside the sandbox.
  Served with `python3 -m http.server` (present in the `base` template, proven in the quickstart).
- Feedback to the model is **text only**. Screenshots are saved for humans, never sent to OpenAI.
- **One sandbox** lives across all fix iterations (files are overwritten in place; the static server needs no restart).
- Never more than 1 sandbox + 1 desktop concurrently (Starter plan caps at 2).
- Every session ends with `kill()` in a `finally`. `close()` alone leaves the VM running.
- Browser fan-out cap: 10 concurrent (plan allows 20; headroom is deliberate).
- Replay upload is async after release: poll for up to ~30s per session, download immediately, never assume later availability.
- In Node, `await solari.close()` on the browser client at the end or the process hangs (loopback proxy keeps the event loop alive).
- Sandbox `commands.run` is NOT shell-interpreted: argv goes in `args`, or run `sh -c` explicitly.
- Keys come from env (`SOLARI_API_KEY`, `OPENAI_API_KEY`) via `.env` (gitignored). Never in code, logs, or commits.

## Module contract (frozen - see src/types.ts)

- `src/brain.ts` - `createBrain({mode, model})` returns `{generate(idea), fix(spec, failures)}`.
  `mode: "openai"` uses structured JSON output; `mode: "stub"` serves `fixtures/` (a todo app with one planted bug, plus its fixed version) so the whole loop runs E2E with zero OpenAI cost.
- `src/sandbox.ts` - `deploy(files, opts)` returns `{url, redeploy(files), kill()}`.
- `src/verify.ts` - `verify(url, tests, runDir, opts)` returns `{passed, failures, replayPaths, screenshotPaths}`.
- `src/index.ts` - CLI orchestrator: `npm start -- "<idea>" [--stub] [--model <id>] [--max-iters N]`.
  `--max-iters` counts verify rounds, so the default 3 allows at most 2 fixes.
  `--showcase` is deferred and not implemented: passing it exits with a usage error.
  When it is built it will open the finished app in Chrome on a Solari desktop after tests pass and print the VNC `streamUrl` (running while the build sandbox is still up: 1 sandbox + 1 desktop = exactly the plan limit, so nothing else may be alive).

## Cost model

- OpenAI: roughly $1-3 per real run on `gpt-5.6-sol` ($4/M in, $20/M out); `gpt-5.6-luna` for cheap runs.
- Solari: cents per run (sessions are minutes long and always killed).
- Stub mode costs only Solari cents and must pass before any OpenAI run.
