/**
 * Defect self-reporting (PRD R1–R7).
 *
 * The primary channel is a **delivery**: a `note` (queue) to `report.to`, so the
 * maintainer session is woken even when it is idle. The files under
 * `~/.config/opencode/collab-reports/` are evidence + fallback: they are what
 * `scripts/collab-triage.mjs` and a human read when the delivery could not
 * happen (maintainer offline, target protected, plugin not loaded there yet).
 *
 * Invariants this module must never break:
 *   - reporting is a **side path**: it never changes a tool's return value and
 *     never replaces/re-wraps the thrown error (only appends the R8 hint);
 *   - a failure inside reporting (disk full, bad config, refused prompt) is
 *     swallowed and logged — the caller still sees its own error;
 *   - the evidence is a **whitelist** of fields, never the message body, file
 *     content, tokens or the participant list (R2/R7).
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigReader } from '../config.ts';
import {
  PLUGIN_VERSION,
  REPORT_DIR,
  REPORT_INDEX_FILE,
  REPORT_MESSAGE_LIMIT,
  REPORT_STACK_FRAMES,
  REPORT_THROTTLE_MS
} from '../constants.ts';
import type { CollabContext, JsonObject, ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { envelope } from '../ids.ts';
import { errText, log } from '../log.ts';
import { asObject, hash16, randToken, readJsonFile, shortID } from '../util.ts';
import { isValidBid, readBroadcast } from './claim.ts';
import { classify, metaOf } from './errors.ts';
import type { DefectClass } from './errors.ts';
import { createLineage } from './lineage.ts';
import { recordMessage } from './index-db.ts';
import { makeEnvelope } from './envelope.ts';

export const REPORT_FROM = 'collab-report';

/** `{ [signature]: { lastAt, triagedAt } }` — `triagedAt` is written by triage. */
export interface ReportIndexEntry {
  lastAt?: number;
  triagedAt?: number;
  count?: number;
  tool?: string;
  class?: string;
}

export interface ReportEvidence {
  signature: string;
  version: string;
  tool: string;
  class: DefectClass;
  error: { name: string; message: string; stackTop: string[] };
  context: { bid?: string; thread?: string; from?: string; claimBy?: string; target?: string };
  workspace?: string;
  record?: { state?: string; attempts?: number; receiptMode?: string; claimKind?: string };
  at: number;
  [key: string]: unknown;
}

export interface ReportOutcome {
  signature: string;
  /** `undefined` when the 1h throttle swallowed this occurrence. */
  files?: { json: string; md: string };
  delivered: boolean;
  reason: string;
}

function dir(): string {
  return REPORT_DIR;
}

/** The evidence directory (also printed by `collab_list`, hint lines and setup). */
export function reportDir(): string {
  return dir();
}

/** R8: the one-line entry point every error / listing / log carries. */
export function reportHint(): string {
  return `提示: 若怀疑是插件缺陷，运行 collab_report { confirm:true } 上报现场（或看 ${dir()}）`;
}

export function indexFile(): string {
  return join(dir(), REPORT_INDEX_FILE);
}

function normalizeMessage(message: string): string {
  return String(message ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    // Volatile parts must not split one defect into many signatures:
    // ids, absolute paths, and "HTTP 500"/latency-style numbers stay.
    .replace(/\bses_[A-Za-z0-9]+/g, 'ses_…')
    .replace(/\bb_[0-9a-f]{8,32}\b/g, 'b_…')
    .replace(/\bt_[0-9a-z_]+/g, 't_…')
    .replace(/(?<![\w.])[-/][\w./@-]{2,}(?::\d+){0,2}/g, '…')
    .slice(0, 512);
}

/** R4: `hash(version + tool + errorName + normalized message)`. */
export function signature(version: string, tool: string, errorName: string, message: string): string {
  return `d_${hash16([version, tool, errorName, normalizeMessage(message)].join('\u0000'))}`;
}

/** Secrets that must never appear in the evidence (R2/R7). */
function secretsOf(input: JsonObject | undefined): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    const text = typeof value === 'string' ? value.trim() : '';
    // Short values would redact unrelated text; the body of a call is always
    // long enough to be worth a redaction pass.
    if (text.length >= 8) out.push(text, text.slice(0, 64));
  };
  // `note` is deliberately NOT a secret: on the manual path it *is* the summary
  // kept in the evidence (2KB cut, token-shaped runs still redacted below).
  push(input?.text);
  push(input?.token);
  push(process.env.COLLAB_SERVER_TOKEN);
  return [...new Set(out)].filter(Boolean);
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  // Anything token-shaped left over: a long run of id-ish characters that
  // contains both letters and digits (`SECRET_TOKEN_9f8e…`). Plain words such as
  // `GuardConflictError` have no digit and are kept readable.
  return out.replace(/\b[A-Za-z0-9_-]{20,}\b/g, match =>
    /\d/.test(match) && /[A-Za-z]/.test(match) ? '[redacted]' : match
  );
}

