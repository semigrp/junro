#!/usr/bin/env node
// junro（巡路）— patrol the outbound leg: collect the human's corrections,
// carry them to the noun store, and measure whether the lessons survived.
//
// Owns only: vocabulary, scanner, lint, recurrence matching.
// Delegates: event storage (fukuro import contract), norm storage (user-owned
// directory, $JUNRO_NORMS), classification (external command, --classifier).
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

type Category = 'correction' | 'boundary_check' | 'spread' | 'institutionalize' | 'stop_boundary';
interface Utterance { id: string; ts: string; session: string; text: string }
interface ScanRecord {
  schema: 'junro.scan/v1'; id: string; ts: string; session: string;
  category: Category; text: string; statement?: string; classifier: 'heuristic' | 'external';
}

// ---------- args ----------
const [, , cmd, ...rest] = process.argv;
const opt = (name: string, fallback?: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const fail = (msg: string): never => { console.error(`junro: ${msg}`); process.exit(1); };

// ---------- transcript adapter: claude-code ----------
// One session = one .jsonl under <dir>/<project>/<session>.jsonl.
// A human utterance is a `type: "user"` entry whose content is plain text —
// command wrappers, tool results, system notifications and compaction
// summaries are harness artifacts, not the human speaking.
const NOT_HUMAN = [
  '<command-name>', '<local-command', 'Caveat:', '[Request interrupted',
  'Base directory for this skill:', 'This session is being continued',
];
function extractUtterances(dir: string, since?: string): Utterance[] {
  if (!existsSync(dir)) fail(`transcript dir not found: ${dir}`);
  // サブエージェント/ワークフローのトランスクリプトでは 'user' ロール＝親エージェントの
  // 委譲プロンプトであり、人間の発話ではない。巡回対象は人間のセッションだけ。
  const files = (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.jsonl'))
    .filter((f) => !basename(f).startsWith('agent-') && basename(f) !== 'journal.jsonl')
    .filter((f) => !/(^|\/)(subagents|tasks|workflows)\//.test(f))
    .map((f) => join(dir, f));
  const out: Utterance[] = [];
  for (const file of files) {
    const session = basename(file, '.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let e: any; try { e = JSON.parse(line); } catch { return; }
      if (e?.type !== 'user') return;
      const content = e.message?.content;
      const texts: string[] = typeof content === 'string' ? [content]
        : Array.isArray(content)
          ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '')
          : [];
      for (const t of texts) {
        const text = String(t).trim();
        if (!text) continue;
        if (NOT_HUMAN.some((p) => text.startsWith(p))) continue;
        if (text.includes('[SYSTEM NOTIFICATION') || text.includes('<task-notification>')
          || text.includes('<system-reminder>')) continue;
        const ts = String(e.timestamp ?? '');
        if (since && ts && ts < since) continue;
        out.push({ id: `${session}:${i + 1}`, ts, session, text });
      }
    });
  }
  return out;
}

// ---------- classification ----------
// Heuristic tier is deliberately weak (documented): zero-dep, high precision
// on stock phrasings, poor recall. Use --classifier for real coverage.
const HEURISTICS: Array<[Category, RegExp]> = [
  ['correction', /(ではなく|じゃなくて|やめて|やめましょう|は最悪|違うね|却下|微妙です)/],
  ['institutionalize', /(skill化|スキル化|SKILL化|仕組み化|恒久|再発しないように|運用を追加|規約にして|反映しておいて)/i],
  ['spread', /(他にも|他の\S+も|同様に(構築|更新|修正|実施))/],
  ['stop_boundary', /(公開しては?ダメ|載せないで|ローカルだけ|ローカル限定|は禁止)/],
  ['boundary_check', /(本当に.+(\?|？)|してる(\?|？)$|できてる(\?|？)$|切った(\?|？)|したの(\?|？)$|されてる(\?|？)$)/],
];
function heuristic(u: Utterance): ScanRecord | null {
  for (const [category, re] of HEURISTICS) {
    if (re.test(u.text)) {
      return { schema: 'junro.scan/v1', id: u.id, ts: u.ts, session: u.session,
        category, text: u.text.slice(0, 300), classifier: 'heuristic' };
    }
  }
  return null;
}
// External classifier protocol: JSONL {id,text} on stdin → JSONL
// {id, category: Category|"none", statement?} on stdout. See recipes/.
function external(cmdline: string, us: Utterance[]): ScanRecord[] {
  const input = us.map((u) => JSON.stringify({ id: u.id, text: u.text })).join('\n');
  const stdout = execSync(cmdline, { input, maxBuffer: 64 * 1024 * 1024 }).toString();
  const byId = new Map(us.map((u) => [u.id, u]));
  const out: ScanRecord[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    const u = byId.get(r.id);
    if (!u || !r.category || r.category === 'none') continue;
    out.push({ schema: 'junro.scan/v1', id: u.id, ts: u.ts, session: u.session,
      category: r.category, text: u.text.slice(0, 300), statement: r.statement, classifier: 'external' });
  }
  return out;
}

// ---------- norm store (user-owned; junro never writes into norm/ itself) ----------
interface Norm { slug: string; file: string; status: string; enforcement: string; recurrences: string[]; statement: string }
function loadNorms(dir: string): Norm[] {
  if (!existsSync(dir)) return [];
  const out: Norm[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const raw = readFileSync(join(dir, f), 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    if (!/^type:\s*norm/m.test(fm)) continue;
    const get = (k: string) => fm.match(new RegExp(`^${k}:\\s*"?([^"\\n]+)"?`, 'm'))?.[1]?.trim() ?? '';
    const rec = fm.match(/^recurrences:\s*\[([^\]]*)\]/m)?.[1] ?? '';
    const statement = raw.match(/^\*\*(?:規範|Norm)\*\*:\s*(.+)$/m)?.[1]
      ?? raw.match(/^# (.+)$/m)?.[1] ?? '';
    out.push({ slug: f.replace(/\.md$/, ''), file: join(dir, f), status: get('status'),
      enforcement: get('enforcement'), recurrences: rec.split(',').map((s) => s.trim()).filter(Boolean), statement });
  }
  return out;
}
const grams = (s: string): Set<string> => {
  const t = s.toLowerCase().replace(/\s+/g, '');
  const g = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
};
const dice = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size);
};

