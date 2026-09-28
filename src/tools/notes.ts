import { createHash } from "crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  isReadOnly,
  isWriteCapabilityEnabled,
  registerReadOnlyTool,
  registerWriteTool,
} from "../tool-helpers.js";
import { JobberOutcomeUncertainError } from "../jobber/errors.js";
import { JobberRejectedError } from "../jobber/mutations.js";
import { appendAuditLog } from "../utils/auditLog.js";

type NoteParentType = "client" | "request" | "quote" | "job" | "invoice";
type Node = Record<string, any>;

const NOTE_PARENT_TYPES = ["client", "request", "quote", "job", "invoice"] as const;
const NOTE_PAGE_CAP = 50;
const NOTE_SCAN_CAP = 500;
const NOTE_COST = 300;

export const noteFields = `id message createdAt lastEditedAt pinned linkedTo { requests quotes jobs invoices }`;

const parentTypeSchema = z.enum(NOTE_PARENT_TYPES);
const noteMessageSchema = z.string().min(1).max(10_000).refine(
  (value) => value.trim().length > 0,
  "Note message must contain non-whitespace text.",
);
const linkedToSchema = z.object({
  requests: z.boolean().optional(),
  quotes: z.boolean().optional(),
  jobs: z.boolean().optional(),
  invoices: z.boolean().optional(),
}).strict();

const allowedLinks: Record<NoteParentType, ReadonlySet<string>> = {
  client: new Set(["requests", "quotes", "jobs", "invoices"]),
  request: new Set(["quotes", "jobs", "invoices"]),
  quote: new Set(["jobs", "invoices"]),
  job: new Set(["invoices"]),
  invoice: new Set(),
};

const parentQueries: Record<NoteParentType, string> = {
  client: `query ClientNotes($id:EncodedId!,$first:Int!,$after:String){client(id:$id){id notes(first:$first,after:$after){nodes{${noteFields}} pageInfo{hasNextPage endCursor}}}}`,
  request: `query RequestNotes($id:EncodedId!,$first:Int!,$after:String){request(id:$id){id notes(first:$first,after:$after){nodes{... on NoteInterface {${noteFields}}} pageInfo{hasNextPage endCursor}}}}`,
  quote: `query QuoteNotes($id:EncodedId!,$first:Int!,$after:String){quote(id:$id){id notes(first:$first,after:$after){nodes{... on NoteInterface {${noteFields}}} pageInfo{hasNextPage endCursor}}}}`,
  job: `query JobNotes($id:EncodedId!,$first:Int!,$after:String){job(id:$id){id notes(first:$first,after:$after){nodes{... on NoteInterface {${noteFields}}} pageInfo{hasNextPage endCursor}}}}`,
  invoice: `query InvoiceNotes($id:EncodedId!,$first:Int!,$after:String){invoice(id:$id){id notes(first:$first,after:$after){nodes{... on NoteInterface {${noteFields}}} pageInfo{hasNextPage endCursor}}}}`,
};

const createMutations: Record<NoteParentType, { payload: string; note: string; query: string }> = {
  client: { payload: "clientCreateNote", note: "clientNote", query: `mutation CreateClientNote($recordId:EncodedId!,$input:ClientCreateNoteInput!){clientCreateNote(clientId:$recordId,input:$input){clientNote{${noteFields}} userErrors{message path}}}` },
  request: { payload: "requestCreateNote", note: "requestNote", query: `mutation CreateRequestNote($recordId:EncodedId!,$input:RequestCreateNoteInput!){requestCreateNote(requestId:$recordId,input:$input){requestNote{${noteFields}} userErrors{message path}}}` },
  quote: { payload: "quoteCreateNote", note: "quoteNote", query: `mutation CreateQuoteNote($recordId:EncodedId!,$input:QuoteCreateNoteInput!){quoteCreateNote(quoteId:$recordId,input:$input){quoteNote{${noteFields}} userErrors{message path}}}` },
  job: { payload: "jobCreateNote", note: "jobNote", query: `mutation CreateJobNote($recordId:EncodedId!,$input:JobCreateNoteInput!){jobCreateNote(jobId:$recordId,input:$input){jobNote{${noteFields}} userErrors{message path}}}` },
  invoice: { payload: "invoiceCreateNote", note: "invoiceNote", query: `mutation CreateInvoiceNote($recordId:EncodedId!,$input:InvoiceCreateNoteInput!){invoiceCreateNote(invoiceId:$recordId,input:$input){invoiceNote{${noteFields}} userErrors{message path}}}` },
};