function stackTop(error: unknown, secrets: string[]): string[] {
  const stack = String((error as { stack?: unknown })?.stack ?? '');
  if (!stack) return [];
  return stack
    .split('\n')
    .slice(1, 1 + REPORT_STACK_FRAMES)
    .map(line => redact(line.trim(), secrets).slice(0, 300))
    .filter(Boolean);
}

function pickBid(input: JsonObject | undefined, error: unknown): string | undefined {
  const explicit = String(input?.bid ?? '').trim();
  if (isValidBid(explicit)) return explicit;
  const fromText = /\b(b_[0-9a-f]{8,32})\b/.exec(String(input?.text ?? ''))?.[1];
  if (isValidBid(fromText)) return fromText;
  const fromMessage = /\b(b_[0-9a-f]{8,32})\b/.exec(String((error as { message?: unknown })?.message ?? ''))?.[1];
  return isValidBid(fromMessage) ? fromMessage : undefined;
}

function pickThread(input: JsonObject | undefined, error: unknown): string | undefined {
  const explicit = String(input?.threadID ?? '').trim();
  if (/^t_[0-9a-z_]+$/.test(explicit)) return explicit;
  return /\b(t_[0-9a-z]{4,})\b/.exec(String((error as { message?: unknown })?.message ?? ''))?.[1];
}

export interface EvidenceInput {
  tool: string;
  defect: DefectClass;
  error: unknown;
  input?: JsonObject;
  sessionID?: string;
  workspace?: string;
  at?: number;
}

/** R2: field whitelist + truncation. No body, no tokens, no file content. */
export function buildEvidence({
  tool,
  defect,
  error,
  input,
  sessionID,
  workspace,
  at = Date.now()
}: EvidenceInput): ReportEvidence {
  const secrets = secretsOf(input);
  const message = redact(String((error as { message?: unknown })?.message ?? error ?? ''), secrets).slice(
    0,
    REPORT_MESSAGE_LIMIT
  );
  const name = String((error as { name?: unknown })?.name ?? typeof error);
  const bid = pickBid(input, error);
  const record = bid ? readBroadcast(bid) : undefined;
  const evidence: ReportEvidence = {
    signature: signature(PLUGIN_VERSION, tool, name, message),
    version: PLUGIN_VERSION,
    tool,
    class: defect,
    error: { name, message, stackTop: stackTop(error, secrets) },
    context: {
      ...(bid ? { bid } : {}),
      ...(pickThread(input, error) ? { thread: pickThread(input, error) } : {}),
      ...(sessionID ? { from: shortID(sessionID) } : {}),
      ...(record?.claim?.by ? { claimBy: shortID(record.claim.by) } : {}),
      ...(input?.target ? { target: shortID(String(input.target).startsWith('ses_') ? String(input.target) : 'alias') } : {})
    },
    ...(workspace ? { workspace } : {}),
    ...(record
      ? {
          record: {
            state: String(record.state ?? ''),
            attempts: Number(record.attempts ?? 0),
            receiptMode: String(record.receiptMode ?? 'push'),
            claimKind: record.claim?.kind ? String(record.claim.kind) : undefined
          }
        }
      : {}),
    at
  };
  const meta = metaOf(error);
  if (meta && Object.keys(meta).length) evidence.meta = meta;
  return evidence;
}

