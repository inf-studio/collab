/**
 * 0.9.2 (`11-20-collab-gate`): one append-only audit line per **statement** —
 * the claimant's own answer to "is this bid inside my boundary?".
 *
 * Same file as the board's action audit (`~/.config/opencode/collab-audit.jsonl`,
 * `core/actions.ts`), same rules: **append only, never rotate, never throw**. A
 * decision that already happened must not turn a readable refusal (or an
 * approved override) into an fs error — a write failure is one log line.
 *
 * The two line shapes coexist on purpose (`JSON.stringify` escapes newlines, so
 * one entry is always one line):
 *
 *   board action  { at, actor, action, target, ok, reason }
 *   gate statement { at, sid, kind, bid, inScope, reason, verifiedBy, approvedBy? }
 *
 * Only a real statement is recorded: a missing `scopeCheck` (the nudge) and the
 * overflow reminder leave no line — nothing was judged, so there is nothing to
 * audit. `COLLAB_AUDIT_FILE` overrides the path (harness / sandbox runs).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AUDIT_FILE } from '../constants.ts';
import { errText, log } from '../log.ts';

/** Who vouched for the statement: the model's own judgement, or a human override. */
export type GateVerifiedBy = 'model' | 'override';

/** One gate statement line (design §6, revised 0.9.2). */
export interface GateAuditEntry {
  /** Epoch ms. */
  at: number;
  /** The session that made the statement (`ses_…`; `''` when unknown). */
  sid: string;
  /** The action the statement was made for (`accept`). */
  kind: string;
  /** The broadcast id the statement is about. */
  bid: string;
  /** The statement itself: `true` = inside the boundary, `false` = outside. */
  inScope: boolean;
  /** The claimant's own words (`reason` of the statement, or a default). */
  reason: string;
  /** `model` = the session judged it; `override` = a human let it through. */
  verifiedBy: GateVerifiedBy;
  /** The human who approved an override (absent otherwise). */
  approvedBy?: string;
}

/** Where the lines go — exported so a test / operator can point at one file. */
export function gateAuditFile(): string {
  return AUDIT_FILE;
}

/** Append one line. Never throws: the decision already happened. */
export function appendGateAudit(entry: GateAuditEntry): void {
  try {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    log(`gate audit write failed: ${errText(error)}`);
  }
}