// ---------- io ----------
const readRecords = (path?: string): ScanRecord[] => {
  const raw = path ? readFileSync(path, 'utf8') : readFileSync(0, 'utf8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    .filter((r) => r.schema === 'junro.scan/v1');
};

// ---------- commands ----------
function cmdScan(): void {
  const dir = opt('dir', join(homedir(), '.claude', 'projects'))!;
  const us = extractUtterances(dir, opt('since'));
  const cls = opt('classifier');
  const records = cls ? external(cls, us) : us.map(heuristic).filter((r): r is ScanRecord => r !== null);
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  const out = opt('out');
  if (out) writeFileSync(out, lines + '\n'); else if (lines) console.log(lines);
  console.error(`junro scan: ${us.length} utterances → ${records.length} events (${cls ? 'external' : 'heuristic'} classifier)`);
}

function cmdPropose(): void {
  const normsDir = opt('norms', process.env.JUNRO_NORMS)!;
  if (!normsDir) fail('--norms <dir> or $JUNRO_NORMS required');
  const proposedDir = opt('proposed', join(normsDir, '..', 'proposed'))!;
  const norms = loadNorms(normsDir).filter((n) => n.status !== 'retired');
  const seen = norms.map((n) => ({ n, g: grams(n.statement) }));
  const threshold = Number(opt('threshold', '0.35'));
  let drafts = 0; const recurrences: string[] = [];
  for (const r of readRecords(opt('in'))) {
    if (r.category !== 'correction') continue;
    const g = grams(r.statement ?? r.text);
    const hit = seen.map(({ n, g: ng }) => ({ n, s: dice(g, ng) })).sort((a, b) => b.s - a.s)[0];
    if (hit && hit.s >= threshold) {
      recurrences.push(`${r.ts.slice(0, 10)} ${r.id} 〜 norm/${hit.n.slug} (sim=${hit.s.toFixed(2)}) — 裁定: recurrences に追記するか無関係と判断`);
      continue;
    }
    mkdirSync(proposedDir, { recursive: true });
    const slug = `c-${r.ts.slice(0, 10).replaceAll('-', '')}-${r.id.split(':').pop()}`;
    const p = join(proposedDir, `${slug}.md`);
    if (existsSync(p)) continue;
    writeFileSync(p, [
      '---', 'type: norm', 'status: proposed', 'scope: unknown', 'enforcement: "none"',
      `origin: "${r.ts.slice(0, 16)} session ${r.session}"`, '---', '',
      `# ${slug}`, '',
      `**規範**: ${r.statement ?? '（裁定時に1文へ要約する）'}`, '',
      `**由来**: 「${r.text.slice(0, 120)}」(${r.ts.slice(0, 10)})`, '',
      '**再発**: なし', '',
    ].join('\n'));
    drafts++;
  }
  console.error(`junro propose: ${drafts} draft(s) → ${proposedDir}; ${recurrences.length} recurrence candidate(s)`);
  for (const line of recurrences) console.log(line);
}

function cmdLint(): void {
  const normsDir = opt('norms', process.env.JUNRO_NORMS)!;
  if (!normsDir) fail('--norms <dir> or $JUNRO_NORMS required');
  const errors: string[] = []; const warns: string[] = [];
  for (const n of loadNorms(normsDir)) {
    if (!n.status) errors.push(`${n.slug}: status がない`);
    if (!n.enforcement) errors.push(`${n.slug}: enforcement がない（none でも明示する）`);
    if (n.enforcement === 'none' && n.recurrences.length > 0)
      errors.push(`${n.slug}: 未制度化のまま再発している（recurrences=${n.recurrences.length}）— 制度化を最優先タスクへ`);
    if (n.status === 'active' && !n.statement) warns.push(`${n.slug}: 規範文（**規範**: / **Norm**:）がない`);
  }
  for (const w of warns) console.error(`warn  ${w}`);
  for (const e of errors) console.error(`error ${e}`);
  console.error(`junro lint: ${errors.length} error(s), ${warns.length} warning(s)`);
  if (errors.length) process.exit(1);
}

function cmdReport(): void {
  const records = opt('in') || !process.stdin.isTTY ? readRecords(opt('in')) : [];
  const normsDir = opt('norms', process.env.JUNRO_NORMS);
  const by: Record<string, number> = {};
  const sessions = new Set<string>();
  for (const r of records) { by[r.category] = (by[r.category] ?? 0) + 1; sessions.add(r.session); }
  console.log('junro report');
  if (records.length) {
    console.log(`  sessions: ${sessions.size}  events: ${records.length}`);
    for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);
    const c = by['correction'] ?? 0;
    if (sessions.size) console.log(`  correction density: ${(c / sessions.size).toFixed(2)} /session`);
  }
  if (normsDir && existsSync(normsDir)) {
    const norms = loadNorms(normsDir);
    const active = norms.filter((n) => n.status === 'active');
    const none = active.filter((n) => n.enforcement === 'none');
    const rec = norms.reduce((s, n) => s + n.recurrences.length, 0);
    console.log(`  norms: ${active.length} active (${norms.length} total)`);
    console.log(`  institutionalization rate: ${active.length ? Math.round((1 - none.length / active.length) * 100) : 0}% (enforcement:none = ${none.length})`);
    console.log(`  recorded recurrences: ${rec}`);
  }
}

