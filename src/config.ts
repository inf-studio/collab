import {
  ARCHIVE_GRACE_MAX_MS,
  ARCHIVE_GRACE_MIN_MS,
  ARCHIVE_GRACE_MS,
  BUILTIN_PROTECT,
  CONFIG_PATH,
  DEFAULTS,
  DEDUPE_WINDOW_MAX_MS,
  DEFAULT_READONLY_AGENTS,
  LEGACY_ALIAS_PATH,
  LOCK_WAITER_TTL_MAX_MS,
  LOCK_WAITER_TTL_MIN_MS
} from './constants.ts';
import { homedir } from 'node:os';
import type { CollabConfig } from './types.ts';
import { asObject, clamp, dedupe, mtime, readJsonFile } from './util.ts';

/** Read `collab.json` + `collab-aliases.json` + `ctx.options` into one value. */
export function loadConfig(options: unknown): CollabConfig {
  const fromOptions = asObject(options);
  const file = asObject(readJsonFile(CONFIG_PATH));
  const legacyAliases = asObject(readJsonFile(LEGACY_ALIAS_PATH));

  // Priority (low → high): built-in defaults < ctx.options < CLI alias file < collab.json
  const aliases: Record<string, string> = {
    ...asObject(DEFAULTS.aliases),
    ...asObject(fromOptions.aliases),
    ...legacyAliases,
    ...asObject(file.aliases)
  };

  const autoDeliver =
    typeof file.autoDeliver === 'boolean'
      ? file.autoDeliver
      : typeof fromOptions.autoDeliver === 'boolean'
        ? fromOptions.autoDeliver
        : DEFAULTS.autoDeliver;

  const maxInject = clamp(file.maxInject ?? fromOptions.maxInject ?? DEFAULTS.maxInject, 1, 10);

  // R8: writing to another session (permission patch / agent switch) is opt-in.
  // Default `false` keeps a freshly installed package read-only.
  const allowWrite =
    typeof file.allowWrite === 'boolean'
      ? file.allowWrite
      : typeof fromOptions.allowWrite === 'boolean'
        ? fromOptions.allowWrite
        : DEFAULTS.allowWrite;

  // `protect` is additive: the built-in hard list can never be removed by config.
  const protect = dedupe([
    ...BUILTIN_PROTECT,
    ...(Array.isArray(fromOptions.protect) ? fromOptions.protect : []),
    ...(Array.isArray(file.protect) ? file.protect : [])
  ]);

  // Read-only agents are additive too: the built-in pair can never be removed,
  // so a config edit cannot accidentally allow `steer` into `explore`/`plan`.
  const readonlyAgents = dedupe([
    ...DEFAULT_READONLY_AGENTS,
    ...(Array.isArray(fromOptions.readonlyAgents) ? fromOptions.readonlyAgents : []),
    ...(Array.isArray(file.readonlyAgents) ? file.readonlyAgents : [])
  ]);

  // R5 (defect self-reporting): `report.to` is the maintainer session — an alias
  // or a `ses_…` id. Absent = evidence files only, no delivery. `report.enabled:false`
  // keeps writing evidence but turns the delivery off (rollback switch, design §6).
  const reportFile = asObject(file.report);
  const reportOptions = asObject(fromOptions.report);
  const reportTo = String(reportFile.to ?? reportOptions.to ?? '').trim();
  const reportEnabled =
    typeof reportFile.enabled === 'boolean'
      ? reportFile.enabled
      : typeof reportOptions.enabled === 'boolean'
        ? reportOptions.enabled
        : undefined;

  // 0.5.0: auto-archive of spawned sessions. `archiveSpawned:false` is the
  // rollback switch (the manual `collab_archive` tool keeps working);
  // `archiveGraceMs` is clamped so a typo cannot archive a session still in use.
  const archiveSpawned =
    typeof file.archiveSpawned === 'boolean'
      ? file.archiveSpawned
      : typeof fromOptions.archiveSpawned === 'boolean'
        ? fromOptions.archiveSpawned
        : DEFAULTS.archiveSpawned;
  const archiveGraceMs = clamp(
    file.archiveGraceMs ?? fromOptions.archiveGraceMs ?? ARCHIVE_GRACE_MS,
    ARCHIVE_GRACE_MIN_MS,
    ARCHIVE_GRACE_MAX_MS
  );

  // 0.6.0 (R1): the waiter heartbeat TTL. Clamped so a typo (`600` = 0.6s, or a
  // week) cannot either reap a working queue or keep a dead waiter forever.
  // A misspelled value (`"10m"`, `"60000"`) falls back to the default: `clamp()`
  // would turn NaN into the *minimum* (1 minute), silently reaping live queues.
  const rawWaiterTtl = file.waiterTtlMs ?? fromOptions.waiterTtlMs;
  const waiterTtlMs =
    typeof rawWaiterTtl === 'number' && Number.isFinite(rawWaiterTtl) && rawWaiterTtl > 0
      ? clamp(rawWaiterTtl, LOCK_WAITER_TTL_MIN_MS, LOCK_WAITER_TTL_MAX_MS)
      : DEFAULTS.waiterTtlMs;
  // R2: the `context`-hook half of the heartbeat is a rollback switch, not a
  // number — the tool-call half always runs (it is a write path by definition).
  const waiterHeartbeat =
    typeof file.waiterHeartbeat === 'boolean'
      ? file.waiterHeartbeat
      : typeof fromOptions.waiterHeartbeat === 'boolean'
        ? fromOptions.waiterHeartbeat
        : DEFAULTS.waiterHeartbeat;
  // R5: `0` disables content de-duplication; anything else is a window in ms.
  const dedupeWindowMs = clamp(
    file.dedupeWindowMs ?? fromOptions.dedupeWindowMs ?? DEFAULTS.dedupeWindowMs,
    0,
    DEDUPE_WINDOW_MAX_MS
  );

  // 0.7.0 (R5): the awareness hint is on by default (`line`); only the exact
  // string `off` turns it off. A typo falls back to the default instead of
  // silently disabling a feature the operator did not ask to lose.
  const rawAwareness = file.awareness ?? fromOptions.awareness;
  const awareness: 'line' | 'off' = rawAwareness === 'off' ? 'off' : DEFAULTS.awareness;

  // 0.8.0 (`board2-actions`): the action row is on by default; only an explicit
  // boolean turns it off (a typo must not silently remove a shipped feature).
  const rawBoardActions = file.boardActions ?? fromOptions.boardActions;
  const boardActions = typeof rawBoardActions === 'boolean' ? rawBoardActions : DEFAULTS.boardActions;

  // 0.9.0 (`11-20-collab-store`, R4): the storage mode. Only the exact string
  // `json` turns the projection off — a typo (`"jsom"`, `false`, `0`) falls back
  // to `sqlite` instead of silently changing where the truth lives. `dbPath`
  // must be a non-empty string for the same reason (a bad path would degrade
  // every write to "index unavailable" without saying why).
  const rawStorage = file.storage ?? fromOptions.storage;
  const storage: 'sqlite' | 'json' = rawStorage === 'json' ? 'json' : DEFAULTS.storage;
  const rawDbPath = file.dbPath ?? fromOptions.dbPath;
  const dbPath =
    typeof rawDbPath === 'string' && rawDbPath.trim()
      ? rawDbPath.trim().replace(/^~(?=\/|$)/, homedir())
      : DEFAULTS.dbPath;

  // 0.9.2 (`11-20-collab-gate`): the collaboration gate. Only the exact strings
  // `warn` / `off` downgrade it — a typo (`"of"`, `false`, `0`) falls back to
  // `enforce`, because silently disabling a guard is the one failure mode a
  // rollback switch must not have. There is no keyword / alias table: the gate
  // never infers a boundary from text (the session states it on `collab_accept`).
  const rawGate = file.gate ?? fromOptions.gate;
  const gate: 'enforce' | 'warn' | 'off' =
    rawGate === 'warn' || rawGate === 'off' ? rawGate : DEFAULTS.gate;

  return {
    aliases,
    autoDeliver,
    maxInject,
    allowWrite,
    protect,
    readonlyAgents,
    archiveSpawned,
    archiveGraceMs,
    waiterTtlMs,
    waiterHeartbeat,
    dedupeWindowMs,
    awareness,
    boardActions,
    storage,
    dbPath,
    gate,
    ...(reportTo || reportEnabled !== undefined
      ? { report: { ...(reportTo ? { to: reportTo } : {}), ...(reportEnabled !== undefined ? { enabled: reportEnabled } : {}) } }
      : {})
  };
}

export type ConfigReader = () => CollabConfig;

/**
 * Config is re-read lazily on every use (mtime-cached) instead of once in
 * `setup`, so editing `collab.json` (aliases / protect / autoDeliver /
 * maxInject / allowWrite) takes effect immediately — no plugin reload or server
 * restart.
 */
export function createConfigReader(options: unknown): ConfigReader {
  let cache: { stamp: string; config: CollabConfig } | undefined;
  return function readConfig() {
    const stamp = `${mtime(CONFIG_PATH)}:${mtime(LEGACY_ALIAS_PATH)}`;
    if (cache?.stamp === stamp) return cache.config;
    const config = loadConfig(options);
    cache = { stamp, config };
    return config;
  };
}
