import type { ToolDefinition } from '../types.ts';
import { jsonInput } from './shared.ts';
import type { ToolKit } from './shared.ts';

/**
 * `collab_report` — the manual half of the defect self-reporting (R8③).
 *
 * The automatic path catches classified defects inside every other tool; this
 * one exists for what a heuristic cannot see (a wrong answer, a silent hang, a
 * confusing refusal). It never changes any collaboration state: it writes one
 * evidence pair and, if `report.to` is configured, queues one `note`.
 *
 * `confirm:true` is required to write anything — the preview shows the signature
 * and directory only. The evidence is a whitelist of fields: `note` is the one
 * free-form text and is cut at 2KB; the session's messages/files are never read.
 */
export function reportTool(kit: ToolKit): ToolDefinition {
  const { deps } = kit;

  return {
    name: 'collab_report',
    description:
      'Report a suspected plugin defect from this session (side path: changes no collaboration state). ' +
      'Collects the plugin version, tool, workspace, session and timestamp — never your message bodies, file ' +
      'contents or tokens. Writes ~/.config/opencode/collab-reports/<signature>/<ts>.{json,md} and, when ' +
      '`report.to` is configured, queues one `note` to the maintainer session. Same signature is rate-limited ' +
      'to one report per hour. Requires confirm:true; otherwise it only previews.',
    input: jsonInput({
      properties: {
        note: {
          type: 'string',
          description:
            'One-line description of what looked wrong (e.g. "回执被 protect 拒绝，bid=b_…"). ' +
            'Optional: without it the report is attributed to this session.'
        },
        bid: {
          type: 'string',
          description: 'Optional hand-off id (`b_…`) whose state snapshot should be attached.'
        },
        threadID: {
          type: 'string',
          description: 'Optional thread id (`t_…`) related to the report.'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually write the report. false/omitted only previews.'
        }
      },
      required: []
    }),
    async execute(input, context) {
      return deps.reporter.manual(input ?? {}, context);
    }
  };
}
