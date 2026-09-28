import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRead, mockWrite, mockAudit } = vi.hoisted(() => ({
  mockRead: vi.fn(),
  mockWrite: vi.fn(),
  mockAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({
  jobberGraphQL: mockRead,
  jobberGraphQLWrite: mockWrite,
}));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAudit }));

import { JobberOutcomeUncertainError } from "../../jobber/errors.js";
import { registerNoteTools } from "../notes.js";

const originalReadOnly = process.env.JOBBER_READ_ONLY;
const originalCapabilities = process.env.JOBBER_WRITE_CAPABILITIES;

function fakeServer() {
  const handlers: Record<string, (args?: any) => Promise<any>> = {};
  const configs: Record<string, any> = {};
  return {
    handlers,
    configs,
    registerTool(name: string, config: any, handler: (args?: any) => Promise<any>) {
      configs[name] = config;
      handlers[name] = handler;
    },
  };
}

function note(overrides: Record<string, unknown> = {}) {
  return {
    id: "note-1",
    message: "Site details from the customer",
    createdAt: "2026-09-28T12:00:00Z",
    lastEditedAt: null,
    pinned: false,
    linkedTo: { requests: false, quotes: false, jobs: false, invoices: false },
    ...overrides,
  };
}

function notePage(recordType: string, notes: any[], hasNextPage = false, endCursor: string | null = null) {
  return {
    [recordType]: {
      id: `${recordType}-1`,
      notes: { nodes: notes, pageInfo: { hasNextPage, endCursor } },
    },
  };
}

const mutationShape: Record<string, [string, string]> = {
  client: ["clientCreateNote", "clientNote"],
  request: ["requestCreateNote", "requestNote"],
  quote: ["quoteCreateNote", "quoteNote"],
  job: ["jobCreateNote", "jobNote"],
  invoice: ["invoiceCreateNote", "invoiceNote"],
};

beforeEach(() => {
  process.env.JOBBER_READ_ONLY = "false";
  process.env.JOBBER_WRITE_CAPABILITIES = "records";
  mockRead.mockReset();
  mockWrite.mockReset();
  mockAudit.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalReadOnly === undefined) delete process.env.JOBBER_READ_ONLY;
  else process.env.JOBBER_READ_ONLY = originalReadOnly;
  if (originalCapabilities === undefined) delete process.env.JOBBER_WRITE_CAPABILITIES;
  else process.env.JOBBER_WRITE_CAPABILITIES = originalCapabilities;
});

