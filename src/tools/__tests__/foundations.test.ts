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

import { registerFoundationalTools } from "../foundations.js";

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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalReadOnly === undefined) delete process.env.JOBBER_READ_ONLY;
  else process.env.JOBBER_READ_ONLY = originalReadOnly;
  if (originalCapabilities === undefined) delete process.env.JOBBER_WRITE_CAPABILITIES;
  else process.env.JOBBER_WRITE_CAPABILITIES = originalCapabilities;
});

describe("foundational operations", () => {
  it("keeps the foundational read set available and annotated in the safe default", () => {
    delete process.env.JOBBER_READ_ONLY;
    delete process.env.JOBBER_WRITE_CAPABILITIES;
    const server = fakeServer();

    registerFoundationalTools(server as any);

    expect(Object.keys(server.handlers)).toEqual(["search_records", "get_record", "catalog_search", "team_list"]);
    for (const config of Object.values(server.configs)) {
      expect(config.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
  });

  it("only exposes writes for explicitly enabled capabilities", () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    const server = fakeServer();

    registerFoundationalTools(server as any);

    expect(server.handlers.create_client).toBeTypeOf("function");
    expect(server.handlers.create_draft_quote).toBeTypeOf("function");
    expect(server.handlers.create_visit).toBeUndefined();
    expect(server.handlers.mark_invoice_sent).toBeUndefined();
    expect(server.configs.create_client.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it("uses truthful status-only names for communication transitions", () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "communications";
    const server = fakeServer();
    registerFoundationalTools(server as any);

    expect(server.handlers.mark_quote_sent).toBeTypeOf("function");
    expect(server.handlers.mark_invoice_sent).toBeTypeOf("function");
    expect(server.handlers.send_quote).toBeUndefined();
    expect(server.handlers.send_invoice).toBeUndefined();
  });

  it("requires literal confirmation on every registered write", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records,scheduling,communications";
    const server = fakeServer();
    registerFoundationalTools(server as any);

    for (const [name, config] of Object.entries(server.configs)) {
      if (config.annotations?.readOnlyHint !== false) continue;
      const result = await config.inputSchema["~standard"].validate({ confirm_write: false });
      expect(result.issues, name).toBeDefined();
      expect(config.annotations).toMatchObject({ openWorldHint: true, idempotentHint: false });
    }
  });

  it("paginates properties without returning more than page_size", async () => {
    mockRead.mockResolvedValue({
      clients: {
        nodes: [{ id: "client-1", name: "Client", properties: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] }],
        pageInfo: { hasNextPage: false, endCursor: "client-1-cursor" },
      },
    });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const first = JSON.parse((await server.handlers.search_records({ record_type: "property", page_size: 2 })).content[0].text);
    const second = JSON.parse((await server.handlers.search_records({ record_type: "property", page_size: 2, cursor: first.next_cursor, returned_so_far: 2 })).content[0].text);

    expect(first.records.map((record: any) => record.id)).toEqual(["p1", "p2"]);
    expect(second.records.map((record: any) => record.id)).toEqual(["p3"]);
    expect(second.returned_so_far).toBe(3);
    expect(second.next_cursor).toBeUndefined();
  });

  it("returns the sole created property, rather than Jobber's enclosing list", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    mockWrite
      .mockResolvedValueOnce({ client: { id: "client-1", properties: [] } })
      .mockResolvedValueOnce({
        propertyCreate: { userErrors: [], properties: [{ id: "property-1", name: "Test property" }] },
      });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_property({
      client_id: "client-1",
      address: { street1: "1 Test Street", city: "Toronto" },
      confirm_write: true,
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text).record).toMatchObject({ id: "property-1" });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create_property",
      args: expect.objectContaining({ action: "create_property", record_type: "property", record_id: "property-1", changed_fields: ["address"] }),
    }));
  });

  it("refuses a multi-property response as an ambiguous outcome", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    mockWrite
      .mockResolvedValueOnce({ client: { id: "client-1", properties: [] } })
      .mockResolvedValueOnce({
        propertyCreate: { userErrors: [], properties: [{ id: "property-1" }, { id: "property-2" }] },
      });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_property({
      client_id: "client-1",
      address: { street1: "1 Test Street", city: "Toronto" },
      confirm_write: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unexpected number of records");
  });

  it("rejects a property that does not belong to a request client before mutating", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    mockWrite.mockResolvedValueOnce({ client: { id: "client-1", properties: [], requests: { nodes: [] } } });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_request({ client_id: "client-1", property_id: "other-property", confirm_write: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not belong");
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("refuses a multi-aspect visit update before any partial mutation", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const visit = {
      id: "visit-1", title: "Original", visitStatus: "SCHEDULED", isComplete: false,
      completedAt: null, startAt: null, endAt: null, instructions: null,
      job: { id: "job-1" }, client: { id: "client-1" }, assignedUsers: { nodes: [] },
    };
    mockRead.mockResolvedValueOnce({ visit });
    const server = fakeServer();
    registerFoundationalTools(server as any);
    const read = JSON.parse((await server.handlers.get_record({ record_type: "visit", record_id: "visit-1" })).content[0].text);
    mockWrite.mockResolvedValueOnce({ visit });

    const result = await server.handlers.update_visit({
      visit_id: "visit-1", expected_record_version: read.record_version,
      title: "Changed", assigned_user_ids: ["user-1"], confirm_write: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exactly one visit aspect");
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });
});
