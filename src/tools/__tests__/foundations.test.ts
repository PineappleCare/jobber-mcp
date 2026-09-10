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
    expect(server.handlers.send_invoice).toBeUndefined();
    expect(server.configs.create_client.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it("returns the sole created property, rather than Jobber's enclosing list", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    mockWrite.mockResolvedValueOnce({
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
  });

  it("refuses a multi-property response as an ambiguous outcome", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    mockWrite.mockResolvedValueOnce({
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
});