describe("Jobber notes", () => {
  it("keeps list_notes read-only and withholds note mutations by default", () => {
    process.env.JOBBER_READ_ONLY = "true";
    const server = fakeServer();
    registerNoteTools(server as any);

    expect(server.handlers.list_notes).toBeTypeOf("function");
    expect(server.configs.list_notes.annotations).toMatchObject({ readOnlyHint: true });
    expect(server.handlers.create_note).toBeUndefined();
    expect(server.handlers.update_note).toBeUndefined();
  });

  it("lists versioned notes and returns the next cursor", async () => {
    mockRead.mockResolvedValueOnce(notePage("job", [note()], true, "next-page"));
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.list_notes({ record_type: "job", record_id: "job-1", page_size: 20 });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.next_cursor).toBe("next-page");
    expect(payload.notes[0]).toMatchObject({ id: "note-1", note_version: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ tool: "list_notes", outcome: "success", result_count: 1 }));
  });

  for (const recordType of ["client", "request", "quote", "job", "invoice"]) {
    it(`creates and verifies a ${recordType} note`, async () => {
      const created = note({ id: `${recordType}-note`, pinned: true });
      const [payloadName, noteName] = mutationShape[recordType];
      mockRead
        .mockResolvedValueOnce(notePage(recordType, []))
        .mockResolvedValueOnce(notePage(recordType, [created]));
      mockWrite.mockResolvedValueOnce({ [payloadName]: { [noteName]: created, userErrors: [] } });
      const server = fakeServer();
      registerNoteTools(server as any);

      const response = await server.handlers.create_note({
        record_type: recordType,
        record_id: `${recordType}-1`,
        message: created.message,
        pinned: true,
        confirm_write: true,
      });
      const payload = JSON.parse(response.content[0].text);

      expect(response.isError).not.toBe(true);
      expect(payload).toMatchObject({ outcome: "created", verification: "verified", note: { id: `${recordType}-note`, pinned: true } });
      expect(mockWrite).toHaveBeenCalledTimes(1);
    });

    it(`updates and verifies a ${recordType} note`, async () => {
      const before = note({ id: `${recordType}-note` });
      const after = note({ id: `${recordType}-note`, message: "Corrected\nexact text", lastEditedAt: "2026-09-28T13:00:00Z" });
      const editPayload = `${recordType}EditNote`;
      const editNote = `${recordType}Note`;
      mockRead.mockResolvedValueOnce(notePage(recordType, [before]));
      const server = fakeServer();
      registerNoteTools(server as any);
      const listed = JSON.parse((await server.handlers.list_notes({ record_type: recordType, record_id: `${recordType}-1`, page_size: 20 })).content[0].text);
      mockRead.mockResolvedValueOnce(notePage(recordType, [before])).mockResolvedValueOnce(notePage(recordType, [after]));
      mockWrite.mockResolvedValueOnce({ [editPayload]: { [editNote]: after, userErrors: [] } });

      const response = await server.handlers.update_note({
        record_type: recordType,
        record_id: `${recordType}-1`,
        note_id: `${recordType}-note`,
        expected_note_version: listed.notes[0].note_version,
        message: "Corrected\nexact text",
        confirm_write: true,
      });

      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text)).toMatchObject({ outcome: "updated", note: { message: "Corrected\nexact text" } });
      expect(mockWrite.mock.calls[0][1].input.message).toBe("Corrected\nexact text");
    });
  }

  it.each([true, false])("rejects unsupported note links even when set to %s", async (enabled) => {
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.create_note({
      record_type: "job",
      record_id: "job-1",
      message: "Do not create",
      pinned: false,
      linked_to: { requests: enabled },
      confirm_write: true,
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("job notes cannot link to: requests");
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("finds an exact equivalent note beyond the first page and refuses a duplicate", async () => {
    mockRead
      .mockResolvedValueOnce(notePage("job", [note({ id: "other", message: "Other" })], true, "next"))
      .mockResolvedValueOnce(notePage("job", [note()], false));
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.create_note({
      record_type: "job",
      record_id: "job-1",
      message: "Site details from the customer",
      pinned: false,
      confirm_write: true,
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("equivalent note already exists");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("does not collapse meaningful text differences when checking duplicates", async () => {
    const existing = note();
    const created = note({ id: "new-unlinked-note", message: "SITE details\nfrom the customer" });
    mockRead
      .mockResolvedValueOnce(notePage("job", [existing]))
      .mockResolvedValueOnce(notePage("job", [existing, created]));
    mockWrite.mockResolvedValueOnce({ jobCreateNote: { jobNote: created, userErrors: [] } });
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.create_note({
      record_type: "job",
      record_id: "job-1",
      message: created.message,
      pinned: false,
      confirm_write: true,
    });

    expect(response.isError).not.toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ outcome: "created", note: { id: "new-unlinked-note" } });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][1].input).not.toHaveProperty("linkedTo");
  });

  it("does not treat a linked note as a duplicate of an unlinked create", async () => {
    const existing = note({ linkedTo: { requests: false, quotes: false, jobs: false, invoices: true } });
    const created = note({ id: "same-text-unlinked" });
    mockRead
      .mockResolvedValueOnce(notePage("job", [existing]))
      .mockResolvedValueOnce(notePage("job", [existing, created]));
    mockWrite.mockResolvedValueOnce({ jobCreateNote: { jobNote: created, userErrors: [] } });
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.create_note({
      record_type: "job",
      record_id: "job-1",
      message: created.message,
      pinned: false,
      confirm_write: true,
    });

    expect(response.isError).not.toBe(true);
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("passes supported link changes exactly and verifies them", async () => {
    const before = note();
    const after = note({
      linkedTo: { requests: false, quotes: false, jobs: false, invoices: true },
      lastEditedAt: "2026-09-28T13:00:00Z",
    });
    mockRead.mockResolvedValueOnce(notePage("job", [before]));
    const server = fakeServer();
    registerNoteTools(server as any);
    const listed = JSON.parse((await server.handlers.list_notes({
      record_type: "job", record_id: "job-1", page_size: 20,
    })).content[0].text);
    mockRead.mockResolvedValueOnce(notePage("job", [before])).mockResolvedValueOnce(notePage("job", [after]));
    mockWrite.mockResolvedValueOnce({ jobEditNote: { jobNote: after, userErrors: [] } });

    const response = await server.handlers.update_note({
      record_type: "job",
      record_id: "job-1",
      note_id: "note-1",
      expected_note_version: listed.notes[0].note_version,
      linked_to: { invoices: true },
      confirm_write: true,
    });

    expect(response.isError).not.toBe(true);
    expect(mockWrite.mock.calls[0][1].input.linkedTo).toEqual({ invoices: true });
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      outcome: "updated",
      note: { linkedTo: { invoices: true } },
    });
  });

  it("updates a reviewed note and verifies the readback", async () => {
    const before = note();
    const after = note({ message: "Corrected details", pinned: true, lastEditedAt: "2026-09-28T13:00:00Z" });
    mockRead.mockResolvedValueOnce(notePage("job", [before]));
    mockWrite.mockResolvedValueOnce({ jobEditNote: { jobNote: after, userErrors: [] } });
    const server = fakeServer();
    registerNoteTools(server as any);
    const listed = JSON.parse((await server.handlers.list_notes({ record_type: "job", record_id: "job-1", page_size: 20 })).content[0].text);

    mockRead.mockResolvedValueOnce(notePage("job", [before])).mockResolvedValueOnce(notePage("job", [after]));
    const response = await server.handlers.update_note({
      record_type: "job",
      record_id: "job-1",
      note_id: "note-1",
      expected_note_version: listed.notes[0].note_version,
      message: "Corrected details",
      pinned: true,
      confirm_write: true,
    });

    expect(response.isError).not.toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ outcome: "updated", note: { message: "Corrected details", pinned: true } });
  });

  it("rejects stale and wrong-parent note edits without mutation", async () => {
    const server = fakeServer();
    registerNoteTools(server as any);
    mockRead.mockResolvedValueOnce(notePage("job", [note()]));
    const stale = await server.handlers.update_note({
      record_type: "job", record_id: "job-1", note_id: "note-1",
      expected_note_version: `sha256:${"0".repeat(64)}`, message: "Changed", confirm_write: true,
    });
    mockRead.mockResolvedValueOnce(notePage("job", [note()]));
    const wrongParent = await server.handlers.update_note({
      record_type: "job", record_id: "job-1", note_id: "foreign-note",
      expected_note_version: `sha256:${"0".repeat(64)}`, message: "Changed", confirm_write: true,
    });

    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toContain("changed since it was reviewed");
    expect(wrongParent.isError).toBe(true);
    expect(wrongParent.content[0].text).toContain("does not belong");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("reconciles an uncertain create without repeating the mutation", async () => {
    const created = note({ id: "created-after-timeout" });
    mockRead.mockResolvedValueOnce(notePage("job", []));
    mockWrite.mockRejectedValueOnce(new JobberOutcomeUncertainError("timeout"));
    mockRead.mockResolvedValueOnce(notePage("job", [created]));
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.create_note({
      record_type: "job", record_id: "job-1", message: created.message,
      pinned: false, confirm_write: true,
    });

    expect(JSON.parse(response.content[0].text)).toMatchObject({ outcome: "created", verification: "reconciled_after_uncertain_response", note: { id: "created-after-timeout" } });
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("returns partial evidence when Jobber reports an error with a created note", async () => {
    const created = note({ id: "partial-note" });
    mockRead.mockResolvedValueOnce(notePage("job", [])).mockResolvedValueOnce(notePage("job", [created]));
    mockWrite.mockResolvedValueOnce({ jobCreateNote: { jobNote: created, userErrors: [{ message: "Warning", path: [] }] } });
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.create_note({
      record_type: "job", record_id: "job-1", message: created.message,
      pinned: false, confirm_write: true,
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ outcome: "partial", note: { id: "partial-note" }, user_errors: [{ message: "Warning" }] });
  });

  it("returns an uncertain result without retrying when create readback fails", async () => {
    const created = note({ id: "created-before-readback-failure" });
    mockRead.mockResolvedValueOnce(notePage("job", [])).mockRejectedValueOnce(new Error("readback unavailable"));
    mockWrite.mockResolvedValueOnce({ jobCreateNote: { jobNote: created, userErrors: [] } });
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.create_note({
      record_type: "job", record_id: "job-1", message: created.message,
      pinned: false, confirm_write: true,
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      outcome: "uncertain",
      note: { id: "created-before-readback-failure" },
      verification_error: "readback unavailable",
    });
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous update uncertain when reconciliation also fails", async () => {
    const before = note();
    mockRead.mockResolvedValueOnce(notePage("job", [before]));
    const server = fakeServer();
    registerNoteTools(server as any);
    const listed = JSON.parse((await server.handlers.list_notes({ record_type: "job", record_id: "job-1", page_size: 20 })).content[0].text);
    mockRead.mockResolvedValueOnce(notePage("job", [before])).mockRejectedValueOnce(new Error("reconciliation unavailable"));
    mockWrite.mockRejectedValueOnce(new JobberOutcomeUncertainError("mutation timed out"));

    const response = await server.handlers.update_note({
      record_type: "job", record_id: "job-1", note_id: "note-1",
      expected_note_version: listed.notes[0].note_version,
      message: "Changed", confirm_write: true,
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      outcome: "uncertain",
      error: "mutation timed out",
      reconciliation_error: "reconciliation unavailable",
    });
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("keeps a definite Jobber rejection distinct from an uncertain outcome", async () => {
    mockRead.mockResolvedValueOnce(notePage("job", [])).mockResolvedValueOnce(notePage("job", []));
    mockWrite.mockResolvedValueOnce({ jobCreateNote: { jobNote: null, userErrors: [{ message: "Notes are unavailable", path: ["input"] }] } });
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.create_note({
      record_type: "job", record_id: "job-1", message: "Exact text",
      pinned: false, confirm_write: true,
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ outcome: "error", error_type: "jobber_rejected" });
    expect(response.content[0].text).toContain("Notes are unavailable");
  });

  it("does not persist upstream error details that could echo note text", async () => {
    const secretMessage = "Customer-private note body";
    mockRead.mockRejectedValueOnce(new Error(`Jobber rejected ${secretMessage}`));
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.create_note({
      record_type: "job",
      record_id: "job-1",
      message: secretMessage,
      pinned: false,
      confirm_write: true,
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain(secretMessage);
    const auditEntry = mockAudit.mock.calls.at(-1)?.[0];
    expect(auditEntry.error_message).toBe("Error: details omitted for sensitive input");
    expect(auditEntry.error_message).not.toContain(secretMessage);
  });

  it("preserves the exact approved note text instead of trimming it", async () => {
    const message = "  First line\nsecond line  ";
    const created = note({ message });
    mockRead.mockResolvedValueOnce(notePage("job", [])).mockResolvedValueOnce(notePage("job", [created]));
    mockWrite.mockResolvedValueOnce({ jobCreateNote: { jobNote: created, userErrors: [] } });
    const server = fakeServer();
    registerNoteTools(server as any);

    const response = await server.handlers.create_note({ record_type: "job", record_id: "job-1", message, pinned: false, confirm_write: true });

    expect(response.isError).not.toBe(true);
    expect(mockWrite.mock.calls[0][1].input.message).toBe(message);
  });
});
