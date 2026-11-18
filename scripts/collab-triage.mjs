#!/usr/bin/env node
/**
 * `collab-triage` — the maintainer's consumption end of the defect self-report
 * (PRD R9).
 *
 * The plugin writes evidence to `~/.config/opencode/collab-reports/<sig>/<ts>.{json,md}`
 * and (if `report.to` is configured) queues a `note`. That note can be missed
 * (maintainer offline, plugin reloaded, target protected), so this script is the
 * idempotent sweep a cron job runs:
 *
 *   cron (every 15 min): node scripts/collab-triage.mjs --notify <alias|ses_…>
 *
 * For every signature whose newest evidence is newer than the last triage run it
 * generates/refreshes `docs/issues/bugs-collab-<sig>.md` and writes `triagedAt`
 * back to `collab-reports/index.json`. Nothing else is touched: the plugin never
 * closes a hand-off and this script never edits source or git.
 *
 * Flags:
 *   --dry-run          print what would happen, write nothing (no issue, no index)
 *   --since <iso>      only evidence at/after this timestamp
 *   --notify <alias|sid>  additionally POST one note to the maintainer session
 *                         (needs COLLAB_SERVER_URL; protected targets are refused)
 *   --repo <path>      repository root for docs/issues (default: cwd)
 *   --dir <path>       report directory (default: COLLAB_REPORT_DIR or ~/.config/opencode/collab-reports)
 *
 * Zero dependencies (Node built-ins only), same as the plugin. Concurrency-safe:
 * one `<reportDir>/.<sig>.lock` per signature (`open 'wx'`), stale after 10min.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const BUILTIN_PROTECT = ['ses_e1eb91cebffeTv1467ubJLKebk', 'ses_e23a4a23fffe4c4m7UQFR8dUL3']; // src/constants.ts
const INDEX_FILE = 'index.json';
const LOCK_STALE_MS = 10 * 60 * 1000;
const DEFAULT_CONFIG = join(homedir(), '.config', 'opencode', 'collab.json');
const DEFAULT_REPORT_DIR =
  process.env.COLLAB_REPORT_DIR || join(homedir(), '.config', 'opencode', 'collab-reports');

// ------------------------------------------------------------------ arguments
function parseArgs(argv) {
  const out = { dryRun: false, since: 0, notify: '', repo: process.cwd(), dir: DEFAULT_REPORT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--since') {
      const raw = String(argv[++i] ?? '').trim();
      const stamp = Date.parse(raw);
      if (!Number.isFinite(stamp)) fail(`--since 需要 ISO 时间（收到 "${raw}"）`);
      out.since = stamp;
    } else if (arg === '--notify') out.notify = String(argv[++i] ?? '').trim();
    else if (arg === '--repo') out.repo = resolve(String(argv[++i] ?? '.'));
    else if (arg === '--dir') out.dir = resolve(String(argv[++i] ?? ''));
    else if (arg === '--help' || arg === '-h') {
      const header = readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0];
      console.log(header.replace(/^#![^\n]*\n/, '').replace(/^\/\*\*?/, ''));
      process.exit(0);
    } else fail(`未知参数：${arg}（--help 看用法）`);
  }
  return out;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function warn(message) {
  console.error(`! ${message}`);
}

// --------------------------------------------------------------------- index
function indexFile(dir) {
  return join(dir, INDEX_FILE);
}

/** `{sig: {lastAt, triagedAt, …}}`; tolerates the legacy `{sig: number}` shape. */
function readIndex(dir) {
  try {
    const raw = JSON.parse(readFileSync(indexFile(dir), 'utf8'));
    const out = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (!key.startsWith('d_')) continue;
      out[key] = typeof value === 'number' ? { lastAt: value } : { ...(value ?? {}) };
    }
    return out;
  } catch {
    return {};
  }
}

function writeIndex(dir, index) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${indexFile(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
  renameSync(tmp, indexFile(dir));
}

// ------------------------------------------------------------------ evidence
function readEvidence(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return {};
  }
  const bySig = {};
  for (const name of names) {
    if (!name.startsWith('d_')) continue;
    const sigDir = join(dir, name);
    try {
      if (!statSync(sigDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const entries = [];
    for (const file of readdirSync(sigDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(sigDir, file), 'utf8'));
        entries.push({ ...data, file: join(sigDir, file), md: join(sigDir, file.replace(/\.json$/, '.md')) });
      } catch {
        warn(`跳过不可读证据：${join(sigDir, file)}`);
      }
    }
    if (entries.length) bySig[name] = entries.sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));
  }
  return bySig;
}

function unique(list) {
  return [...new Set(list.filter(Boolean).map(String))];
}

