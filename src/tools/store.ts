/**
 * `collab_index` (0.9.0, `11-20-collab-store`) — the **only** new tool of this
 * version, and deliberately the only one: storage is infrastructure, not a
 * collaboration action. Three verbs:
 *
 *   - `stats`   read-only: what the projection currently holds, or why it is
 *               unusable (`[索引不可用]` on the board).
 *   - `rebuild` R3: full rebuild from `collab-messages.jsonl` + `collab-*.json`
 *               into `<dbPath>.tmp` → fsync → atomic rename. Idempotent; the
 *               old database survives a failure.
 *   - `backfill` R6: status-level history of the pre-0.9.0 files (24 hand-offs,
 *               49 threads on the reference host). Bodies were never stored, so
 *               no `messages` row is fabricated — `meta.backfilled=1` says so.
 *
 * `rebuild` / `backfill` write and therefore need `confirm:true` (the same
 * convention as every other writing tool); `stats` never writes.
 */
import { REBUILD_SINCE_DAYS } from '../constants.ts';
import { backfill, indexStats, rebuild } from '../core/index-db.ts';
import type { RebuildResult } from '../types.ts';
import { invalid } from '../core/errors.ts';
import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * S8 (review): a `0` on a table no current version writes would read as
 * "nothing there" — label them instead of printing a bare zero.
 *
 * Actual ownership: `todos` / `progress` mirror the workspace task layer in
 * 0.9.3, `facts` in 0.9.4, `decisions` in 0.9.5, `metrics` in 0.9.6. **0.9.1
 * does not project the contract** (`collab-contract/<sid>.json` stays a separate
 * JSON truth; todos/progress there are not `collab.db` rows).
 */
const EMPTY_BY_DESIGN = ['facts', 'todos', 'decisions', 'progress', 'metrics'];
const tableLine = (counts: Record<string, number>, keys: string[]): string =>
  keys
    .map(key =>
      EMPTY_BY_DESIGN.includes(key)
        ? `${key}=0（本版不写入）`
        : `${key}=${counts[key] ?? 0}`
    )
    .join('  ');

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
      '(tables, rows, backend) or why it is unavailable. `rebuild` re-creates it from `collab-messages.jsonl` + ' +
      'the `collab-*.json` files into a temp file, fsyncs and atomically renames (idempotent: the same input ' +
      'gives the same row counts and per-table checksums; a failure keeps the old database). `backfill` adds the ' +
      'status-level history of the pre-0.9.0 files (hand-offs / threads; bodies were never stored, so no messages ' +
      'rows are invented and `meta.backfilled=1` marks the partial history). The JSON files are the source of ' +
      'truth; deleting `collab.db` never loses a message. `rebuild` / `backfill` write and need `confirm:true`; ' +
      '`stats` never writes.',
    input: jsonInput({
      properties: {
        action: {
          type: 'string',
          enum: ['rebuild', 'backfill', 'stats'],
          description: 'rebuild = 全量重建（幂等）· backfill = 回填历史状态 · stats = 只读状态'
        },
        sinceDays: {
          type: 'number',
          description: `rebuild 只保留最近 N 天（默认 180；0 表示不按时间过滤）。`
        },
        confirm: {
          type: 'boolean',
          description: 'rebuild / backfill 必须为 true 才写；false / 省略只预览。stats 不需要。'
        }
      },
      required: ['action']
    }),
    async execute(input) {
      const action = String(input?.action ?? '').trim();
      const config = readConfig();
      const sinceDays = Number(input?.sinceDays);
      const options = {
        dbPath: config.dbPath,
        storage: config.storage,
        ...(Number.isFinite(sinceDays) && sinceDays > 0 ? { sinceDays } : {})
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
            `backfilled=${stats.backfilled}${stats.rebuiltAt ? `  rebuilt_at=${new Date(stats.rebuiltAt).toISOString()}` : ''}`,
            '只读：stats 不建库、不写入（没有索引时看板显示 [索引不可用]）。'
          ].join('\n')
        };
      }

      if (action !== 'rebuild' && action !== 'backfill') {
        throw invalid('action 必须是 rebuild | backfill | stats');
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
              ? `来源: collab-messages.jsonl + collab-*.json（保留最近 ${Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : REBUILD_SINCE_DAYS} 天）`
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
