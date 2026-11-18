import { BUILTIN_PROTECT, CONFIG_PATH, DEFAULTS, DEFAULT_READONLY_AGENTS, LEGACY_ALIAS_PATH } from './constants.ts';
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

  return {
    aliases,
    autoDeliver,
    maxInject,
    allowWrite,
    protect,
    readonlyAgents,
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
