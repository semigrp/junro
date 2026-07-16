# Recipe: classification via a Claude CLI wrapper

junro's `--classifier <cmd>` protocol: your command receives JSONL `{id, text}` on stdin
and must print JSONL `{id, category, statement?}` — one line per *flagged* utterance
(`category: "none"` lines may be omitted). Run it on a **different** model than the one
whose work is being measured (maker ≠ checker).

## Wrapper script

```sh
#!/bin/sh
# classify.sh — pipe scan utterances through a Claude model.
exec claude -p --model sonnet --output-format text "$(cat <<'PROMPT'
You will receive JSONL lines {id, text}: utterances a human sent to an AI coding agent.
Classify each conservatively (skip anything uncertain) into:

- correction: a rejection of the agent's output/approach/vocabulary PLUS a replacement
  rule. e.g. "use pnpm, not npm", "adding tables to that service is the worst option —
  reuse the existing memo field", "write this more concisely".
- boundary_check: independent verification of completion or truth; interrupting a runaway.
  e.g. "did you actually open the issue?", "is that really merged?", "you seem to be
  running away — what were you doing?"
- spread: an order to apply one fix to every same-shaped case. e.g. "check the other
  goals the same way".
- institutionalize: an order to make a ruling permanent. e.g. "turn this into a skill",
  "make sure this never recurs".
- stop_boundary: a declared irreversibility/publication boundary. e.g. "never publish
  this to the repo", "always open PRs as drafts".

Output JSONL only, one object per flagged utterance:
{"id": "<id>", "category": "<category>", "statement": "<for corrections: the rule being
set, one sentence>"}
No prose, no code fences.
PROMPT
)"
```

Then:

```sh
junro scan --since 2026-07-01 --classifier ./classify.sh --out scan.jsonl
```

## Notes

- Utterance text goes to whatever model the wrapper calls. If your transcripts are
  confidential, point the wrapper at a local or org-approved model.
- The prompt above is the one validated on 602 real utterances (high precision with the
  conservative instruction; recall improves with model quality).
- Batch size: junro sends the whole scan in one invocation. If your CLI has input limits,
  make the wrapper split stdin and merge outputs.
