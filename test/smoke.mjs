// Smoke test: scan → propose → lint → emit on a synthetic transcript.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TMP = join(HERE, '.tmp');
rmSync(TMP, { recursive: true, force: true });

// --- fixture transcript (claude-code shape) ---
const proj = join(TMP, 'projects', 'demo');
mkdirSync(proj, { recursive: true });
const entry = (text, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } });
writeFileSync(join(proj, 'sess01.jsonl'), [
  entry('npmではなくpnpmを利用して', '2026-07-02T09:00:00.000Z'),
  entry('issueは本当に切った？', '2026-07-02T09:05:00.000Z'),
  entry('これをSKILL化して', '2026-07-02T09:10:00.000Z'),
  entry('進めて下さい', '2026-07-02T09:15:00.000Z'), // plain direction → not flagged
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'npmではなくpnpm（エージェント発話は無視される）' }] } }),
  entry('<command-name>/foo</command-name>', '2026-07-02T09:20:00.000Z'), // harness artifact
].join('\n'));

const cli = (args, input) =>
  execSync(`node ${join(ROOT, 'cli', 'junro.ts')} ${args}`, { input, stdio: ['pipe', 'pipe', 'pipe'] }).toString();

// --- scan (heuristic) ---
const scanOut = join(TMP, 'scan.jsonl');
cli(`scan --dir ${join(TMP, 'projects')} --out ${scanOut}`);
const records = readFileSync(scanOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cats = records.map((r) => r.category).sort();
assert.deepStrictEqual(cats, ['boundary_check', 'correction', 'institutionalize'], `unexpected: ${cats}`);
assert.ok(records.every((r) => r.schema === 'junro.scan/v1' && r.id.startsWith('sess01:')));

// --- propose: fresh correction → draft ---
const norms = join(TMP, 'norm');
mkdirSync(norms, { recursive: true });
cli(`propose --in ${scanOut} --norms ${norms}`);
const proposed = join(TMP, 'proposed');
assert.strictEqual(readdirSync(proposed).length, 1, 'one draft expected');

// --- propose: same correction vs existing norm → recurrence candidate, no new draft ---
writeFileSync(join(norms, 'use-pnpm.md'), [
  '---', 'type: norm', 'status: active', 'scope: global', 'enforcement: "memory:use-pnpm"',
  'origin: "2026-07-02 session sess01"', '---', '', '# use-pnpm', '',
  '**規範**: npmではなくpnpmを利用する。', '',
].join('\n'));
rmSync(proposed, { recursive: true });
const rec = cli(`propose --in ${scanOut} --norms ${norms}`);
assert.match(rec, /use-pnpm/, 'recurrence candidate should name the matching norm');
assert.ok(!existsSync(proposed) || readdirSync(proposed).length === 0, 'no draft for a recurrence');

// --- lint: unenforced + recurring → exit 1 ---
writeFileSync(join(norms, 'bad.md'), [
  '---', 'type: norm', 'status: active', 'scope: global', 'enforcement: "none"',
  'origin: "2026-07-02 session sess01"', 'recurrences: [2026-07-08]', '---', '',
  '# bad', '', '**規範**: 未制度化のまま再発している規範。', '',
].join('\n'));
let failed = false;
try { cli(`lint --norms ${norms}`); } catch { failed = true; }
assert.ok(failed, 'lint must exit 1 on unenforced+recurring');
rmSync(join(norms, 'bad.md'));
cli(`lint --norms ${norms}`); // now green

// --- emit: valid fukuro.telemetry-event/v1 lines ---
const emitted = cli(`emit --in ${scanOut}`).trim().split('\n').map((l) => JSON.parse(l));
assert.strictEqual(emitted.length, 3);
for (const e of emitted) {
  for (const k of ['schema', 'source', 'sourceEventId', 'occurredAt', 'kind', 'subject', 'refs', 'data'])
    assert.ok(k in e, `emit missing ${k}`);
  assert.strictEqual(e.schema, 'fukuro.telemetry-event/v1');
  assert.strictEqual(e.source, 'junro');
}
assert.ok(emitted.some((e) => e.kind === 'human_intervention'), 'correction must emit as human_intervention');

rmSync(TMP, { recursive: true, force: true });
console.log('smoke: ok');
