# Demo artifacts

Everything here was produced by real runs against the live Solari API, curated from the gitignored `runs/` output.
Nothing is mocked or staged.

## pomodoro/ - a real `gpt-5.6-sol` run

`npm start -- "a pomodoro timer"` went green in one iteration: the model's app passed all 5 of its own E2E tests, in parallel Solari cloud browsers, on the first try.

- `screenshots/` - taken by the test browsers at the exact test viewports.
  `skip-to-short-break-mobile.png` shows a real interaction result: the test clicked Skip and the browser captured the mode tab, timer, and status pill all updated.
- `app/` - the app exactly as the model wrote it. Open `index.html` locally to try it.
- `transcript.json` - the run record.

## kanban/ - a real red-to-green fix loop on `gpt-5.6-sol`

`npm start -- "a kanban board for a small team: three columns, add and edit cards, move cards between columns with buttons, filter by label"`.

Iteration 1: 3 of 4 tests passed, but the model's own label-filter test failed - clicking the Bug filter never marked the non-matching card as filtered out.
The failure text went back to the model, which corrected `app.js` and `style.css`; the same sandbox was redeployed in place.
Iteration 2: all 4 tests green.

- `iter1-filter-broken.png` / `iter2-filter-fixed.png` - the failing test's view, before and after the fix.
- `move-card-green.png` - another passing interaction from the green round.
- `transcript.json` - the full record, including measured usage: 9,133 input and 21,334 output tokens over 2 calls, about $0.46 at current `gpt-5.6-sol` prices.

One honest quirk visible in the transcript: the fix returns a complete replacement spec, and the model renamed its tests while fixing the app, so test names differ between iterations.

## stub-loop/ - the fix loop catching a planted bug

From a stub-mode run (no OpenAI): the fixture todo app wires its Add button to `#addBtn` while the markup says `id="add-btn"`.
The failure is silent, so only a real browser interaction catches it.

- `iter1-bug-caught.png` - the test typed "Ship the demo" and submitted; the list is still empty. Red.
- `iter2-fixed.png` - after the fix and an in-place redeploy of the same sandbox, the item is in the list. Green.
- `transcript.json` - both iterations, including the full failure text the model would receive.
