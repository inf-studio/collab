import type { ToolDefinition } from '../types.ts';
import { acceptTool } from './accept.ts';
import { broadcastTool } from './broadcast.ts';
import { grantTool } from './grant.ts';
import { handoffTool } from './handoff.ts';
import { inboxTool } from './inbox.ts';
import { listTool } from './list.ts';
import { promoteTool } from './promote.ts';
import { replyTool } from './reply.ts';
import { reportTool } from './report.ts';
import { sendTool } from './send.ts';
import type { ToolKit } from './shared.ts';
import { waitTool } from './wait.ts';

export { createToolKit } from './shared.ts';
export type { ToolDeps, ToolKit, Target, DeliveryMode } from './shared.ts';

/**
 * The `collab_*` tools, in registration order (the order is part of the
 * single-file behaviour: `/api/tool` and the harness both read it).
 *
 * Every tool is wrapped by `reporter.wrap` (R1): a classified defect is written
 * to the report directory / delivered to `report.to`, and the error is re-thrown
 * unchanged except for the R8 hint line. `collab_report` itself is not wrapped —
 * a failure inside the reporting path must not spawn a second report.
 */
export function registerTools(kit: ToolKit): ToolDefinition[] {
  const { reporter } = kit.deps;
  const definitions = [
    listTool(kit),
    broadcastTool(kit),
    handoffTool(kit),
    acceptTool(kit),
    sendTool(kit),
    replyTool(kit),
    inboxTool(kit),
    waitTool(kit),
    grantTool(kit),
    promoteTool(kit),
    reportTool(kit)
  ];
  return definitions.map(definition =>
    definition.name === 'collab_report'
      ? definition
      : { ...definition, execute: reporter.wrap(definition.name, definition.execute) }
  );
}