const editMutations: Record<NoteParentType, { payload: string; note: string; query: string }> = {
  client: { payload: "clientEditNote", note: "clientNote", query: `mutation EditClientNote($input:ClientEditNoteInput!){clientEditNote(input:$input){clientNote{${noteFields}} userErrors{message path}}}` },
  request: { payload: "requestEditNote", note: "requestNote", query: `mutation EditRequestNote($input:RequestEditNoteInput!){requestEditNote(input:$input){requestNote{${noteFields}} userErrors{message path}}}` },
  quote: { payload: "quoteEditNote", note: "quoteNote", query: `mutation EditQuoteNote($input:QuoteEditNoteInput!){quoteEditNote(input:$input){quoteNote{${noteFields}} userErrors{message path}}}` },
  job: { payload: "jobEditNote", note: "jobNote", query: `mutation EditJobNote($input:JobEditNoteInput!){jobEditNote(input:$input){jobNote{${noteFields}} userErrors{message path}}}` },
  invoice: { payload: "invoiceEditNote", note: "invoiceNote", query: `mutation EditInvoiceNote($input:InvoiceEditNoteInput!){invoiceEditNote(input:$input){invoiceNote{${noteFields}} userErrors{message path}}}` },
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedLinks(value: unknown): Record<string, boolean> {
  const links = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    requests: links.requests === true,
    quotes: links.quotes === true,
    jobs: links.jobs === true,
    invoices: links.invoices === true,
  };
}

export function noteVersion(note: Node): string {
  const view = {
    id: note.id,
    message: note.message,
    createdAt: note.createdAt,
    lastEditedAt: note.lastEditedAt ?? null,
    pinned: note.pinned === true,
    linkedTo: normalizedLinks(note.linkedTo),
  };
  return `sha256:${createHash("sha256").update(stable(view)).digest("hex")}`;
}

export function noteWithVersion(note: Node): Node {
  return {
    ...note,
    pinned: note.pinned === true,
    linkedTo: normalizedLinks(note.linkedTo),
    note_version: noteVersion(note),
  };
}

export function recordWithNoteVersions(record: Node): Node {
  if (!Array.isArray(record.notes?.nodes)) return record;
  return {
    ...record,
    notes: { ...record.notes, nodes: record.notes.nodes.map(noteWithVersion) },
  };
}

function validateLinks(recordType: NoteParentType, links: Record<string, boolean> | undefined): void {
  if (!links) return;
  const unsupported = Object.keys(links).filter((key) => !allowedLinks[recordType].has(key));
  if (unsupported.length) {
    throw new Error(`${recordType} notes cannot link to: ${unsupported.join(", ")}.`);
  }
}

function linksForMutation(recordType: NoteParentType, links: Record<string, boolean> | undefined): Record<string, boolean> | undefined {
  if (!links || recordType === "invoice") return undefined;
  return links;
}

function requestedLinksMatch(note: Node, requested: Record<string, boolean> | undefined): boolean {
  if (!requested) return true;
  const actual = normalizedLinks(note.linkedTo);
  return Object.entries(requested).every(([key, value]) => actual[key] === value);
}

function noteMatchesCreate(note: Node, args: Node): boolean {
  const actualLinks = normalizedLinks(note.linkedTo);
  const requestedLinks = normalizedLinks(args.linked_to);
  return note.message === args.message
    && note.pinned === args.pinned
    && Object.keys(requestedLinks).every((key) => actualLinks[key] === requestedLinks[key]);
}

function noteMatchesUpdate(note: Node, args: Node): boolean {
  return (args.message === undefined || note.message === args.message)
    && (args.pinned === undefined || note.pinned === args.pinned)
    && requestedLinksMatch(note, args.linked_to);
}

function formatUserErrors(payload: Node): Array<{ message: string; path?: string[] }> {
  if (!Array.isArray(payload?.userErrors)) return [];
  return payload.userErrors.map((error: Node) => ({
    message: String(error?.message ?? "Jobber returned an unspecified error"),
    ...(Array.isArray(error?.path) ? { path: error.path.map(String) } : {}),
  }));
}

function rejected(action: string, errors: Array<{ message: string; path?: string[] }>): JobberRejectedError {
  const detail = errors
    .map((error) => `${error.path?.length ? `${error.path.join(".")}: ` : ""}${error.message}`)
    .join("; ");
  return new JobberRejectedError(`Jobber rejected ${action}: ${detail}`);
}

