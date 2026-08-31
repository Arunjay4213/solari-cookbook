# Demo artifacts

Everything here was produced by real runs against the live Solari API, curated from the gitignored `runs/` output.
Nothing is mocked or staged.

## pomodoro/ - a real `gpt-5.6-sol` run

`npm start -- "a pomodoro timer"` went green in one iteration: the model's app passed all 5 of its own E2E tests, in parallel Solari cloud browsers, on the first try.

- `screenshots/` - taken by the test browsers at the exact test viewports.
  `skip-to-short-break-mobile.png` shows a real interaction result: the test clicked Skip and the browser captured the mode tab, timer, and status pill all updated.
- `app/` - the app exactly as the model wrote it. Open `index.html` locally to try it.
- `transcript.json` - the run record.

## stub-loop/ - the fix loop catching a planted bug

From a stub-mode run (no OpenAI): the fixture todo app wires its Add button to `#addBtn` while the markup says `id="add-btn"`.
The failure is silent, so only a real browser interaction catches it.

- `iter1-bug-caught.png` - the test typed "Ship the demo" and submitted; the list is still empty. Red.
- `iter2-fixed.png` - after the fix and an in-place redeploy of the same sandbox, the item is in the list. Green.
- `transcript.json` - both iterations, including the full failure text the model would receive.
