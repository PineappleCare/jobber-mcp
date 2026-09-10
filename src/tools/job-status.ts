import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerWriteTool } from "../tool-helpers.js";
import { assertMutationAccepted, assertPresent } from "../jobber/mutations.js";
import { appendAuditLog } from "../utils/auditLog.js";

const JOB_FIELDS = "id updatedAt jobberWebUri jobNumber title jobStatus completedAt";

export function registerJobStatusTool(server: McpServer): void {
  registerWriteTool(server, "set_job_status", {
    description: "Close or reopen a reviewed Jobber job. Closing requires an explicit policy for incomplete visits.",
    capability: "scheduling",
    inputSchema: {
      job_id: z.string().min(1),
      expected_updated_at: z.string().min(1),
      status: z.enum(["close", "reopen"]),
      incomplete_visit_policy: z.enum(["DESTROY_ALL", "COMPLETE_PAST_DESTROY_FUTURE"]).optional(),
      completed_on: z.string().date().optional(),
      confirm_write: z.literal(true),
    },
    maxCost: 300,
  }, async (args: any, run) => {
    const current = await run<any>(`query JobVersion($id:EncodedId!){job(id:$id){updatedAt jobStatus}}`, { id: args.job_id });
    if (current.job?.updatedAt !== args.expected_updated_at) throw new Error("Job changed since it was reviewed; fetch it again before changing status.");
    let data: any;
    let payload: any;
    if (args.status === "close") {
      if (!args.incomplete_visit_policy || !args.completed_on) throw new Error("Closing a job requires incomplete_visit_policy and completed_on.");
      data = await run(`mutation CloseJob($jobId:EncodedId!,$input:JobCloseInput!){jobClose(jobId:$jobId,input:$input){job{${JOB_FIELDS}} userErrors{message path}}}`, { jobId: args.job_id, input: { modifyIncompleteVisitsBy: args.incomplete_visit_policy, completedOn: args.completed_on } });
      payload = assertMutationAccepted("closing job", data.jobClose);
    } else {
      data = await run(`mutation ReopenJob($jobId:EncodedId!){jobReopen(jobId:$jobId){job{${JOB_FIELDS}} userErrors{message path}}}`, { jobId: args.job_id });
      payload = assertMutationAccepted("reopening job", data.jobReopen);
    }
    const job = assertPresent("changing job status", payload.job);
    await appendAuditLog({ tool: "set_job_status", args, outcome: "success", result_count: 1 });
    return { content: [{ type: "text", text: JSON.stringify({ action: args.status, record_type: "job", record: job }) }] };
  });
}
