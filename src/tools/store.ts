/**
 * `collab_index` (0.9.0, `11-20-collab-store`) — the **only** new tool of this
 * version, and deliberately the only one: storage is infrastructure, not a
 * collaboration action. Four verbs (three original + the 0.9.7 read view):
 *
 *   - `stats`   read-only: what the projection currently holds, or why it is
 *               unusable (`[索引不可用]` on the board).
 *   - `metrics` read-only (0.9.7): the per-day rows of the `metrics` table,
 *               newest first — `stats` says how many days there are, this says
 *               what the numbers are. Same read-only rule as `stats`: no file
 *               is created and nothing is written.
 *   - `rebuild` R3: full rebuild from `collab-messages.jsonl` + `collab-*.json`
 *               into `<dbPath>.tmp` → fsync → atomic rename. Idempotent; the
 *               old database survives a failure.
 *   - `backfill` R6: status-level history of the pre-0.9.0 files (24 hand-offs,
 *               49 threads on the reference host). Bodies were never stored, so
 *               no `messages` row is fabricated — `meta.backfilled=1` says so.
 *
 * `rebuild` / `backfill` write and therefore need `confirm:true` (the same
 * convention as every other writing tool); `stats` / `metrics` never write and
 * never create the database.
 */
import { PACING_COUNTER_KEEP_DAYS, REBUILD_SINCE_DAYS } from '../constants.ts';
import { METRICS_DEFAULT_LIMIT, backfill, indexMetrics, indexStats, rebuild } from '../core/index-db.ts';
import type { MetricsDayRow, RebuildResult } from '../types.ts';
import { invalid } from '../core/errors.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * S8 (review): a `0` on a table no current version writes would read as
 * "nothing there" — label them instead of printing a bare zero.
 *
 * Actual ownership: `facts` is the 0.9.4 workspace ledger, whose truth is
 * `collab-facts.json` (**not projected here in 0.9.4**); `todos` / `progress`
 * mirror the workspace task layer but 0.9.1 keeps the contract as a separate
 * JSON truth; `decisions` arrives in 0.9.5. `metrics` is written from 0.9.6 on
 * (one row per local day, refreshed by the delivery path), so it is a real
 * count now — not an "empty by design" label.
 */
const EMPTY_LABEL: Record<string, string> = { facts: '真源在 collab-facts.json' };
const EMPTY_BY_DESIGN = ['facts', 'todos', 'decisions', 'progress'];
const tableLine = (counts: Record<string, number>, keys: string[]): string =>
  keys
    .map(key =>
      EMPTY_BY_DESIGN.includes(key)
        ? `${key}=0（${EMPTY_LABEL[key] ?? '本版不写入'}）`
        : `${key}=${counts[key] ?? 0}`
    )
    .join('  ');

/** R2 (0.9.7): 「metrics 覆盖 2026-11-20–2026-11-21（2 天）」 or an honest 「无」. */
function metricsCoverageLine(stats: { metricsRange?: { first: string; last: string; days: number } }): string {
  const range = stats.metricsRange;
  if (!range) return 'metrics 覆盖 无';
  return `metrics 覆盖 ${range.first}–${range.last}（${range.days} 天）`;
}

/**
 * 0.9.7 (`11-21-collab-index-metrics`): one day per line so the output drops
 * straight into a before/after table. A stored NULL prints `-` — the view never
 * turns "never written" into a zero (R5).
 *
 * 0.10.x (`11-22-collab-metrics-dual`): the three delivery counts come first
 * (`raw ≥ kept ≥ msg`), then the gate / SLA counters. A row recorded before
 * `raw` / `kept` existed prints `-` for them, exactly like an expired counter.
 *
 * 0.10.0 (`11-23-collab-metrics-attribution`, R2): every line ends with
 * `uncounted N` — the message rows of that day that carry **no** count marker
 * (`rawSeq`, resends `_r<n>` excluded). `N > 0` is flagged on the line itself
 * (`⚠未计数`): the day's `msg` may then exceed `raw` for a reason the numbers
 * alone cannot tell apart (a row written before the marker, or a plugin
 * instance that delivered without counting).
 */
