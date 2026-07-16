# junro（巡路）

> The outbound leg of a journey is **ōro** (往路); the way back is **fukuro** (復路).
> **junro** (巡路) is the patrol route between them: it walks the outbound transcripts,
> collects the human's rulings, and carries them home so they survive.

**junro** measures the *human* half of agentic loop engineering. Where
[fukuro](https://github.com/semigrp/fukuro) measures the outside shape of the machine's
loop (PRs, review rounds, stop-lines), junro measures the correction loop of the person
running it — and whether their lessons survive.

## The thesis

The scarce resource in a human-supervised agent loop is the human's *sense of wrongness*:
the moment they reject an output **and state the replacement rule** («use pnpm, not npm»,
«never add tables to that service», «drafts for humans must be concise»). Empirically:

- corrections that get **institutionalized** (memory, hooks, schemas, skills) do not recur;
- corrections that stay in the chat **recur**, and the cost is paid twice — or forever.

Nobody measures this. junro does: it scans the transcripts that already exist, classifies
the human's utterances, drafts norm entries for adjudication, detects recurrences, and
reports whether teaching is compounding or evaporating.

## Division of labor (four stores, junro owns none of them)

| Concern | Lives in | junro's relation |
|---|---|---|
| Utterance record | Harness transcripts (already written automatically) | reads (adapter: claude-code) |
| Event ledger / KPIs | fukuro.db | emits via the vendored `fukuro.telemetry-event/v1` contract |
| Norm content | **User-owned directory** (`$JUNRO_NORMS`) — markdown, Obsidian-friendly | drafts into `../proposed/`, lints, matches; **never writes into `norm/` itself** |
| Classification | External command (`--classifier`) — your model, your bill | defines the stdin/stdout protocol only |

junro owns exactly: **the vocabulary, the scanner, the lint rules, and recurrence matching.**
This mirrors fukuro's ADR 0001: structures survive only where their write path is automatic,
and a tool that demands manual upkeep starves.

## Vocabulary (the actual product)

| Term | Meaning |
|---|---|
| `correction` | Rejection **plus** a replacement rule. The unit of human teaching. |
| `boundary_check` | Completion audit («did you actually open the issue?»). The most frequent human act in measured practice. |
| `institutionalize` | An explicit order to make a ruling permanent. |
| `stop_boundary` | A declared irreversibility/publication boundary. |
| `norm` | A durable rule with `enforcement` (where it is made to hold: `memory:` / `hook` / `schema:` / … / **`none` = at risk**) and `recurrences`. |
| `norm_recurrence` | The same correction issued again before institutionalization. **The failure metric.** |

Metrics that do not saturate: correction density (per loop/domain — it tracks novelty, not
time), institutionalization rate, institutionalization lag, recurrence rate, audit hit rate.
Self-refuting by design: if institutionalized norms recur as often as unenforced ones,
junro's thesis is falsified and you should delete it.

## CLI (zero dependencies, Node ≥ 24)

```sh
junro scan --since 2026-07-01 --out scan.jsonl        # transcripts → classified events
junro scan --classifier ./recipes/classify.sh ...     # real coverage via your model
junro propose --in scan.jsonl --norms ~/ontology/norm # corrections → proposed/*.md drafts
junro lint --norms ~/ontology/norm                    # unenforced + recurring → exit 1
junro report --in scan.jsonl --norms ~/ontology/norm  # density / inst. rate / recurrences
junro emit --in scan.jsonl | fukuro import            # verbs flow to the ledger, idempotent
```

Adjudication is a file move: a draft in `proposed/` becomes a norm when *you* set
`status: active` and move it into your norm directory. Humans adjudicate; they do not write.

### Classifier protocol

`--classifier <cmd>` runs your command once per scan: JSONL `{id, text}` on stdin, JSONL
`{id, category, statement?}` on stdout (`category` ∈ vocabulary above or `"none"`;
`statement` is the one-line rule a correction sets). The built-in heuristic tier is
deliberately weak — high precision on stock phrasings, poor recall — so that junro itself
stays dependency-free and your model does the reading. See `recipes/`.

### Norm file contract

```markdown
---
type: norm
status: active            # proposed / active / retired (never delete; retire)
scope: repo:someservice   # global / repo:<name> / domain:<name> / ...
enforcement: "memory:use-pnpm"   # or hook / schema:<where> / ... / "none" = at risk
origin: "2026-07-02 session ab12cd34"
recurrences: [2026-07-08]
---
# use-pnpm

**Norm**: Use pnpm, not npm.

**由来**: 「npmではなくpnpmを利用して」(2026-07-02)
```

`**Norm**:` and `**規範**:` are both recognized. Norms with `enforcement: none` are the
actionable gap — inject them at session start (your hook, not junro's) until they are enforced.

## What junro is not

- **Not a memory or RAG system.** It stores no knowledge; `enforcement` points at stores you own.
- **Not a guardrail.** It never sits in the execution path and never blocks anything.
- **Not a second telemetry store.** Events flow to fukuro; junro is a producer.
- **Not a team analytics product.** It measures one human's correction loop.

## Design principles

1. **Value before behavior change.** Input is transcripts that already exist; adopting junro
   requires no new ritual.
2. **Observation, not intervention.** Advisory behavior (session-start injection of
   unenforced norms) is a recipe for *your* hooks, gated by your judgment.
3. **Maker ≠ checker.** Classification runs on a different model than the one that did the
   work; promotion to norm is a human file move.
4. **Failures are first-class.** Recurrence — the lesson that didn't survive — is the
   central metric, not an edge case.
5. **Vendored contracts, no integrations.** The fukuro event contract is vendored;
   norm files are plain markdown; nothing phones home. Transcripts never leave the machine.

## Status

v0.1 — claude-code adapter, heuristic + external classification, propose/lint/report/emit.
The pipeline was validated end-to-end on 602 real utterances across 18 sessions before this
repository existed: 28 corrections, 47 boundary checks, 74% institutionalization rate,
4 recurrence pairs — every recurrence was an unenforced norm.

## License

[Apache-2.0](LICENSE)