/** Issue draft — readable on its own, copy-pasteable as `docs/issues/bugs-*.md`. */
export function renderMarkdown(evidence: ReportEvidence): string {
  const at = new Date(evidence.at).toISOString();
  const ctx = Object.entries(evidence.context)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const record = evidence.record
    ? `state=${evidence.record.state} attempts=${evidence.record.attempts} receiptMode=${evidence.record.receiptMode}` +
      (evidence.record.claimKind ? ` claimKind=${evidence.record.claimKind}` : '')
    : '(no hand-off record in the call)';
  return [
    `# 插件缺陷：${evidence.tool} / ${evidence.class}（${evidence.signature}）`,
    '',
    '> 自动生成（插件自身缺陷上报）。证据目录与索引由 `scripts/collab-triage.mjs` 消费。',
    '',
    `- 版本: ${evidence.version}`,
    `- 工具: ${evidence.tool}`,
    `- 分类: ${evidence.class}`,
    `- 时间: ${at}`,
    `- 工作区: ${evidence.workspace ?? '(unknown)'}`,
    `- 上下文: ${ctx || '-'}`,
    `- 记录: ${record}`,
    '',
    '## 现象',
    '',
    '```',
    `${evidence.error.name}: ${evidence.error.message}`,
    '```',
    '',
    '## 复现（由调用方现场还原）',
    '',
    `1. 会话 \`${evidence.context.from ?? 'ses_…'}\` 调用 \`${evidence.tool}\``,
    '2. 参数只保留非敏感标量（正文/文件内容已脱敏，见下）',
    '',
    '## 证据（白名单字段，已脱敏）',
    '',
    '```json',
    JSON.stringify(
      {
        signature: evidence.signature,
        version: evidence.version,
        tool: evidence.tool,
        class: evidence.class,
        context: evidence.context,
        record: evidence.record,
        workspace: evidence.workspace,
        stackTop: evidence.error.stackTop
      },
      null,
      2
    ),
    '```',
    '',
    '## 影响面',
    '',
    '- 该错误对本次调用是失败（调用方拿到异常），不确定是否可自愈',
    '- 同一签名 1 小时内不再重复落盘（限流），因此 `次数` 不等于真实发生次数',
    '',
    '## 修复后',
    '',
    `- 在 CHANGELOG 写明修复，并删除/关闭对应 issue（triage 之后不再重复生成）`
  ].join('\n');
}