const metricText = (value: number | null): string => (value === null ? '-' : String(value));

function metricsRowLine(row: MetricsDayRow, uncounted: number): string {
  return `${row.day} · raw ${metricText(row.rawCount)} · kept ${metricText(row.keptCount)} · msg ${metricText(row.msgCount)} · noop ${metricText(
    row.noopCount
  )} · late ${metricText(row.lateCount)} · gap ${row.medianGapMs === null ? '-' : `${row.medianGapMs}ms`} · uncounted ${uncounted}${
    uncounted > 0 ? ' ⚠未计数' : ''
  }`;
}

/**
 * The one explanation of `uncounted`, printed only when a shown day has any.
 * It deliberately does **not** guess a version: a row without the marker and a
 * row whose writer skipped the count are indistinguishable from the data (a
 * mixed-version install is the case this exists for).
 */
const UNCOUNTED_NOTE =
  '注: uncounted N = 当日 message 行里没有计数标记（rawSeq）的条数（`_r<n>` 重发不计入）。' +
  '三种来源在数据上无法区分：① 0.10.0 之前写入（当时没有计数机制，行也没被计数）；' +
  '② 0.10.x-rc.2 写入（已计数但尚未写标记 → 假阳性）；③ 本版本某条投递路径漏埋。' +
  '因此 uncounted > 0 只说明「存在未标记行」，不等于「一定漏计」；只有 uncounted = 0 能确定当日全部计入。' +
  '本诊断向前生效，不能追溯历史差异；归因历史差异请按 from 会话的插件版本 + kind 是否直投点核对。';

function renderRebuild(result: RebuildResult, action: 'rebuild' | 'backfill'): string {
  if (!result.ok) {
    return `[索引不可用] ${action} 未完成：${result.reason ?? 'unknown error'}（旧库保留，工具与看板仍可用）`;
  }
  const head =
    action === 'rebuild'
      ? `已重建索引: ${result.dbPath}`
      : `已回填索引: ${result.dbPath}`;
  const lines = [
    head,
    `耗时=${result.ms}ms  跳过坏行=${result.warnCount}`,
    `行数: ${tableLine(result.counts, ['messages', 'threads', 'handoffs', 'locks', 'queue', 'sessions', 'facts', 'todos', 'decisions', 'progress', 'metrics'])}`
  ];
  if (result.checksums) {
    lines.push(
      `checksum: ${Object.entries(result.checksums)
        .map(([table, hash]) => `${table}=${hash}`)
        .join(' ')}`
    );
  }
  lines.push(
    action === 'rebuild'
      ? '注: 幂等 — 同一输入再跑一次，行数与每表 checksum 不变。JSON 仍是唯一真源，删掉这个库不影响协作。'
      : '注: 回填只恢复状态级历史（handoff / thread）；历史正文根本没有存过，不会伪造 messages 行（meta.backfilled=1）。'
  );
  return lines.join('\n');
}

