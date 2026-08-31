# Shipwright

An agent that builds, deploys, and E2E-tests its own web apps on Solari.

You give it one line of English.
It writes a static web app and a test plan, ships the app to a cloud sandbox with a public preview URL, drives that URL in real cloud browsers, and reads its own failures back to itself until the tests pass.

## How the loop works

1. **Generate.**
An OpenAI model turns the idea into a complete static app (HTML, CSS, JS) plus 3 to 6 end-to-end tests spread across desktop, tablet, and mobile viewports.
Both come back in one structured JSON response.
2. **Deploy.**
The files are written into a Solari sandbox (a microVM) and served by `python3 -m http.server`.
Solari's port preview turns that port into a public HTTPS URL, so anything with a browser can reach the app - including the test browsers, and you.
3. **Verify.**
Each test gets its own Solari cloud browser, and they run in parallel (capped at 10 at a time).
Every session records itself, so each test produces an rrweb replay you can scrub through afterwards, plus a full-page screenshot at its final state.
4. **Fix.**
Failures go back to the model as text only: the assertion that failed, what was expected, what was actually on the page, and any console errors.
Screenshots and replays are for humans and are never sent to the model.
The model returns the whole corrected app, and the same sandbox is redeployed in place.
5. **Repeat** until the tests are green or `--max-iters` is reached, then report honestly either way.

One sandbox lives for the whole run and is always killed at the end, on success, failure, or crash.

## Quickstart

```sh
git clone <this repo>
cd shipwright
npm install
```

Create a `.env` file in this directory:

```
SOLARI_API_KEY=your-solari-key
OPENAI_API_KEY=your-openai-key
```

`OPENAI_API_KEY` is only needed for real runs.
`.env` is gitignored, and no key is ever printed.

Real run:

```sh
npm start -- "a pomodoro timer"
```

Zero-OpenAI-cost demo:

```sh
npm start -- --stub "todo app"
```

Stub mode replaces the model with fixtures: a todo app whose Add button is wired to `#addBtn` while the markup says `id="add-btn"`.
The button silently does nothing, and no console error is raised, so only a real click in a real browser catches it.
Iteration 1 fails on the fill assertion, the stub "fix" returns the corrected file, and iteration 2 is green.
It exercises the entire loop - sandbox, preview URL, parallel browsers, recording, redeploy - for a few cents of Solari credit.

Options:

```
--stub            use the bundled fixtures instead of OpenAI
--model <id>      OpenAI model id (default gpt-5.6-sol)
--max-iters N     stop after N verify rounds (default 3)
```

## What you get

The console prints each iteration, every failure message in full, the live preview URL, and where the artifacts landed.

Every run writes `runs/<timestamp>/`:

- `iter-1/screenshots/`, `iter-2/screenshots/` - a full-page PNG per test per iteration, at the exact viewport the test used.
- `iter-N/replays/` - the rrweb recording of each browser session, so you can replay what the agent saw.
- `final-app/` - the app files as they stood at the end of the run.
- `transcript.json` - the idea, the mode and model, and per iteration: which files the fix changed, which tests ran, and the full text of every failure, ending in `passed`, `failed`, or `error`.
No access token appears in the transcript: the recorded preview URL and every failure message name the page without its query string.
The console prints the full URL while the run is live so you can open the app yourself, and the sandbox is destroyed when the run ends.

`runs/` is gitignored.
Artifacts are copied into the repo by hand when they are worth showing, never committed wholesale.

The preview URL stays live only while the run is going.
The sandbox is killed on the way out, so nothing keeps billing.

## Cost notes

- OpenAI: roughly $1 to $3 per real run on `gpt-5.6-sol`, since the model emits every file in full on each iteration.
`gpt-5.6-luna` via `--model` is much cheaper for experimenting.
- Solari: cents per run.
A run uses one sandbox for a few minutes and a handful of browser sessions that live for seconds each.
- Stub mode costs no OpenAI money at all, only the Solari cents.
- Every session ends in `kill()`, in a `finally` that also runs when the loop throws.
Nothing is left running after the process exits.

## Limitations

These are real, and worth knowing before you judge the output.

- **Static apps only.**
Plain HTML, CSS, and JS with no build step, no npm packages, and no backend.
Anything needing a server or persistence is out of scope.
- **Four assertion kinds.**
A test can check that an element exists, that an element contains text, that a click makes something appear, or that filling a field and submitting makes something appear.
That catches broken wiring and dead buttons well.
It does not check layout, styling, animation, or anything about how the app looks.
- **Screenshots are for you, not the agent.**
The model only ever sees text, so it cannot notice that a page renders badly as long as the assertions pass.
- **The fix budget is capped.**
After `--max-iters` verify rounds the run stops and exits non-zero with the remaining failures.
It does not keep trying.
- **The model writes its own tests.**
A generated test suite can be weak, and passing tests mean the app satisfies the tests it wrote, not that it is correct.
- **`--showcase` is not implemented.**
Opening the finished app on a Solari desktop is designed but deferred.
