import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerWriteTool } from "../tool-helpers.js";
import { appendAuditLog } from "../utils/auditLog.js";

const lineFields = `id name description quantity unitPrice totalPrice taxable unitCost category linkedProductOrService{id}`;
const unchangedFields = ["name", "quantity", "unitPrice", "totalPrice", "taxable", "unitCost", "category", "linkedProductOrService"];
type RecordNode = Record<string, any>;

export function registerJobLineItemDescriptions(server: McpServer): void {
  registerWriteTool(server, "update_job_line_item_descriptions", {
    description: "Replace only the descriptions of existing line items on a reviewed job. Review every replacement with the operator. Prices, quantities, taxes, names, and linked products are not changed. A partial or uncertain result must be reconciled before requesting another write.",
    capability: "records",
    inputSchema: {
      job_id: z.string().min(1),
      expected_updated_at: z.string().min(1),
      line_items: z.array(z.object({
        line_item_id: z.string().min(1),
        description: z.string().max(4000).describe("Exact approved customer-facing replacement; empty string clears the description"),
      }).strict()).min(1).max(20),
      confirm_write: z.literal(true),
    },
    maxCost: 800,
  }, async (args, run) => {
    const selected = new Set(args.line_items.map(line => line.line_item_id));
    if (selected.size !== args.line_items.length) throw new Error("Duplicate line item IDs; no changes were made.");
    // Resolve membership through this job's own connection, never a global ID lookup.
    // Stop once every requested ID is found, with a hard bound of 500 examined lines.
    async function readSelected(expectedVersion?: string): Promise<{ job: RecordNode; lines: Map<string, RecordNode> }> {
      let after: string | undefined;
      let job: RecordNode | undefined;
      const lines = new Map<string, RecordNode>();
      const cursors = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const data = await run<RecordNode>(`query JobDescriptionLines($id:EncodedId!,$after:String){job(id:$id){id updatedAt jobberWebUri lineItems(first:50,after:$after){nodes{${lineFields}} pageInfo{hasNextPage endCursor}}}}`, { id: args.job_id, after });
        const current = data.job;
        if (!current || current.id !== args.job_id || !current.updatedAt) throw new Error("Job not found or version unavailable.");
        if ((expectedVersion && current.updatedAt !== expectedVersion) || (job && current.updatedAt !== job.updatedAt)) {
          throw new Error("Job changed since it was reviewed; fetch it again before updating.");
        }
        job = current;
        if (!Array.isArray(current.lineItems?.nodes)) throw new Error("Job line items unavailable.");
        for (const line of current.lineItems.nodes) {
          if (!line || !selected.has(line.id)) continue;
          if (!["description", ...unchangedFields].every(field => Object.hasOwn(line, field))) {
            throw new Error("Selected line-item verification fields are incomplete.");
          }
          lines.set(line.id, line);
        }
        if (lines.size === selected.size) return { job: current, lines };
        const info = current.lineItems.pageInfo;
        if (!info?.hasNextPage) break;
        if (!info.endCursor || cursors.has(info.endCursor)) throw new Error("Job line-item pagination did not advance.");
        after = info.endCursor;
        cursors.add(after!);
      }
      throw new Error("Every selected line item must belong to this job and be found within the 500-line verification bound.");
    }
    const before = await readSelected(args.expected_updated_at);
    const version = await run<RecordNode>(`query JobDescriptionVersion($id:EncodedId!){job(id:$id){id updatedAt}}`, { id: args.job_id });
    if (version.job?.id !== args.job_id || version.job?.updatedAt !== args.expected_updated_at) throw new Error("Job changed since it was reviewed; fetch it again before updating.");
    let mutationError: string | undefined;
    let userErrors: unknown[] = [];
    try {
      const data = await run<RecordNode>(`mutation EditJobDescriptions($jobId:EncodedId!,$input:JobEditLineItemsInput!){jobEditLineItems(jobId:$jobId,input:$input){job{id updatedAt} modifiedLineItems{id description} userErrors{message path}}}`, {
        jobId: args.job_id,
        input: { lineItems: args.line_items.map(line => ({ lineItemId: line.line_item_id, description: line.description })) },
      });
      const payload = data.jobEditLineItems;
      if (!payload || !Array.isArray(payload.userErrors)) mutationError = "Jobber returned an incomplete mutation response.";
      else userErrors = payload.userErrors;
    } catch (error) {
      mutationError = error instanceof Error ? error.message : String(error);
    }
    let after: Awaited<ReturnType<typeof readSelected>> | undefined;
    let verificationError: string | undefined;
    try { after = await readSelected(); }
    catch (error) { verificationError = error instanceof Error ? error.message : String(error); }
    const results = args.line_items.map(line => {
      const previous = before.lines.get(line.line_item_id)!;
      const current = after?.lines.get(line.line_item_id);
      const unchanged = !!current && unchangedFields.every(field => JSON.stringify(current[field]) === JSON.stringify(previous[field]));
      return { line_item_id: line.line_item_id, description: current?.description,
        description_verified: !!current && current.description === line.description,
        other_fields_unchanged: unchanged };
    });
    const verified = !verificationError && results.every(line => line.description_verified && line.other_fields_unchanged);
    const successful = verified && !mutationError && !userErrors.length;
    await appendAuditLog({ tool: "update_job_line_item_descriptions", args: {
      job_id: args.job_id, line_item_ids: [...selected], changed_fields: ["description"],
    }, outcome: successful ? "success" : "error", ...(successful ? {} : { error_message: "Description update needs reconciliation; no mutation retry performed." }) });
    return { content: [{ type: "text" as const, text: JSON.stringify({
      action: "update_descriptions", record_type: "job", job_id: args.job_id,
      record_version: after?.job.updatedAt, jobber_web_uri: after?.job.jobberWebUri,
      outcome: successful ? "verified" : "partial_or_uncertain", results,
      ...(mutationError ? { mutation_error: mutationError } : {}),
      ...(userErrors.length ? { user_errors: userErrors } : {}),
      ...(verificationError ? { verification_error: verificationError } : {}),
      ...(!successful ? { guidance: "The mutation was not retried. Read the job and reconcile these results before requesting another write." } : {}),
    }) }], ...(!successful ? { isError: true } : {}) };
  });
}