function result(payload: Node, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function readNotePage(
  recordType: NoteParentType,
  recordId: string,
  first: number,
  after: string | undefined,
  run: (query: string, variables?: Record<string, unknown>) => Promise<Node>,
): Promise<{ notes: Node[]; hasNextPage: boolean; endCursor?: string }> {
  const data = await run(parentQueries[recordType], { id: recordId, first, after });
  const parent = data[recordType];
  if (!parent) throw new Error(`Jobber ${recordType} was not found; no note operation was performed.`);
  const connection = parent.notes;
  return {
    notes: (connection?.nodes ?? []).map(noteWithVersion),
    hasNextPage: connection?.pageInfo?.hasNextPage === true,
    ...(connection?.pageInfo?.endCursor ? { endCursor: String(connection.pageInfo.endCursor) } : {}),
  };
}

async function scanNotes(
  recordType: NoteParentType,
  recordId: string,
  run: (query: string, variables?: Record<string, unknown>) => Promise<Node>,
): Promise<Node[]> {
  const notes: Node[] = [];
  let cursor: string | undefined;
  do {
    const page = await readNotePage(recordType, recordId, NOTE_PAGE_CAP, cursor, run);
    notes.push(...page.notes);
    if (page.hasNextPage && notes.length >= NOTE_SCAN_CAP) {
      throw new Error(`The ${recordType} has more than ${NOTE_SCAN_CAP} notes; narrow the operation in Jobber before writing.`);
    }
    cursor = page.hasNextPage ? page.endCursor : undefined;
    if (page.hasNextPage && !cursor) throw new Error("Jobber returned an invalid note pagination cursor.");
  } while (cursor);
  return notes;
}

async function auditNote(tool: string, args: Node, outcome: "success" | "partial" | "error", note?: Node, errorMessage?: string) {
  await appendAuditLog({
    tool,
    args: {
      record_type: args.record_type,
      record_id: args.record_id,
      ...(args.note_id ? { note_id: args.note_id } : {}),
      ...(note?.id ? { result_note_id: note.id } : {}),
      ...(args.message !== undefined ? { message: args.message } : {}),
      ...(typeof args.message === "string" ? { message_length: args.message.length } : {}),
      ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
      ...(args.linked_to !== undefined ? { linked_to: args.linked_to } : {}),
    },
    outcome,
    ...(errorMessage ? { error_message: errorMessage } : {}),
    result_count: note ? 1 : 0,
  });
}

export function registerNoteTools(server: McpServer): void {
  registerReadOnlyTool(server, "list_notes", {
    description: "List a paginated set of notes on one Jobber client, request, quote, job, or invoice, including IDs and versions required for safe edits.",
    inputSchema: {
      record_type: parentTypeSchema,
      record_id: z.string().trim().min(1),
      page_size: z.number().int().min(1).max(NOTE_PAGE_CAP).default(20),
      cursor: z.string().optional(),
    },
    maxCost: NOTE_COST,
  }, async ({ record_type, record_id, page_size, cursor }: any, run) => {
    const page = await readNotePage(record_type, record_id, page_size, cursor, run);
    await appendAuditLog({ tool: "list_notes", args: { record_type, record_id, page_size, cursor }, outcome: "success", result_count: page.notes.length });
    return result({
      record_type,
      record_id,
      notes: page.notes,
      ...(page.hasNextPage ? { next_cursor: page.endCursor } : {}),
    });
  });

  if (isReadOnly() || !isWriteCapabilityEnabled("records")) return;

  registerWriteTool(server, "create_note", {
    description: "Create one text note on a reviewed Jobber client, request, quote, job, or invoice after approval. This does not change instructions and cannot attach files.",
    capability: "records",
    inputSchema: {
      record_type: parentTypeSchema,
      record_id: z.string().trim().min(1),
      message: noteMessageSchema,
      pinned: z.boolean().default(false),
      linked_to: linkedToSchema.optional(),
      confirm_write: z.literal(true),
    },
    maxCost: NOTE_COST,
    redactAuditErrors: true,
  }, async (args: any, run) => {
    validateLinks(args.record_type, args.linked_to);
    const before = await scanNotes(args.record_type, args.record_id, run);
    if (before.some((note) => noteMatchesCreate(note, args))) {
      throw new Error("An equivalent note already exists on this record; no duplicate note was created.");
    }

    const spec = createMutations[args.record_type as NoteParentType];
    const input: Node = { message: args.message, pinned: args.pinned };
    const linkedTo = linksForMutation(args.record_type, args.linked_to);
    if (linkedTo !== undefined) input.linkedTo = linkedTo;

    let data: Node;
    try {
      data = await run(spec.query, { recordId: args.record_id, input });
    } catch (error: any) {
      if (!(error instanceof JobberOutcomeUncertainError) && error?.name !== "JobberOutcomeUncertainError") throw error;
      let after: Node[];
      try {
        after = await scanNotes(args.record_type, args.record_id, run);
      } catch (reconcileError: any) {
        await auditNote("create_note", args, "error", undefined, "Mutation outcome uncertain");
        return result({
          action: "create",
          outcome: "uncertain",
          record_type: args.record_type,
          record_id: args.record_id,
          error: error.message,
          reconciliation_error: reconcileError?.message ?? String(reconcileError),
          guidance: "The mutation was not retried. Review this record's notes before requesting another write.",
        }, true);
      }
      const candidates = after.filter((note) => !before.some((existing) => existing.id === note.id) && noteMatchesCreate(note, args));
      if (candidates.length === 1) {
        await auditNote("create_note", args, "success", candidates[0]);
        return result({ action: "created", outcome: "created", verification: "reconciled_after_uncertain_response", record_type: args.record_type, record_id: args.record_id, note: candidates[0] });
      }
      await auditNote("create_note", args, "error", undefined, "Mutation outcome uncertain");
      return result({ action: "create", outcome: "uncertain", record_type: args.record_type, record_id: args.record_id, error: error.message, guidance: "The mutation was not retried. Review this record's notes before requesting another write." }, true);
    }

    const payload = data[spec.payload] ?? {};
    const returned = payload[spec.note] ? noteWithVersion(payload[spec.note]) : undefined;
    const userErrors = formatUserErrors(payload);
    let after: Node[];
    try {
      after = await scanNotes(args.record_type, args.record_id, run);
    } catch (error: any) {
      await auditNote("create_note", args, "partial", returned, "Created note could not be read back");
      return result({
        action: "create",
        outcome: "uncertain",
        record_type: args.record_type,
        record_id: args.record_id,
        ...(returned ? { note: returned } : {}),
        ...(userErrors.length ? { user_errors: userErrors } : {}),
        verification_error: error?.message ?? String(error),
        guidance: "The mutation was not retried. Review the record in Jobber before attempting another note write.",
      }, true);
    }
    const newMatches = after.filter((note) => !before.some((existing) => existing.id === note.id) && noteMatchesCreate(note, args));
    const verified = returned?.id ? after.find((note) => note.id === returned.id) : newMatches.length === 1 ? newMatches[0] : undefined;
    if (userErrors.length && !returned && !verified) throw rejected("creating note", userErrors);
    if (!verified || !noteMatchesCreate(verified, args)) {
      await auditNote("create_note", args, "partial", returned, "Created note could not be verified through readback");
      return result({ action: "create", outcome: returned ? "mismatch" : "uncertain", record_type: args.record_type, record_id: args.record_id, ...(returned ? { note: returned } : {}), ...(userErrors.length ? { user_errors: userErrors } : {}), guidance: "Review the record in Jobber before attempting another note write." }, true);
    }
    if (userErrors.length) {
      await auditNote("create_note", args, "partial", verified, "Jobber returned user errors alongside the created note");
      return result({ action: "created", outcome: "partial", record_type: args.record_type, record_id: args.record_id, note: verified, user_errors: userErrors }, true);
    }
    await auditNote("create_note", args, "success", verified);
    return result({ action: "created", outcome: "created", verification: "verified", record_type: args.record_type, record_id: args.record_id, note: verified });
  });

  registerWriteTool(server, "update_note", {
    description: "Edit the text, pinned state, or supported links of one reviewed Jobber note after approval. Attachments and deletion are unavailable.",
    capability: "records",
    inputSchema: {
      record_type: parentTypeSchema,
      record_id: z.string().trim().min(1),
      note_id: z.string().trim().min(1),
      expected_note_version: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      message: noteMessageSchema.optional(),
      pinned: z.boolean().optional(),
      linked_to: linkedToSchema.optional(),
      confirm_write: z.literal(true),
    },
    maxCost: NOTE_COST,
    redactAuditErrors: true,
  }, async (args: any, run) => {
    if (args.message === undefined && args.pinned === undefined && args.linked_to === undefined) {
      throw new Error("Provide at least one note field to update.");
    }
    validateLinks(args.record_type, args.linked_to);
    const before = await scanNotes(args.record_type, args.record_id, run);
    const current = before.find((note) => note.id === args.note_id);
    if (!current) throw new Error("The note does not belong to the selected Jobber record; no note was updated.");
    if (current.note_version !== args.expected_note_version) {
      throw new Error("The note changed since it was reviewed; list the notes again before updating.");
    }

    const spec = editMutations[args.record_type as NoteParentType];
    const input: Node = { noteId: args.note_id };
    if (args.message !== undefined) input.message = args.message;
    if (args.pinned !== undefined) input.pinned = args.pinned;
    const linkedTo = linksForMutation(args.record_type, args.linked_to);
    if (linkedTo !== undefined) input.linkedTo = linkedTo;

    let data: Node;
    try {
      data = await run(spec.query, { input });
    } catch (error: any) {
      if (!(error instanceof JobberOutcomeUncertainError) && error?.name !== "JobberOutcomeUncertainError") throw error;
      let after: Node[];
      try {
        after = await scanNotes(args.record_type, args.record_id, run);
      } catch (reconcileError: any) {
        await auditNote("update_note", args, "error", undefined, "Mutation outcome uncertain");
        return result({
          action: "update",
          outcome: "uncertain",
          record_type: args.record_type,
          record_id: args.record_id,
          note_id: args.note_id,
          error: error.message,
          reconciliation_error: reconcileError?.message ?? String(reconcileError),
          guidance: "The mutation was not retried. List the notes again before requesting another update.",
        }, true);
      }
      const reconciled = after.find((note) => note.id === args.note_id);
      if (reconciled && noteMatchesUpdate(reconciled, args)) {
        await auditNote("update_note", args, "success", reconciled);
        return result({ action: "updated", outcome: "updated", verification: "reconciled_after_uncertain_response", record_type: args.record_type, record_id: args.record_id, note: reconciled });
      }
      await auditNote("update_note", args, "error", reconciled, "Mutation outcome uncertain");
      return result({ action: "update", outcome: "uncertain", record_type: args.record_type, record_id: args.record_id, ...(reconciled ? { note: reconciled } : {}), error: error.message, guidance: "The mutation was not retried. List the notes again before requesting another update." }, true);
    }

    const payload = data[spec.payload] ?? {};
    const returned = payload[spec.note] ? noteWithVersion(payload[spec.note]) : undefined;
    const userErrors = formatUserErrors(payload);
    let after: Node[];
    try {
      after = await scanNotes(args.record_type, args.record_id, run);
    } catch (error: any) {
      await auditNote("update_note", args, "partial", returned, "Updated note could not be read back");
      return result({
        action: "update",
        outcome: "uncertain",
        record_type: args.record_type,
        record_id: args.record_id,
        note_id: args.note_id,
        ...(returned ? { note: returned } : {}),
        ...(userErrors.length ? { user_errors: userErrors } : {}),
        verification_error: error?.message ?? String(error),
        guidance: "The mutation was not retried. Review the note in Jobber before attempting another update.",
      }, true);
    }
    const verified = after.find((note) => note.id === args.note_id);
    if (userErrors.length && !returned && (!verified || !noteMatchesUpdate(verified, args))) {
      throw rejected("updating note", userErrors);
    }
    if (!verified || !noteMatchesUpdate(verified, args)) {
      await auditNote("update_note", args, "partial", returned ?? verified, "Updated note could not be verified through readback");
      return result({ action: "update", outcome: returned || verified ? "mismatch" : "uncertain", record_type: args.record_type, record_id: args.record_id, ...(returned || verified ? { note: returned ?? verified } : {}), ...(userErrors.length ? { user_errors: userErrors } : {}), guidance: "Review the note in Jobber before attempting another update." }, true);
    }
    if (userErrors.length) {
      await auditNote("update_note", args, "partial", verified, "Jobber returned user errors alongside the updated note");
      return result({ action: "updated", outcome: "partial", record_type: args.record_type, record_id: args.record_id, note: verified, user_errors: userErrors }, true);
    }
    await auditNote("update_note", args, "success", verified);
    return result({ action: "updated", outcome: "updated", verification: "verified", record_type: args.record_type, record_id: args.record_id, note: verified });
  });
}
