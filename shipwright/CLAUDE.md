# CLAUDE.md - shipwright

Read this file, DESIGN.md, and src/types.ts before writing or changing any code.
Keep all three updated whenever behavior changes; stale docs are bugs.

## What this is

Shipwright is an agent that builds, deploys, and E2E-tests its own web apps on Solari (cloud browsers + sandboxes + desktops).
It is a public demo project: reviewers will read every line, so quality and simplicity are the product.

## Code rules

1. Simple beats clever.
Plain functions, no classes unless state genuinely demands it, no abstraction that has only one caller, no config for things that never vary.
2. Robust means: every Solari session is killed in a `finally`, every network wait has a timeout, every failure path produces a readable message.
3. Do NOT write unit test files or test frameworks.
The product IS the verification loop; the only test of shipwright is running it in stub mode end to end.
Time spent on test scaffolding is time stolen from the demo.
4. Match the cookbook examples' style: small files, comments only where something surprising bites.
5. Use only SDK methods that appear in the cookbook examples under ../examples/, or that you have confirmed in node_modules type declarations.
Never guess an API from memory.

## Solari gotchas (encode these, they are real)

- `kill()` destroys a VM; `close()` only drops the control channel and leaves it billing until idle timeout.
- In Node, `await solari.close()` on the browser client or the process hangs forever.
- `commands.run` is not shell-interpreted: argv in `args`, or `sh -c` explicitly.
- Recording is opt-in per session; replay upload is async after release, poll ~30s.
- `timeoutMs` is a rolling idle window, not a deadline.

## Plan limits and budget (Starter, $20 credit, zero overage allowed)

- Max 2 concurrent sandboxes/desktops. Shipwright uses at most 1 sandbox + 1 desktop (showcase only).
- Max 10 concurrent browsers (plan allows 20; headroom is deliberate).
- Sessions are short-lived and always killed.

## Hygiene

- Keys only via env / `.env` (gitignored). Never in code, logs, output, or commits.
- `runs/` is gitignored; artifacts are curated into the repo manually, never committed wholesale.
- Commit messages: plain, no co-author lines, no emoji.
- No em dashes in any written text; use "-".
