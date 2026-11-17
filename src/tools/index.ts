import type { ToolDefinition } from '../types.ts';
import { acceptTool } from './accept.ts';
import { broadcastTool } from './broadcast.ts';
import { grantTool } from './grant.ts';
import { handoffTool } from './handoff.ts';
import { inboxTool } from './inbox.ts';
import { listTool } from './list.ts';
import { promoteTool } from './promote.ts';
import { replyTool } from './reply.ts';
import { sendTool } from './send.ts';
import type { ToolKit } from './shared.ts';
import { waitTool } from './wait.ts';

export { createToolKit } from './shared.ts';
export type { ToolDeps, ToolKit, Target, DeliveryMode } from './shared.ts';

/**
 * The ten `collab_*` tools, in registration order (the order is part of the
 * single-file behaviour: `/api/tool` and the harness both read it).
 */
export function registerTools(kit: ToolKit): ToolDefinition[] {
  return [
    listTool(kit),
    broadcastTool(kit),
    handoffTool(kit),
    acceptTool(kit),
    sendTool(kit),
    replyTool(kit),
    inboxTool(kit),
    waitTool(kit),
    grantTool(kit),
    promoteTool(kit)
  ];
}
