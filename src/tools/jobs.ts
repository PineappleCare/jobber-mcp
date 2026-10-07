import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { hasMutationExecutionErrors } from "../jobber/client.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { registerWriteTool, toolErrorType, type CostedGraphQL } from "../tool-helpers.js";
import { lineItemSchema, type JobLine } from "./job-line-items.js";

type Node = Record<string, any>;
type Run = CostedGraphQL<number>;
const SCAN_PAGES = 10;
const jobFields = `id updatedAt jobberWebUri jobNumber jobType jobStatus title instructions allowReviewRequest billingType client{id} property{id} quote{id} request{id} startAt endAt invoiceSchedule{billingFrequency recurrenceSchedule{calendarRule}} visitSchedule{recurrenceSchedule{calendarRule} assignedTo(first:1){nodes{id} pageInfo{hasNextPage}}}`;
const inputSchema = {
  job_type: z.enum(["ONE_OFF", "RECURRING"]).default("ONE_OFF")
    .describe("Normally ONE_OFF. RECURRING requires explicit operator intent and explicit billing choices."),
  property_id: z.string().trim().min(1),
  quote_id: z.string().trim().min(1).optional(),
  request_id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(250).describe("Required reviewed title for bounded duplicate checking"),
  instructions: z.string().trim().max(10000).default(""),
  billing_type: z.enum(["FIXED_PRICE", "VISIT_BASED"]).optional()
    .describe("Defaults to FIXED_PRICE for ONE_OFF. RECURRING requires explicit VISIT_BASED."),
  billing_schedule: z.enum(["ON_COMPLETION", "PERIODIC", "PER_VISIT", "NEVER"]).optional()
    .describe("Defaults to ON_COMPLETION for ONE_OFF. RECURRING requires an explicit supported choice."),
  line_items: z.array(lineItemSchema).max(100).default([]),
  confirm_write: z.literal(true),
};
type Args = z.infer<z.ZodObject<typeof inputSchema>>;
type ResolvedArgs = Args & { billing_type: "FIXED_PRICE" | "VISIT_BASED"; billing_schedule: "ON_COMPLETION" | "PER_VISIT" | "NEVER" };

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

function resolveBilling(args: Args): ResolvedArgs {
  if (args.job_type === "ONE_OFF") {
    requireCondition((args.billing_type ?? "FIXED_PRICE") === "FIXED_PRICE" &&
      (args.billing_schedule ?? "ON_COMPLETION") === "ON_COMPLETION",
    "One-off creation currently supports the verified FIXED_PRICE / ON_COMPLETION combination only; no job was created.");
    return { ...args, billing_type: "FIXED_PRICE", billing_schedule: "ON_COMPLETION" };
  }
  requireCondition(args.billing_type === "VISIT_BASED" && args.billing_schedule !== undefined,
    "Recurring/as-needed creation requires explicit VISIT_BASED billing and an explicit billing_schedule; no job was created.");
  requireCondition(args.billing_schedule !== "PERIODIC",
    "Periodic recurring billing needs an invoicing recurrence rule, which this unscheduled creation tool does not expose; no job was created.");
  return { ...args, billing_type: args.billing_type, billing_schedule: args.billing_schedule };
}