function truncate(text, max = 300) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function issuePath(repo, sig) {
  return join(repo, 'docs', 'issues', `bugs-collab-${sig}.md`);
}

/** Keep an operator-edited status line, everything else is regenerated. */
function existingStatus(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const match = /^> 状态：(.+)$/m.exec(text);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function renderIssue({ sig, entries, status }) {
  const first = entries[0];
  const last = entries[entries.length - 1];
  const versions = unique(entries.map(entry => entry.version));
  const tools = unique(entries.map(entry => entry.tool));
  const classes = unique(entries.map(entry => entry.class));
  const bids = unique(entries.flatMap(entry => [entry.context?.bid, ...(String(entry.error?.message ?? '').match(/\bb_[0-9a-f]{8,32}\b/g) ?? [])]));
  const threads = unique(entries.map(entry => entry.context?.thread));
  const workspaces = unique(entries.map(entry => entry.workspace));
  const messages = unique(entries.map(entry => `${entry.error?.name ?? 'Error'}: ${truncate(entry.error?.message ?? '', 300)}`));

  return [
    `# 插件缺陷 ${sig}：${tools.join('/')} / ${classes.join('/')}`,
    '',
    `> 状态：${status || '待处理（collab-triage 自动生成）'}`,
    `> 签名：${sig}`,
    `> 受影响版本：${versions.join(', ') || '(unknown)'}`,
    `> 首次上报：${new Date(Number(first.at ?? 0)).toISOString()}`,
    `> 最近上报：${new Date(Number(last.at ?? 0)).toISOString()}`,
    `> 上报次数：${entries.length}（同签名每小时最多 1 条，不代表真实发生次数）`,
    `> 工作区：${workspaces.join(', ') || '(unknown)'}`,
    `> 涉及 bid：${bids.join(', ') || '-'}`,
    `> 涉及 thread：${threads.join(', ') || '-'}`,
    '',
    '## 现象',
    '',
    ...messages.map(message => `- \`${message.replace(/`/g, "'")}\``),
    '',
    '## 复现线索',
    '',
    `- 工具：${tools.join(', ') || '-'}`,
    `- 分类：${classes.join(', ') || '-'}`,
    `- 调用方会话（短 id）：${unique(entries.map(entry => entry.context?.from)).join(', ') || '-'}`,
    '- 参数正文/文件内容/token 未入库（证据白名单 + 脱敏）',
    '',
    '## 证据',
    '',
    ...entries.map(entry => `- \`${entry.file}\`（${new Date(Number(entry.at ?? 0)).toISOString()}）`),
    '',
    '## 影响面',
    '',
    '- 该错误让调用方拿到异常；是否可自愈未知（上报是旁路，不改变协作状态）',
    '- 修复后：在 CHANGELOG 写明，并把上面「状态」改成「已修复（版本 x.y.z）」；triage 之后不再重复生成',
    '',
    '## 处理流程',
    '',
    '1. 读证据 JSON 与该工具的现状代码，判断是缺陷还是调用方误用',
    '2. 复现 → 开 Trellis 任务 → 修 → 发补丁版本 → 回执上报方',
    '',
    '<!-- 由 scripts/collab-triage.mjs 生成；重跑会按最新证据重建本文件（保留「状态」行） -->'
  ].join('\n');
}