export function indexTool(kit: ToolKit): ToolDefinition {
  const { readConfig, chain } = kit.deps;

  return {
    name: 'collab_index',
    description:
      'Maintain the rebuildable message index (`collab.db`). `stats` is read-only and reports the projection ' +
      '(tables, rows, backend) or why it is unavailable; `metrics` is read-only too and lists the per-day ' +
      '`metrics` rows newest first (day · raw_count · kept_count · msg_count · noop_count · late_count · median_gap_ms · ' +
      'uncounted, `limit` default 30) with the day range they cover (`-` = NULL: the counter is unknown — expired after the 30-day ' +
      'retention, or recorded before raw/kept existed — not zero). `uncounted N` is the count of the message rows ' +
      'of that day with **no count marker** (`rawSeq`, resends `_r<n>` excluded): a row without the marker was never counted ' +
      '(written before the marker existed, or by an instance that missed its count — the two cannot be told apart), ' +
      'and a day with `uncounted > 0` is flagged `⚠未计数` — that is how a `msg > raw` gap is attributed. ' +
      '`rebuild` re-creates it from `collab-messages.jsonl` + ' +
      'the `collab-*.json` files into a temp file, fsyncs and atomically renames (idempotent: the same input ' +
      'gives the same row counts and per-table checksums; a failure keeps the old database). It also recomputes ' +
      'the per-day `metrics` rows from the message log (resends excluded) and the pacing counters, and `stats` ' +
      'reports the day range those rows cover. `backfill` adds the ' +
      'status-level history of the pre-0.9.0 files (hand-offs / threads; bodies were never stored, so no messages ' +
      'rows are invented and `meta.backfilled=1` marks the partial history). The JSON files are the source of ' +
      'truth; deleting `collab.db` never loses a message. `rebuild` / `backfill` write and need `confirm:true`; ' +
      '`stats` and `metrics` never write and never create the database.',
    input: jsonInput({
      properties: {
        action: {
          type: 'string',
          enum: ['rebuild', 'backfill', 'stats', 'metrics'],
          description:
            'rebuild = 全量重建（幂等）· backfill = 回填历史状态 · stats = 只读状态 · metrics = 只读逐日指标'
        },
        limit: {
          type: 'number',
          description: `metrics 输出最近 N 天（默认 ${METRICS_DEFAULT_LIMIT}，按日期倒序）。只读，不影响 rebuild。`
        },
        sinceDays: {
          type: 'number',
          description: `rebuild 的投影只保留最近 N 天（默认 180；0 = 不按时间过滤）。只裁剪投影，JSONL 真源永久保留。`
        },
        confirm: {
          type: 'boolean',
          description: 'rebuild / backfill 必须为 true 才写；false / 省略只预览。stats / metrics 不需要。'
        }
      },
      required: ['action']
    }),
    async execute(input) {
      const action = String(input?.action ?? '').trim();
      const config = readConfig();
      // F1 (review): `sinceDays:0` means "no time filter" and must reach the
      // core — the old `> 0` test silently turned it back into the 180-day
      // default (schema / docs / preview all promised 0 = unlimited).
      const sinceDays = Number(input?.sinceDays);
      const windowed = Number.isFinite(sinceDays) && sinceDays >= 0;
      const days = windowed ? sinceDays : REBUILD_SINCE_DAYS;
      const options = {
        dbPath: config.dbPath,
        storage: config.storage,
        ...(windowed ? { sinceDays } : {})
      };

      if (action === 'stats') {
        const stats = await indexStats(options);
        if (!stats.available) {
          return {
            content: [
              `[索引不可用] ${stats.reason ?? 'unknown'}`,
              `dbPath=${stats.dbPath}  storage=${config.storage}`,
              '工具与看板仍可用（纯 JSON 读路径）。建立索引：collab_index { action:"rebuild", confirm:true }'
            ].join('\n')
          };
        }
        return {
          content: [
            `索引可用: ${stats.dbPath}  backend=${stats.backend ?? '?'}  size=${stats.bytes ?? 0}B`,
            `行数: ${tableLine(stats.counts, ['messages', 'threads', 'handoffs', 'locks', 'queue', 'sessions', 'facts', 'todos', 'decisions', 'progress', 'metrics'])}`,
            metricsCoverageLine(stats),
            `backfilled=${stats.backfilled}${stats.rebuiltAt ? `  rebuilt_at=${new Date(stats.rebuiltAt).toISOString()}` : ''}`,
            // F3 (0.10.x): pacing counters are pruned after 30 days while rebuild
            // covers 180 — a missing count is NULL (unknown), never 0.
            // 0.10.x: `raw` / `kept` follow the same rule (and are absent on
            // rows written before the counters existed).
            '注: metrics 的 raw/kept 与 noop/late 同为 NULL = 该日 pacing 计数已过期/缺失（不是 0；raw/kept 不追溯回填）。',
            '只读：stats 不建库、不写入（没有索引时看板显示 [索引不可用]）。'
          ].join('\n')
        };
      }

      if (action === 'metrics') {
        const requested = Number(input?.limit);
        const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : METRICS_DEFAULT_LIMIT;
        const listing = await indexMetrics({ ...options, limit });
        if (!listing.available) {
          return {
            content: [
              `[索引不可用] ${listing.reason ?? 'unknown'}`,
              `dbPath=${listing.dbPath}  storage=${config.storage}`,
              '未建库时 metrics 不会创建任何文件（只读）。建立索引：collab_index { action:"rebuild", confirm:true }'
            ].join('\n')
          };
        }
        if (!listing.rows.length) {
          return {
            content: [
              'metrics 无数据',
              `dbPath=${listing.dbPath}  backend=${listing.backend ?? '?'}`,
              '只读：metrics 不建库、不写入、不触发 rebuild。'
            ].join('\n')
          };
        }
        // 0.10.0 (R2/R3): `uncounted` comes with the rows — same projection, so
        // the flag and `msg_count` describe the same population; a row without
        // the marker is never back-filled.
        const uncounted = listing.uncounted ?? {};
        const lines = [
          `metrics 逐日: ${listing.dbPath}  backend=${listing.backend ?? '?'}`,
          ...listing.rows.map(row => metricsRowLine(row, uncounted[row.day] ?? 0))
        ];
        const range = listing.range;
        const coverage = range ? `覆盖 ${range.first}–${range.last}（${range.days} 天）` : '覆盖 无';
        // The range is the whole table; say so when `limit` hid older days.
        lines.push(
          range && listing.rows.length < range.days
            ? `${coverage} · 仅显示最近 ${listing.rows.length} 天（limit）`
            : coverage
        );
        // F3 (0.10.x): a `-` is not a zero — say what it means where it shows.
        if (listing.rows.some(row => row.noopCount === null || row.lateCount === null || row.rawCount === null || row.keptCount === null)) {
          lines.push(
            `注: \`-\` = 该日计数已过期/缺失（NULL，不是 0；counters 只保留 ${PACING_COUNTER_KEEP_DAYS} 天，raw/kept 不追溯回填）。`
          );
        }
        // 0.10.0 (R2): only explain a flag that is actually on screen.
        if (listing.rows.some(row => (uncounted[row.day] ?? 0) > 0)) lines.push(UNCOUNTED_NOTE);
        lines.push('只读：metrics 不建库、不写入、不触发 rebuild。');
        return { content: lines.join('\n') };
      }

      if (action !== 'rebuild' && action !== 'backfill') {
        throw invalid('action 必须是 rebuild | backfill | stats | metrics');
      }
      if (config.storage === 'json') {
        return {
          content:
            '[索引不可用] 当前 storage:"json"（collab.json）—— 纯 JSON 模式，不建立索引，也不会 import sqlite。' +
            '要重建索引：把 collab.json 的 storage 改回 "sqlite" 再试。'
        };
      }
      if (input?.confirm !== true) {
        return {
          content: [
            `未执行（confirm 不为 true，仅预览）。将${action === 'rebuild' ? '全量重建' : '回填'}索引:`,
            `dbPath=${config.dbPath}`,
            action === 'rebuild'
              ? days === 0
                ? '来源: collab-messages.jsonl + collab-*.json（sinceDays:0 → 不按时间过滤，全量重建）'
                : `来源: collab-messages.jsonl + collab-*.json（保留最近 ${days} 天；JSONL 永久保留，之后可用 sinceDays:0 重建全量）`
              : '来源: collab-broadcast/*.json + collab-threads.json（只补状态级历史，不伪造正文）',
            '确认后在同样参数下传 confirm:true。'
          ].join('\n')
        };
      }

      // R5: the `sessions` table is filled from the host's page (bounded, and a
      // host without `session.list` simply leaves it empty — never a failure).
      let sessions;
      try {
        sessions = await chain.listSessions({ limit: 100 });
      } catch {
        sessions = undefined;
      }
      const withSessions = sessions ? { ...options, sessions } : options;
      const result = action === 'rebuild' ? await rebuild(withSessions) : await backfill(withSessions);
      return { content: renderRebuild(result, action) };
    }
  };
}