/** A complete, bounded property scan serves both duplicate checking and recovery. */
async function propertyJobs(args: ResolvedArgs, run: Run): Promise<{ clientId: string; matches: Node[] }> {
  let after: string | undefined, clientId: string | undefined;
  const cursors = new Set<string>(), ids = new Set<string>(), matches: Node[] = [];
  for (let page = 0; page < SCAN_PAGES; page++) {
    const data = await run<Node>(`query JobCreationPreflight($id:EncodedId!,$after:String){property(id:$id){id client{id} jobs(first:50,after:$after){nodes{id title jobStatus} pageInfo{hasNextPage endCursor}}}}`, { id: args.property_id, after });
    const property = data.property;
    requireCondition(property?.id === args.property_id && typeof property.client?.id === "string" && property.client.id,
      "Property or its client is unavailable; no job creation can be verified.");
    const ownerId: string = property.client.id;
    requireCondition(clientId === undefined || ownerId === clientId, "Property ownership changed during the scan; review again.");
    clientId = ownerId;
    const connection = property.jobs;
    requireCondition(Array.isArray(connection?.nodes) && connection.nodes.length <= 50 && typeof connection.pageInfo?.hasNextPage === "boolean",
      "Job duplicate scan is incomplete; no job creation can be verified.");
    for (const job of connection.nodes) {
      requireCondition(typeof job?.id === "string" && job.id && !ids.has(job.id) &&
        (job.title === null || typeof job.title === "string") && typeof job.jobStatus === "string",
      "Job duplicate scan is inconsistent; review again.");
      ids.add(job.id);
      if (normalized(job.title ?? "") === normalized(args.title)) matches.push(job);
    }
    if (!connection.pageInfo.hasNextPage) return { clientId, matches };
    const next = connection.pageInfo.endCursor;
    requireCondition(typeof next === "string" && next && !cursors.has(next), "Job duplicate scan has an invalid cursor; review again.");
    cursors.add(next); after = next;
  }
  throw new Error("Job duplicate scan exceeds 500 jobs; reconcile manually before any creation.");
}

async function preflight(args: ResolvedArgs, run: Run): Promise<{ clientId: string; inheritedRequestId?: string }> {
  let inheritedRequestId: string | undefined;
  requireCondition(!(args.quote_id && args.request_id), "Choose a source quote or a source request, not both.");
  const { clientId, matches } = await propertyJobs(args, run);
  requireCondition(!matches.some(job => !["closed", "archived"].includes(normalized(job.jobStatus))),
    "A matching active job already exists at this property; no job was created.");
  if (args.quote_id) {
    const data = await run<Node>(`query QuoteForJobCreation($id:EncodedId!){quote(id:$id){id client{id} property{id} request{id} jobs(first:1){nodes{id} pageInfo{hasNextPage}}}}`, { id: args.quote_id });
    const quote = data.quote;
    requireCondition(quote?.id === args.quote_id && quote.client?.id === clientId && quote.property?.id === args.property_id,
      "Quote and property do not belong to the same workflow; no job was created.");
    inheritedRequestId = quote.request?.id;
    requireCondition(Array.isArray(quote.jobs?.nodes) && quote.jobs.nodes.length === 0 && quote.jobs.pageInfo?.hasNextPage === false,
      "The quote already has a job or its job list is incomplete; no duplicate job was created.");
  }
  if (args.request_id) {
    const data = await run<Node>(`query RequestForJobCreation($id:EncodedId!){request(id:$id){id requestStatus client{id} property{id} jobs(first:1){nodes{id} pageInfo{hasNextPage}}}}`, { id: args.request_id });
    const request = data.request;
    requireCondition(request?.id === args.request_id && request.client?.id === clientId && request.property?.id === args.property_id,
      "Request and property do not belong to the same workflow; no job was created.");
    requireCondition(typeof request.requestStatus === "string" && normalized(request.requestStatus) !== "archived" &&
      Array.isArray(request.jobs?.nodes) && request.jobs.nodes.length === 0 && request.jobs.pageInfo?.hasNextPage === false,
    "The source request is archived, already has a job, or its job list is incomplete; no job was created.");
  }
  // Recheck destination immediately before dispatch; the API has no atomic lock.
  const current = await run<Node>(`query JobCreationDestination($id:EncodedId!){property(id:$id){id client{id}}}`, { id: args.property_id });
  requireCondition(current.property?.id === args.property_id && current.property.client?.id === clientId,
    "Property ownership changed before creation; no job was created.");
  return { clientId, inheritedRequestId };
}