function writeIssue(path, body) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${body}\n`);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------- locks
/**
 * Advisory lock for one triage run. Returns `undefined` only when **another run
 * really holds it** (`EEXIST` and fresh). A missing report directory is not a
 * lock conflict: it is the normal state of a fresh install (or after the
 * documented rollback deleted the directory), so it is created and retried once
 * — otherwise cron would print "另一个 triage 正在运行" every 15 minutes forever.
 */
function lockDir(dir, retried = false) {
  const path = join(dir, '.triage.lock');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* a read-only dir will fail on open below, with a real errno */
  }
  try {
    const fd = openSync(path, 'wx');
    writeSyncSafe(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
    return path;
  } catch (error) {
    if (error?.code === 'ENOENT' && !retried) return lockDir(dir, true);
    if (error?.code !== 'EEXIST') return undefined;
    try {
      if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
        rmSync(path, { force: true });
        return lockDir(dir, true);
      }
    } catch {
      /* raced: another process finished it */
    }
    return undefined;
  }
}

function writeSyncSafe(fd, text) {
  try {
    writeFileSync(fd, text);
  } catch {
    /* best effort: the lock is advisory */
  }
}

function unlock(path) {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* already gone */
  }
}

// --------------------------------------------------------------------- notify
function readConfigFile(path = process.env.COLLAB_CONFIG || DEFAULT_CONFIG) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** `alias|ses_…` → sid, plus the protect list (builtin + config, additive). */
function resolveMaintainer(raw) {
  const config = readConfigFile();
  const protect = [...BUILTIN_PROTECT, ...(Array.isArray(config.protect) ? config.protect : [])].map(String);
  let sid = String(raw ?? '').trim();
  const aliases = { ...(config.aliases ?? {}) };
  try {
    const legacy = JSON.parse(readFileSync(join(homedir(), '.config', 'opencode', 'collab-aliases.json'), 'utf8'));
    Object.assign(aliases, legacy ?? {});
  } catch {
    /* no legacy alias file */
  }
  if (sid && !sid.startsWith('ses_')) sid = String(aliases[sid] ?? '');
  return { sid, protect };
}

async function notify(raw, text) {
  const { sid, protect } = resolveMaintainer(raw);
  if (!sid) {
    warn(`--notify "${raw}" 既不是 ses_… 也不在别名表：未通知（证据文件仍然已生成）`);
    return { sent: false, reason: 'unknown-target' };
  }
  if (protect.includes(sid)) {
    warn(`--notify 目标 ${sid} 在 protect 名单内：拒绝投递（只保留证据文件）`);
    return { sent: false, reason: 'protected' };
  }
  const base = String(process.env.COLLAB_SERVER_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) {
    warn('未配置 COLLAB_SERVER_URL：跳过 --notify（cron 里配好它才能真正补投）');
    return { sent: false, reason: 'no-server' };
  }
  const token = String(process.env.COLLAB_SERVER_TOKEN ?? '').trim();
  try {
    const response = await fetch(`${base}/api/session/${encodeURIComponent(sid)}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      warn(`--notify 投递失败：HTTP ${response.status} ${truncate(detail, 160)}`);
      return { sent: false, reason: `http-${response.status}` };
    }
    console.log(`✓ 已通知 ${sid}`);
    return { sent: true, reason: 'ok' };
  } catch (error) {
    warn(`--notify 投递异常：${error?.message ?? error}`);
    return { sent: false, reason: 'error' };
  }
}

// ----------------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir;
  const lock = args.dryRun ? undefined : lockDir(dir);
  if (!args.dryRun && !lock) {
    warn(`另一个 triage 正在运行（${join(dir, '.triage.lock')}）；本次跳过`);
    return 0;
  }

  try {
    const index = readIndex(dir);
    const evidence = readEvidence(dir);
    const sigs = Object.keys(evidence).sort();
    const pending = [];

    for (const sig of sigs) {
      const entries = evidence[sig].filter(entry => Number(entry.at ?? 0) >= args.since);
      if (!entries.length) continue;
      const latest = Math.max(...entries.map(entry => Number(entry.at ?? 0)));
      const triagedAt = Number(index[sig]?.triagedAt ?? 0);
      if (triagedAt && latest <= triagedAt) continue;
      pending.push({ sig, entries, latest });
    }

    if (!pending.length) {
      console.log(`✓ 没有待处理上报（${sigs.length} 个签名已处理，报告目录 ${dir}）`);
      return 0;
    }

    for (const item of pending) {
      const path = issuePath(args.repo, item.sig);
      const status = existingStatus(path);
      const body = renderIssue({ sig: item.sig, entries: item.entries, status });
      console.log(
        `${args.dryRun ? '· [dry-run] ' : '✓ '}${item.sig} ${item.entries.length} 条证据 ` +
          `(${item.entries[0].tool}/${item.entries[0].class}) → ${path}`
      );
      if (args.dryRun) continue;
      writeIssue(path, body);
      index[item.sig] = { ...(index[item.sig] ?? {}), lastAt: item.latest, triagedAt: item.latest };
    }

    if (!args.dryRun) writeIndex(dir, index);

    if (args.notify) {
      const summary = pending
        .slice(0, 8)
        .map(item => `${item.sig}(${item.entries[0].tool}/${item.entries[0].class}×${item.entries.length})`)
        .join(' ');
      const more = pending.length > 8 ? ` …共 ${pending.length} 个签名` : '';
      const text =
        `[defect] collab 插件缺陷上报待处理 ${pending.length} 条：${summary}${more} ` +
        `→ ${join(args.repo, 'docs', 'issues')}/bugs-collab-<sig>.md`;
      if (args.dryRun) console.log(`· [dry-run] 将通知 ${args.notify}: ${text}`);
      else await notify(args.notify, text);
    }

    console.log(
      `${args.dryRun ? '· [dry-run] ' : '✓ '}${pending.length} 个签名${args.dryRun ? ' 待处理（未写盘）' : ' 已生成/刷新 issue'}`
    );
    return 0;
  } finally {
    unlock(lock);
  }
}

main()
  .then(code => process.exit(code ?? 0))
  .catch(error => fail(error?.stack ?? error));