// Emit fukuro.telemetry-event/v1 (vendored contract: contracts/). Canonical
// kind for a correction is human_intervention; the rest ship namespaced.
const KIND: Record<Category, string> = {
  correction: 'human_intervention',
  boundary_check: 'junro.boundary_check',
  spread: 'junro.spread',
  institutionalize: 'junro.institutionalize_directive',
  stop_boundary: 'junro.stop_boundary',
};
function cmdEmit(): void {
  for (const r of readRecords(opt('in'))) {
    if (!r.ts) continue;
    console.log(JSON.stringify({
      schema: 'fukuro.telemetry-event/v1',
      source: 'junro',
      sourceEventId: r.id,
      occurredAt: r.ts,
      kind: KIND[r.category],
      subject: { system: 'junro', type: 'session', id: r.session, version: '1' },
      refs: [],
      data: { category: r.category, note: r.text.slice(0, 200), ...(r.statement ? { statement: r.statement } : {}) },
    }));
  }
}

const HELP = `junro — patrol the outbound leg (scan / propose / lint / report / emit)

  junro scan    [--dir <transcripts>] [--since <ISO>] [--classifier <cmd>] [--out <file>]
  junro propose [--in <scan.jsonl>] [--norms <dir>] [--proposed <dir>] [--threshold 0.35]
  junro lint    [--norms <dir>]
  junro report  [--in <scan.jsonl>] [--norms <dir>]
  junro emit    [--in <scan.jsonl>]        # fukuro.telemetry-event/v1 → | fukuro import

  $JUNRO_NORMS  default norm directory (user-owned; junro drafts into ../proposed, never norm/)
`;

switch (cmd) {
  case 'scan': cmdScan(); break;
  case 'propose': cmdPropose(); break;
  case 'lint': cmdLint(); break;
  case 'report': cmdReport(); break;
  case 'emit': cmdEmit(); break;
  default: console.log(HELP);
}
