# ADR 0001: Own the vocabulary, scanner, lint and recurrence matching; delegate every store

- Status: accepted
- Date: 2026-07-17

## Context

Measurement of the human correction loop needs four things a naive design would bundle into
one product: a record of utterances, a ledger of events, a store of norms, and a classifier.

Prior art inside the same tool family showed both failure modes. A knowledge store that
required deliberate manual distillation (write path) and deliberate manual lookup (read
path) accumulated entries but changed no behavior. A gate runner that required authoring a
request file before any value appeared was skipped in the inner loop. The sibling that
survived daily use (fukuro) owns only a vocabulary and a derivation layer, and parasitizes
write paths that are already automatic.

A manual dry run of the full pipeline (602 utterances, 18 sessions) established that
corrections are mechanically detectable, that institutionalized corrections did not recur,
and that every observed recurrence traced to a correction that had no enforcement point.

## Decision

junro owns exactly four things:

1. **Vocabulary** — correction / boundary_check / spread / institutionalize /
   stop_boundary / norm / enforcement / recurrence, and the metrics defined over them.
2. **Scanner** — adapters that read transcripts which already exist (claude-code first).
3. **Lint** — the rules that make a norm directory honest (`enforcement` mandatory,
   unenforced + recurring = error).
4. **Recurrence matching** — surfacing "you already paid for this lesson".

Everything else is delegated:

- **Events** go to fukuro via the vendored `fukuro.telemetry-event/v1` contract
  (idempotent on source × sourceEventId). junro is a producer, not a ledger.
- **Norms** live in a user-owned markdown directory (`$JUNRO_NORMS`). junro drafts into a
  sibling `proposed/` directory and never writes into `norm/` — promotion is a human file
  move. Content (often confidential) never enters this repository or any junro artifact.
- **Classification** is an external command with a stdin/stdout JSONL protocol. junro ships
  recipes, not model dependencies; the built-in heuristics are a deliberately weak zero-dep
  floor.
- **Advisory injection** of unenforced norms at session start is a recipe for the user's
  own hooks. junro never sits in the execution path.

## Consequences

- Adopting junro requires no new ritual; abandoning it deletes nothing the user owns.
- junro cannot leak norm content because it never stores it.
- Classification quality is the user's model choice; junro's numbers are only as good as
  the classifier supplied. The heuristic floor understates recall and must be labeled as
  such in reports.
- If institutionalized norms recur at the same rate as unenforced ones, the thesis is
  falsified; the correct response is deletion of the tool, not a pivot.
