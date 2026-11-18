/**
 * Error taxonomy for the defect self-report path (R1–R3).
 *
 * The plugin must be able to tell three very different things apart:
 *
 *   - **expected** outcomes (bad input, a guard refusal, a lease timeout):
 *     the caller can fix them by changing the call, so they must never become a
 *     "plugin bug" report (`ValidationError`);
 *   - **protocol/guard conflicts** (an instruction that the plugin's own guard
 *     refuses — the `b_bdae8488…` receipt deadlock shape) — `GuardConflictError`;
 *   - **everything else** (a host `TypeError`, an fs failure, an HTTP 5xx on
 *     delivery, a broken invariant): a real defect and worth reporting.
 *
 * `classify()` is the single place that makes that call, so the wrapper in
 * `core/report.ts` has no heuristics of its own.
 */

/** Report classes (design §1). `manual` is the `collab_report` tool. */
export type DefectClass =
  | 'uncaught'
  | 'invariant'
  | 'guard-conflict'
  | 'delivery-5xx'
  | 'extract-error'
  | 'manual';

/** Detail carried into the evidence file (never the message body). */
export interface DefectMeta {
  guard?: string;
  invariant?: string;
  status?: number;
  [key: string]: unknown;
}

interface CollabError extends Error {
  readonly collabKind: string;
  readonly collabMeta?: DefectMeta;
  readonly collabValidation?: boolean;
}

/*
 * `collabKind` is a stable machine tag besides `name`: `instanceof` does not
 * survive two copies of the package loaded in one process, and a bundler may
 * rename classes, so `classify` duck-types on the tag first and only uses
 * `name` as the human-readable label in the evidence file.
 */

/**
 * Expected, caller-fixable error — **never reported**.
 *
 * Covers both what the PRD calls "参数校验类错误" (empty text, malformed bid,
 * unknown target) and "正常业务拒绝" (protect refusal, lease expired, wait
 * timeout, already claimed). The class is named after the first group because
 * that is the one the tool layer declares most often; the doc comment is the
 * contract that matters.
 */
export class ValidationError extends Error {
  readonly collabKind = 'validation';
  readonly collabValidation = true;
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ValidationError';
  }
}

/** An instruction the protocol requires but a guard forbids (R1 example). */
export class GuardConflictError extends Error {
  readonly collabKind = 'guard-conflict';
  readonly collabMeta?: DefectMeta;
  constructor(message: string, meta?: DefectMeta, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GuardConflictError';
    this.collabMeta = meta;
  }
}

/** A state-machine / storage invariant that should be impossible. */
export class InvariantError extends Error {
  readonly collabKind = 'invariant';
  readonly collabMeta?: DefectMeta;
  constructor(message: string, meta?: DefectMeta, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InvariantError';
    this.collabMeta = meta;
  }
}

/** A delivery (prompt / inbox) failure; `status >= 500` marks a server error. */
export class DeliveryError extends Error {
  readonly collabKind = 'delivery-5xx';
  readonly collabMeta: DefectMeta;
  constructor(message: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DeliveryError';
    this.collabMeta = status ? { status } : {};
  }
}

/** A parse/extraction failure (score, verdict, proposal). */
export class ExtractError extends Error {
  readonly collabKind = 'extract-error';
  readonly collabMeta?: DefectMeta;
  constructor(message: string, meta?: DefectMeta, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExtractError';
    this.collabMeta = meta;
  }
}

/** Shorthand for the tool layer: `throw invalid('text 不能为空')`. */
export function invalid(message: string, cause?: unknown): ValidationError {
  return new ValidationError(message, cause);
}

/**
 * A prompt/inbox call failed. `status` is read from the error itself
 * (`status` / `statusCode`) or from an `HTTP 5xx` prefix in the message, so a
 * plain `Error("HTTP 500 …")` from the host still classifies as `delivery-5xx`.
 */
export function deliveryFailure(error: unknown, what = '投递'): DeliveryError {
  const status = statusOf(error);
  const text = String((error as { message?: unknown })?.message ?? error);
  return new DeliveryError(`${what}失败：${text}`, status, error);
}

export function statusOf(error: unknown): number | undefined {
  const direct = Number(
    (error as { status?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode ?? NaN
  );
  if (Number.isFinite(direct) && direct >= 400) return direct;
  const match = /(?:HTTP\s*|\bstatus[=:\s]+)(5\d{2}|4\d{2})\b/i.exec(String((error as { message?: unknown })?.message ?? error));
  return match ? Number(match[1]) : undefined;
}

function isValidation(error: unknown): boolean {
  const value = error as CollabError | undefined;
  return value?.collabValidation === true || value?.collabKind === 'validation';
}

function kindOf(error: unknown): string {
  return String((error as CollabError)?.collabKind ?? '');
}

/**
 * `undefined` = do not report (expected outcome); otherwise the report class.
 * Any thrown non-error value is still a defect: `throw 'boom'` is a bug.
 */
export function classify(error: unknown): DefectClass | undefined {
  if (error === undefined || error === null) return undefined;
  if (isValidation(error)) return undefined;
  switch (kindOf(error)) {
    case 'guard-conflict':
      return 'guard-conflict';
    case 'invariant':
      return 'invariant';
    case 'extract-error':
      return 'extract-error';
    case 'delivery-5xx': {
      const status = Number((error as CollabError)?.collabMeta?.status ?? 0);
      return status >= 500 || status === 0 ? 'delivery-5xx' : 'uncaught';
    }
    default:
      return 'uncaught';
  }
}

/** Meta block of a tagged error (guard name, status, …), if any. */
export function metaOf(error: unknown): DefectMeta | undefined {
  return (error as CollabError)?.collabMeta;
}
