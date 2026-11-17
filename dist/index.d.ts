import { Plugin } from "@opencode/plugin";
/** `Permission.Rule` (`{action, resource, effect}`), as stored on a session. */
interface PermissionRule {
  action: string;
  resource: string;
  effect: string;
}
/** The five allow rules this plugin adds — always rebuilt from the whitelist. */
declare function collabPermissionRules(): PermissionRule[];
/**
 * Keep only well-formed `Permission.Rule`s (`{action, resource, effect}` with a
 * known effect). Unknown shapes are dropped rather than forwarded: the host
 * rejects the whole ruleset on one invalid entry, which would lose the merge.
 */
declare function normalizeRules(value: unknown): PermissionRule[];
/**
 * Merge, never replace: `base` keeps its order *and* its precedence, then only
 * rules whose `action+resource` is not present yet are appended. A `deny`
 * already on the session therefore stays a `deny` (no widening by re-granting).
 */
declare function mergeRules(base: unknown, add: unknown): PermissionRule[];
/** Rules of `rules` that `base` does not contain yet (for previews / records). */
declare function missingRules(base: unknown, rules: unknown): PermissionRule[];
/**
 * Fail-closed whitelist: the *add* payload may only carry the five `collab_*`
 * actions with `effect:"allow"`. A restored snapshot is deliberately **not**
 * checked against this list — it is the ruleset that was there before.
 */
declare function assertCollabOnly(rules: PermissionRule[]): PermissionRule[];
/**
 * `@info-studio/collab` — the zero-dependency port of
 * `.opencode/plugins/collab.js`: cross-session collaboration (threads / inbox)
 * plus the cross-workspace hand-off chain (broadcast → score → atomic claim →
 * receipt), exposed as the ten native `collab_*` tools and one `context` hook.
 *
 * The host contract is the plugin `ctx` (in-process capability), never an HTTP
 * client: a plugin that reached the server through a port/token would break as
 * soon as the instance moved. `@opencode/client` is imported for *types* only.
 */
declare const plugin: Plugin.Plugin;
/**
 * Pure helpers exported for the deterministic harness
 * (`test/handoff-harness.mjs`): the ruleset merge (`R3`) and the fail-closed
 * action whitelist (`R2`) are the two places where a mistake would silently
 * widen permissions, so they are unit-testable without a host.
 * No I/O, no `ctx` — the plugin's own entrypoint is `default` only.
 */
export declare const __internals: {
  COLLAB_TOOL_ACTIONS: string[];
  collabPermissionRules: typeof collabPermissionRules;
  normalizeRules: typeof normalizeRules;
  mergeRules: typeof mergeRules;
  missingRules: typeof missingRules;
  assertCollabOnly: typeof assertCollabOnly;
};
export { plugin as default };