function lineMatches(line: JobLine, actual: Node): boolean {
  return actual?.name === line.name && (actual.description ?? "") === (line.description ?? "") &&
    actual.quantity === line.quantity && actual.unitPrice === line.unit_price &&
    (line.taxable === undefined || actual.taxable === line.taxable) &&
    (line.product_or_service_id === undefined || actual.linkedProductOrService?.id === line.product_or_service_id);
}

function verify(args: ResolvedArgs, clientId: string, jobId: string, job: Node | undefined, inheritedRequestId: string | undefined) {
  const connection = job?.lineItems;
  const complete = Array.isArray(connection?.nodes) && connection.pageInfo?.hasNextPage === false;
  const remaining: Node[] = complete ? [...connection.nodes] : [];
  const lines = args.line_items.map(line => {
    const index = remaining.findIndex(actual => lineMatches(line, actual));
    return index < 0 ? false : !!remaining.splice(index, 1).length;
  });
  return {
    destination: job?.id === jobId && job.client?.id === clientId && job.property?.id === args.property_id,
    source: !!job && Object.hasOwn(job, "quote") && Object.hasOwn(job, "request") &&
      (args.quote_id ? job.quote?.id === args.quote_id : !job.quote?.id) &&
      (args.request_id ? job.request?.id === args.request_id : !job.request?.id ||
        (!!args.quote_id && job.request.id === inheritedRequestId)),
    job_type: job?.jobType === args.job_type,
    review_requests_disabled: job?.allowReviewRequest === false,
    billing: job?.billingType === args.billing_type && job.invoiceSchedule?.billingFrequency === args.billing_schedule &&
      job.invoiceSchedule.recurrenceSchedule === null,
    header: !!job && job.title === args.title && Object.hasOwn(job, "instructions") && (job.instructions ?? "") === args.instructions,
    unscheduled: !!job && job.startAt === null && job.endAt === null && job.visitSchedule?.recurrenceSchedule === null &&
      job.visits?.pageInfo?.hasNextPage === false && Array.isArray(job.visits.nodes) && job.visits.nodes.length === 0 &&
      job.visitSchedule?.assignedTo?.pageInfo?.hasNextPage === false &&
      Array.isArray(job.visitSchedule.assignedTo.nodes) && job.visitSchedule.assignedTo.nodes.length === 0,
    line_items: complete && remaining.length === 0 && lines.every(Boolean),
  };
}