function atomicWrite(path: string, body: string): void {
  const tmp = `${path}.${randToken()}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

/** `{sig: entry}`; tolerates the legacy `{sig: number}` shape. */
export function readReportIndex(directory = dir()): Record<string, ReportIndexEntry> {
  const raw = asObject(readJsonFile(join(directory, REPORT_INDEX_FILE)));
  const out: Record<string, ReportIndexEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('d_')) continue;
    if (typeof value === 'number') out[key] = { lastAt: value };
    else if (value && typeof value === 'object') out[key] = asObject(value) as ReportIndexEntry;
  }
  return out;
}

function writeIndexEntry(sig: string, patch: ReportIndexEntry, directory = dir()): void {
  const index = readReportIndex(directory);
  index[sig] = { ...index[sig], ...patch };
  mkdirSync(directory, { recursive: true });
  atomicWrite(join(directory, REPORT_INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
}

/** R4: true when no report for this signature was written in the last hour. */
export function shouldReport(sig: string, now = Date.now(), directory = dir()): boolean {
  const last = Number(readReportIndex(directory)[sig]?.lastAt ?? 0);
  return !last || now - last >= REPORT_THROTTLE_MS;
}

/** R6/R9: `{sig: latestEvidenceAt}` for every directory on disk. */
export function scanReports(directory = dir()): Record<string, number> {
  const out: Record<string, number> = {};
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.startsWith('d_')) continue;
    const full = join(directory, name);
    let latest = 0;
    try {
      if (!statSync(full).isDirectory()) continue;
      for (const file of readdirSync(full)) {
        if (!file.endsWith('.json')) continue;
        const stamp = Number(file.slice(0, -5));
        if (Number.isFinite(stamp) && stamp > latest) latest = stamp;
      }
    } catch {
      continue;
    }
    out[name] = latest;
  }
  return out;
}

/**
 * R9.2: one passive "未处理上报 N 条" line per session (and again only when the
 * count grows, so a backlog is not re-shown every turn).
 */
export async function takePendingNotice(
  ctx: CollabContext,
  sessionID: string | undefined,
  count: number
): Promise<boolean> {
  if (!sessionID || count <= 0) return false;
  const key = `collab/report-notice/${sessionID}`;
  try {
    const raw = asObject(await ctx.storage.get(key));
    if (Number(raw.shown ?? 0) >= count) return false;
    await ctx.storage.set(key, { shown: count, at: Date.now() });
    return true;
  } catch (error) {
    log(`report notice failed: ${errText(error)}`);
    return false;
  }
}

export function reportNoticeLine(count: number): string {
  return (
    `未处理缺陷上报 ${count} 条：node scripts/collab-triage.mjs --dry-run 先看，` +
    '确认后去掉 --dry-run 生成 docs/issues/bugs-collab-<sig>.md'
  );
}

/** R9.2: signatures with evidence newer than their last triage run. */
export function pendingReports(directory = dir()): { count: number; sigs: string[] } {
  const index = readReportIndex(directory);
  const files = scanReports(directory);
  const sigs = [...new Set([...Object.keys(files), ...Object.keys(index)])]
    .filter(sig => {
      const latest = Math.max(Number(files[sig] ?? 0), Number(index[sig]?.lastAt ?? 0));
      const triaged = Number(index[sig]?.triagedAt ?? 0);
      return latest > 0 && latest > triaged;
    })
    .sort();
  return { count: sigs.length, sigs };
}

interface PersistInput extends EvidenceInput {
  evidence: ReportEvidence;
}

function persist({ evidence }: PersistInput): { json: string; md: string } {
  const directory = join(dir(), evidence.signature);
  mkdirSync(directory, { recursive: true });
  const base = join(directory, `${evidence.at}`);
  const json = `${base}.json`;
  const md = `${base}.md`;
  atomicWrite(json, `${JSON.stringify(evidence, null, 2)}\n`);
  atomicWrite(md, `${renderMarkdown(evidence)}\n`);
  return { json, md };
}

export interface Reporter {
  dir: string;
  hint(): string;
  /** Wrap one tool's `execute`: report a classified defect, then re-throw. */
  wrap(tool: string, execute: ToolDefinition['execute']): ToolDefinition['execute'];
  /** `collab_report {note, confirm}` — a hand-made report from the caller's seat. */
  manual(
    input: { note?: unknown; bid?: unknown; threadID?: unknown; confirm?: unknown },
    context?: { sessionID?: string }
  ): Promise<ToolResult>;
  /** Report from a code path that is not a tool throw (e.g. a silent delivery failure). */
  reportNow(input: Omit<EvidenceInput, 'at'>): Promise<ReportOutcome | undefined>;
  /** Count of signatures not yet triaged (R9.2). */
  pending(): { count: number; sigs: string[] };
}

export interface ReporterDeps {
  ctx: CollabContext;
  readConfig: ConfigReader;
}

export function createReporter({ ctx, readConfig }: ReporterDeps): Reporter {
  async function maintainerTarget(): Promise<{ sid?: string; reason: string }> {
    const config = readConfig();
    const to = String(config.report?.to ?? '').trim();
    if (!to) return { reason: '未配置 report.to（只落盘）' };
    if (config.report?.enabled === false) return { reason: 'report.enabled=false（只落盘）' };
    if (to.startsWith('ses_')) return { sid: to, reason: 'ok' };
    const sid = String(config.aliases?.[to] ?? '').trim();
    return sid ? { sid, reason: 'ok' } : { reason: `report.to "${to}" 不是 ses_… 且不在别名表（只落盘）` };
  }

  /** R5: one `note` (queue) to the maintainer. Best effort, never throws. */
  async function deliver(
    evidence: ReportEvidence,
    files: { json: string; md: string },
    reporterSessionID?: string
  ): Promise<ReportOutcome> {
    const target = await maintainerTarget();
    if (!target.sid) return { signature: evidence.signature, files, delivered: false, reason: target.reason };
    const sid = target.sid;
    try {
      const guard = await createLineage(ctx).protectedAncestor(sid, readConfig().protect);
      if (guard) {
        return { signature: evidence.signature, files, delivered: false, reason: '目标在 protect 名单内（只落盘）' };
      }
      const body =
        `[defect] ${evidence.signature} ${evidence.tool}/${evidence.class}: ` +
        `${evidence.error.message.split('\n')[0].slice(0, 160)} → ${files.md}`;
      const cid = `c_${evidence.signature.slice(2, 10)}_${randToken()}`;
      await ctx.session.prompt({
        sessionID: sid,
        text: envelope({ from: REPORT_FROM, kind: 'note', body }),
        delivery: 'queue',
        metadata: {
          collab: {
            from: REPORT_FROM,
            // The evidence keeps the short id (R2); the delivery carries the
            // full `ses_…` so the maintainer can reply with it directly.
            fromSessionID: reporterSessionID ?? evidence.context.from,
            cid,
            kind: 'note',
            ts: evidence.at
          }
        }
      });
      // 0.9.0 (R1): the defect note is a delivered message (`kind:"note"`); the
      // evidence file stays the primary artefact, this is only the history.
      await recordMessage(
        makeEnvelope({ id: `msg_${cid}`, from: REPORT_FROM, to: sid, sentAt: evidence.at, kind: 'note', body })
      );
      return { signature: evidence.signature, files, delivered: true, reason: 'note 已投递' };
    } catch (error) {
      log(`report delivery failed (${sid}): ${errText(error)}`);
      return { signature: evidence.signature, files, delivered: false, reason: `投递失败：${errText(error)}` };
    }
  }

  async function report(input: EvidenceInput): Promise<ReportOutcome | undefined> {
    try {
      const evidence = buildEvidence(input);
      if (!shouldReport(evidence.signature, evidence.at)) {
        return { signature: evidence.signature, delivered: false, reason: '同签名 1 小时内已上报（限流）' };
      }
      const files = persist({ ...input, evidence });
      writeIndexEntry(evidence.signature, {
        lastAt: evidence.at,
        count: Number(readReportIndex()[evidence.signature]?.count ?? 0) + 1,
        tool: evidence.tool,
        class: evidence.class
      });
      log(`defect report ${evidence.signature} (${evidence.tool}/${evidence.class}) → ${files.md}`);
      return await deliver(evidence, files, input.sessionID);
    } catch (error) {
      // R7: reporting must never break the tool call it is attached to.
      log(`defect report failed: ${errText(error)}`);
      return undefined;
    }
  }

  /** R8①: only a *defect* error gets the hint; a validation error stays clean. */
  function annotate(error: unknown): unknown {
    const hint = reportHint();
    if (error instanceof Error) {
      const message = String(error.message ?? '');
      if (!message.includes('collab_report')) {
        try {
          error.message = `${message}\n${hint}`;
        } catch {
          return new Error(`${message}\n${hint}`, { cause: error });
        }
      }
      return error;
    }
    return new Error(`${String(error)}\n${hint}`);
  }

  return {
    dir: dir(),
    hint: reportHint,
    wrap(tool, execute) {
      return async (input: unknown, context: ToolContext) => {
        try {
          return await execute(input, context);
        } catch (error) {
          const defect = classify(error);
          if (!defect) throw error; // expected outcome: unchanged
          await report({
            tool,
            defect,
            error,
            input: input as JsonObject | undefined,
            sessionID: context?.sessionID ? String(context.sessionID) : undefined,
            workspace: ctx?.location?.directory
          });
          throw annotate(error);
        }
      };
    },
    async manual(input, context) {
      // `note` is optional on purpose: the R8 hint tells a caller that just hit
      // an error to run `collab_report { confirm:true }`, and that call has to
      // work as-is. Without a note the signature falls back to the session, so
      // two sessions reporting "no note" are two reports, not one.
      const sessionID = context?.sessionID ? String(context.sessionID) : undefined;
      const note =
        String(input?.note ?? '')
          .trim()
          .slice(0, REPORT_MESSAGE_LIMIT) ||
        `手工上报（未填写 note；会话 ${sessionID ? shortID(sessionID) : 'unknown'}）`;
      const bid = String(input?.bid ?? '').trim();
      const synthetic = new Error(note);
      synthetic.name = 'ManualReport';
      const fake: EvidenceInput = {
        tool: 'collab_report',
        defect: 'manual',
        error: synthetic,
        input: { note, ...(bid ? { bid } : {}), ...(input?.threadID ? { threadID: input.threadID } : {}) },
        sessionID,
        workspace: ctx?.location?.directory
      };
      const evidence = buildEvidence(fake);
      if (input?.confirm !== true) {
        return {
          content: [
            '未上报（confirm 不为 true，仅预览）。确认后传 confirm:true。',
            `签名: ${evidence.signature}`,
            `分类: manual  工具: collab_report  版本: ${evidence.version}`,
            `工作区: ${evidence.workspace ?? '(unknown)'}`,
            `证据目录: ${dir()}`,
            `摘要: ${evidence.error.message.slice(0, 200)}`,
            '注: 正文不会写入证据（只保留上面这条摘要，2KB 截断）。'
          ].join('\n')
        };
      }
      const outcome = await report(fake);
      if (!outcome) {
        return { content: `上报失败（已记录日志，不影响调用）。证据目录: ${dir()}` };
      }
      return {
        content: [
          outcome.files
            ? `已上报 ${outcome.signature}`
            : `未新增文件：${outcome.reason}（签名 ${outcome.signature}）`,
          outcome.files ? `证据: ${outcome.files.json}` : `已有证据目录: ${join(dir(), outcome.signature)}`,
          outcome.files ? `草稿: ${outcome.files.md}` : '',
          outcome.delivered ? `已通知维护方（report.to）` : `未投递维护方：${outcome.reason}`,
          `查看未处理: node scripts/collab-triage.mjs --dry-run`
        ]
          .filter(Boolean)
          .join('\n')
      };
    },
    reportNow(input) {
      return report({ ...input, workspace: input.workspace ?? ctx?.location?.directory });
    },
    pending() {
      return pendingReports();
    }
  };
}
