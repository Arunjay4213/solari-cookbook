# Shipwright

An agent that builds, deploys, and E2E-tests its own web apps on Solari.

You give it one line of English, and it writes a static web app and a test plan.
It ships the app to a cloud sandbox with a public preview URL, drives that URL in real cloud browsers, and feeds its own failures back to itself until the tests pass.

## How the loop works

1. Generate.
   An OpenAI model turns the idea into a complete static app (HTML, CSS, JS) plus 3 to 6 end-to-end tests spread across desktop, tablet, and mobile viewports, all in one structured JSON response.
2. Deploy.
   The files are written into a Solari sandbox (a microVM) and served by `python3 -m http.server`.
   Solari's port preview gives that port a public HTTPS URL, so anything with a browser can reach the app, including the test browsers and you.
3. Verify.
   Each test gets its own Solari cloud browser, and they run in parallel, at most 10 at a time.
   Every session is recorded, so each test leaves an rrweb replay you can scrub through afterwards and a full-page screenshot of its final state.
4. Fix.
   Failures go back to the model as text only: the assertion that failed, what was expected, what was actually on the page, and any console errors.
   Screenshots and replays are for people to look at and are never sent to the model.
   The model returns the whole corrected app, and it is redeployed into the same sandbox.
5. Repeat until the tests are green or `--max-iters` is reached, and report the outcome either way.

One sandbox is used for the whole run, and it is always killed at the end, whether the run succeeds, fails, or crashes.

### Phase 2: visual review

Passing tests show that the app works and say nothing about how it looks, so once the tests are green the agent looks at what it built.

It takes one viewport-sized screenshot of the running app at 1280x800 and one at 390x844, and measures whether the page scrolls sideways at either size.
Those images go to the model, the one deliberate exception to the text-only rule.
The model either approves the design or returns a list of concrete issues along with the complete restyled app.
The functional tests run again after every restyle, because a layout change can easily break a selector that a test depends on.
If one does break, the agent spends one functional fix round getting back to green before it continues.

The loop stops when the model approves, when `--visual-iters` is reached, or when a round repeats the previous round's issues word for word (a sign that it has stopped converging).
Visual review only runs in real mode.
Stub mode has no model to do the review, and it says so.

Current status: every phase 2 component has been checked against the live APIs, with real calls for both branches of the vision review and the capture path run against a live browser, and the orchestration works in stub mode.
A full end-to-end visual run has not completed yet.
The two runs that got that far each hit a real harness bug (both are fixed and documented in the git history), and then the credit budget ran out.

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
`.env` is gitignored, and keys are never printed.

Real run:

```sh
npm start -- "a pomodoro timer"
```

Zero-OpenAI-cost demo:

```sh
npm start -- --stub "todo app"
```

Stub mode replaces the model with fixtures: a todo app whose Add button is wired to `#addBtn` while the markup says `id="add-btn"`.
Clicking the button does nothing and raises no console error, so only a real click in a real browser catches the bug.
Iteration 1 fails on the fill assertion, the stub "fix" returns the corrected file, and iteration 2 is green.
That runs the whole loop (sandbox, preview URL, parallel browsers, recording, and redeploy) for a few cents of Solari credit.

Options:

```
--stub              use the bundled fixtures instead of OpenAI
--model <id>        OpenAI model id (default gpt-5.6-sol)
--max-iters N       stop after N verify rounds (default 3)
--visual-iters N    visual review rounds after the tests pass, 0 skips (default 2)
--visual-model <id> model for the visual review (default gpt-5.6-luna)
```

The visual review uses a different model by default to work around a rate limit.
A review request carries two screenshots, and on a low API tier that one request is larger than the account's per-minute token allowance for `gpt-5.6-sol`, so it fails with a 429 that retrying cannot fix.
`gpt-5.6-luna` has room for it.
If you hit the limit anyway, the error message says so and points you to `--visual-model`.

## What you get

The console prints each iteration, every failure message in full, the live preview URL, and where the artifacts landed.

Every run writes `runs/<timestamp>/`:

- `iter-1/screenshots/`, `iter-2/screenshots/`: a full-page PNG for each test in each iteration, at the exact viewport the test used.
- `iter-N/replays/`: the rrweb recording of each browser session, so you can replay what the agent saw.
- `visual-1/`, `visual-2/`: one directory per visual review round with the screenshots the model was shown, plus a `recheck/` with the rerun functional tests when the round asked for changes.
- `final-app/`: the app files as they were at the end of the run.
- `transcript.json`: the idea, the mode and model, and for each iteration the files the fix changed, the tests that ran, and the full text of every failure, ending in `passed`, `failed`, or `error`.
The transcript contains no access token, because the recorded preview URL and the failure messages name the page without its query string.
While the run is live the console prints the full URL so you can open the app yourself, and the sandbox is destroyed when the run ends.

`runs/` is gitignored.
Artifacts worth showing are copied into the repo by hand; the whole directory is never committed.

The preview URL only works while the run is going.
The sandbox is killed on the way out, so nothing keeps billing.

## Cost notes

- OpenAI costs roughly $1 to $3 per real run on `gpt-5.6-sol`, because the model writes out every file in full on each iteration.
`gpt-5.6-luna` via `--model` is much cheaper for experimenting.
That range is an estimate, but you can check it: a real run records the token counts the API reported, per iteration and in total, in `transcript.json`, and prints the totals when it finishes.
The screenshots are cheap, around 700 input tokens each; most of the phase 2 cost is the model returning every file in full on each round where it wants changes.
- Solari costs cents per run.
A run uses one sandbox for a few minutes and a handful of browser sessions that last seconds each.
Phase 2 adds two short browser sessions per round for the captures, plus the recheck.
- Stub mode costs no OpenAI money, only the Solari cents.
- Every session ends in `kill()`, inside a `finally` that also runs when the loop throws, so nothing is left running after the process exits.

## Limitations

Shipwright only builds static apps: plain HTML, CSS, and JS with no build step, no npm packages, and no backend.
Anything that needs a server or persistence is out of scope.

There are four kinds of assertion.
A test can check that an element exists, that an element contains text, that a click makes something appear, or that filling a field and submitting makes something appear.
That is good at catching broken wiring and dead buttons, but it does not check layout, styling, animation, or anything else about how the app looks.

In phase 2 the model judges its own screenshots, with no reference design, no brand, and no brief beyond the original one-line idea.
"Approved" only means it found nothing more it wanted to change, which says little about whether the design is objectively good or pixel perfect.
The horizontal-overflow check is the one objective part of that review, since it is measured in the browser.

Outside phase 2 the tests are text only and the model never sees a screenshot, so a page can render badly without the model noticing as long as the assertions pass.

Both loops have a hard cap.
After `--max-iters` verify rounds the run stops and exits non-zero with the remaining failures, and phase 2 stops after `--visual-iters` rounds whether or not the model is satisfied.

The model also writes its own tests.
A generated test suite can be weak, and passing it only means the app satisfies the tests the model wrote, which is different from the app being correct.

`--showcase` is not implemented.
Opening the finished app on a Solari desktop is designed but has been put off for now.
