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
- Feedback to the model in the functional loop is **text only**; test screenshots are saved for humans.
  The phase 2 visual review is the one deliberate exception: it exists to send viewport captures to the model.
- **One sandbox** lives across all fix iterations (files are overwritten in place; the static server needs no restart).
- Never more than 1 sandbox + 1 desktop concurrently (Starter plan caps at 2).
- Every session ends with `kill()` in a `finally`. `close()` alone leaves the VM running.
- Browser fan-out cap: 10 concurrent (plan allows 20; headroom is deliberate).
- Replay upload is async after release: poll for up to ~30s per session, download immediately, never assume later availability.
- In Node, `await solari.close()` on the browser client at the end or the process hangs (loopback proxy keeps the event loop alive).
- Sandbox `commands.run` is NOT shell-interpreted: argv goes in `args`, or run `sh -c` explicitly.
- Keys come from env (`SOLARI_API_KEY`, `OPENAI_API_KEY`) via `.env` (gitignored). Never in code, logs, or commits.

## Module contract (frozen - see src/types.ts)

- `src/brain.ts` - `createBrain({mode, model, visualModel})` returns `{generate(idea), fix(spec, failures)}`, plus optional `visualReview(spec, screens)` and `usage()`.
  Both optional members are present in openai mode only: stub mode calls no model, so it has nothing to review with and nothing to report.
  `visualReview` runs on `visualModel` (default `gpt-5.6-luna`), not on the build model.
  `mode: "openai"` uses structured JSON output; `mode: "stub"` serves `fixtures/` (a todo app with one planted bug, plus its fixed version) so the whole loop runs E2E with zero OpenAI cost.
- `src/sandbox.ts` - `deploy(files, opts)` returns `{url, redeploy(files), kill()}`.
- `src/verify.ts` - `verify(url, tests, runDir, opts)` returns `{passed, failures, replayPaths, screenshotPaths}`.
  Also exports `captureScreens(url, viewports, outDir)` for phase 2, returning one `ScreenCapture` per viewport.
- `src/index.ts` - CLI orchestrator: `npm start -- "<idea>" [--stub] [--model <id>] [--max-iters N] [--visual-iters N] [--visual-model <id>]`.
  `--max-iters` counts verify rounds, so the default 3 allows at most 2 fixes.
  `--visual-iters` counts visual rounds (default 2); 0 skips phase 2 entirely.
  `--visual-model` defaults to `gpt-5.6-luna` and is passed straight to `createBrain`.
  `--showcase` is deferred and not implemented: passing it exits with a usage error.
  When it is built it will open the finished app in Chrome on a Solari desktop after tests pass and print the VNC `streamUrl` (running while the build sandbox is still up: 1 sandbox + 1 desktop = exactly the plan limit, so nothing else may be alive).

## Phase 2: visual review loop (after functional green)

Real mode only; stub mode skips it and says so.
After the functional tests pass, the agent reviews its own UI:

1. **Capture**: one viewport-sized screenshot (not full page) per viewport, taken from the deployed preview URL, plus one deterministic signal: whether the page scrolls horizontally at that viewport.
2. **Review**: screenshots go to the model (this is the one deliberate exception to "text only") with the current files; it returns a structured verdict: `approved`, or a list of issues plus the complete corrected app.
3. **Re-verify**: after every visual fix the functional tests rerun before the next visual round; a visual fix that breaks behavior gets one functional fix round before continuing.
4. Stop on: approved, `--visual-iters` cap (default 2), or the same issue list twice in a row (oscillation guard).

As implemented: captures land in `runs/<ts>/visual-<round>/`, and that round's re-verify lands in `visual-<round>/recheck/`, or additionally `recheck-after-fix/` when a functional fix was needed.
The oscillation guard compares the issue list to the previous round's and stops before applying the repeated fix, since applying it again would only spend tokens.
A visual round that leaves the app functionally red after its one functional fix stops the run with exit 1.
The review model is capped by the org's per-minute token limit rather than by the model's own context: a two-screenshot request exceeds the `gpt-5.6-sol` allowance on a low tier and comes back as a 429, so `brain.ts` appends a readable hint pointing at `--visual-model`.

Honesty note: the model grades its own work against its own taste with no reference design.
"Approved" means it found nothing more to fix, not objective pixel perfection.
The vision-input probe measured 664 input tokens for one 390x844 PNG at `detail: "auto"`, so images are cheap; full-file rewrites in each visual round are the real cost.

## Design choices

**Response chaining (`previous_response_id`) was considered and rejected.**
The Responses API can thread calls together server-side, which would let a fix or a visual round refer back to the previous turn instead of resending the whole app.
It was rejected because program state, not conversation state, is the source of truth here.
The orchestrator already holds the current `AppSpec` and rewrites it in place, and the sandbox holds the deployed files; a server-side thread would be a second copy of that state that can silently disagree with the first.
Chaining would also make each call depend on a response id from an earlier call, so a retry, a model switch (phase 2 deliberately runs on a different model), or a resumed run would have to reason about a conversation that no longer matches what is deployed.
The saving is pennies per run against a correctness risk in the one thing the loop is supposed to prove, so every call is sent standalone and complete.

## Cost model

- OpenAI: roughly $1-3 per real run on `gpt-5.6-sol` ($4/M in, $20/M out); `gpt-5.6-luna` for cheap runs.
  The estimate is not load-bearing: every real run records the token counts the API reported, per iteration and in total, in `transcript.json`.
  Tokens only, no dollar arithmetic in code, since prices change.
- Solari: cents per run (sessions are minutes long and always killed).
- Stub mode costs only Solari cents and must pass before any OpenAI run.