export function registerCreateJob(server: McpServer): void {
  registerWriteTool(server, "create_job", {
    description: "Create an unscheduled job with no visits, assignments or notifications. Normally ONE_OFF with FIXED_PRICE / ON_COMPLETION billing (verified native recipe). RECURRING requires explicit operator intent, VISIT_BASED billing and an explicit non-periodic billing schedule. Several visits never imply recurrence; create requested visits separately. Review the resolved type, billing, destination, title, instructions and all positive-quantity lines. Only outcome created confirms full readback; reconcile uncertain IDs and never retry automatically. Existing job conversion is unavailable.",
    capability: "records", redactAuditErrors: true, inputSchema, maxCost: 800,
  }, async (input, run) => {
    const args = resolveBilling(input);
    const { clientId, inheritedRequestId } = await preflight(args, run);
    let returned: Node | undefined, observed: Node | undefined;
    let mutationFailure: unknown, mutationError: string | undefined, readError: string | undefined;
    let executionError = false;
    let userErrors: unknown[] = [];
    try {
      const data = await run<Node>(`mutation CreateJob($input:JobCreateAttributes!){jobCreate(input:$input){job{${jobFields}} userErrors{message path}}}`, { input: {
        propertyId: args.property_id, quoteId: args.quote_id, requestId: args.request_id,
        title: args.title, instructions: args.instructions, allowReviewRequest: false,
        invoicing: { invoicingType: args.billing_type, invoicingSchedule: args.billing_schedule },
        scheduling: { createVisits: false, notifyTeam: false },
        lineItems: args.line_items.map(line => ({ name: line.name, description: line.description ?? "", quantity: line.quantity,
          unitPrice: line.unit_price, taxable: line.taxable, productOrServiceId: line.product_or_service_id, saveToProductsAndServices: false })),
      } });
      executionError = hasMutationExecutionErrors(data);
      const payload = data?.jobCreate;
      returned = payload?.job;
      if (Array.isArray(payload?.userErrors)) userErrors = payload.userErrors;
      else mutationError = "Jobber returned an incomplete mutation response.";
      if (executionError) mutationError = "Jobber returned a GraphQL execution error; creation may have partially completed.";
      if (!returned?.id && !userErrors.length) mutationError ??= "Jobber did not return a job ID.";
    } catch (error) {
      mutationFailure = error;
      mutationError = error instanceof Error ? error.message : String(error);
    }
    const jobId = typeof returned?.id === "string" && returned.id ? returned.id : undefined;
    let candidates: string[] = [];
    const failureType = mutationFailure ? toolErrorType(mutationFailure) : undefined;
    const rejected = !jobId && !executionError && (userErrors.length > 0 || failureType === "jobber_rejected");
    const unavailable = !jobId && failureType === "connection_unavailable";
    if (jobId) {
      try {
        observed = (await run<Node>(`query VerifyCreatedJob($id:EncodedId!){job(id:$id){${jobFields} visits(first:1){nodes{id} pageInfo{hasNextPage}} lineItems(first:100){nodes{id name description quantity unitPrice taxable linkedProductOrService{id}} pageInfo{hasNextPage}}}}`, { id: jobId })).job;
        if (observed?.id !== jobId) readError = "Created job could not be read back by its returned ID.";
      } catch (error) { readError = error instanceof Error ? error.message : String(error); }
    } else if (!rejected && !unavailable) {
      try {
        const scan = await propertyJobs(args, run);
        if (scan.clientId === clientId) candidates = scan.matches.map(job => job.id);
        else readError = "Property ownership changed during reconciliation.";
      } catch (error) { readError = error instanceof Error ? error.message : String(error); }
    }
    const checks = verify(args, clientId, jobId ?? "", observed, inheritedRequestId);
    const verified = Object.values(checks).every(Boolean);
    const successful = verified && !mutationError && !userErrors.length;
    const outcome = successful ? "created" : rejected ? "rejected" : unavailable ? "connection_unavailable" : "uncertain";
    await appendAuditLog({ tool: "create_job", args: { ...args, client_id: clientId, job_id: jobId },
      outcome: successful ? "success" : "error", result_count: jobId ? 1 : 0,
      ...(successful ? {} : { error_message: `Job outcome: ${outcome}; details omitted for sensitive input.` }) });
    return { content: [{ type: "text", text: JSON.stringify({
      action: successful ? "created" : "create_job", record_type: "job", outcome,
      job_type: args.job_type, billing_type: args.billing_type, billing_schedule: args.billing_schedule,
      schedule_mode: "unscheduled", verification: checks,
      ...(jobId ? { job_id: jobId, record: observed?.id === jobId ? observed : returned, record_version: observed?.updatedAt } : {}),
      ...(candidates.length ? { candidate_job_ids: candidates } : {}),
      ...(userErrors.length ? { user_errors: userErrors } : {}),
      ...(mutationError ? { mutation_error: mutationError } : {}), ...(readError ? { read_error: readError } : {}),
      ...(successful ? {} : { error_type: rejected ? "jobber_rejected" : unavailable ? "connection_unavailable" : "outcome_uncertain",
        guidance: rejected || unavailable ? "No created job was confirmed. Review the failure before proposing a new approved request."
          : "Creation may have completed. Read the returned job ID or candidate IDs before any new approved write. Do not automatically retry, convert, delete or recreate this job." }),
    }) }], ...(successful ? {} : { isError: true }) };
  });
}
