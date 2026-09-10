import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";

const { mockAppendAuditLog } = vi.hoisted(() => ({
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { mockJobberGraphQL, mockJobberGraphQLWrite } = vi.hoisted(() => ({
  mockJobberGraphQL: vi.fn().mockResolvedValue({ ok: true }),
  mockJobberGraphQLWrite: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

vi.mock("../jobber/client.js", () => ({
  jobberGraphQL: mockJobberGraphQL,
  jobberGraphQLWrite: mockJobberGraphQLWrite,
}));

import { isReadOnly, pageSizeSchema, pageProgress, registerReadOnlyTool, registerWriteTool } from "../tool-helpers.js";

const ORIGINAL_READ_ONLY = process.env.JOBBER_READ_ONLY;
const ORIGINAL_WRITE_CAPABILITIES = process.env.JOBBER_WRITE_CAPABILITIES;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_READ_ONLY === undefined) delete process.env.JOBBER_READ_ONLY;
  else process.env.JOBBER_READ_ONLY = ORIGINAL_READ_ONLY;
  if (ORIGINAL_WRITE_CAPABILITIES === undefined) delete process.env.JOBBER_WRITE_CAPABILITIES;
  else process.env.JOBBER_WRITE_CAPABILITIES = ORIGINAL_WRITE_CAPABILITIES;
});

describe("isReadOnly", () => {
  it("defaults to true when JOBBER_READ_ONLY is unset", () => {
    delete process.env.JOBBER_READ_ONLY;
    expect(isReadOnly()).toBe(true);
  });

  it("is false only when explicitly set to 'false'", () => {
    process.env.JOBBER_READ_ONLY = "false";
    expect(isReadOnly()).toBe(false);
  });

  it("is case-insensitive for 'false'", () => {
    process.env.JOBBER_READ_ONLY = "FALSE";
    expect(isReadOnly()).toBe(false);
  });

  it("is true for any other value", () => {
    process.env.JOBBER_READ_ONLY = "nope";
    expect(isReadOnly()).toBe(true);
  });
});

describe("pageSizeSchema", () => {
  it("defaults to min(20, cap) when omitted", () => {
    expect(pageSizeSchema(50).parse(undefined)).toBe(20);
    expect(pageSizeSchema(10).parse(undefined)).toBe(10);
  });

  it("accepts a value within the cap", () => {
    expect(pageSizeSchema(50).parse(35)).toBe(35);
  });

  it("rejects a value above the cap", () => {
    expect(() => pageSizeSchema(50).parse(51)).toThrow();
  });

  it("rejects zero or negative values", () => {
    expect(() => pageSizeSchema(50).parse(0)).toThrow();
    expect(() => pageSizeSchema(50).parse(-1)).toThrow();
  });

  it("rejects non-integer values", () => {
    expect(() => pageSizeSchema(50).parse(1.5)).toThrow();
  });
});

describe("pageProgress", () => {
  it("accumulates returned_so_far and computes remaining against totalCount", () => {
    expect(pageProgress(50, 20, 0)).toEqual({ returned_so_far: 20, remaining: 30 });
    expect(pageProgress(50, 20, 20)).toEqual({ returned_so_far: 40, remaining: 10 });
  });

  it("clamps remaining to 0 rather than going negative when previousReturned overshoots totalCount", () => {
    // A caller can echo back a stale/wrong returned_so_far (e.g. mixed up between two cursors,
    // or totalCount shrank between calls) - remaining must never go negative from that.
    expect(pageProgress(10, 5, 20)).toEqual({ returned_so_far: 25, remaining: 0 });
  });

  it("returns remaining 0 exactly at totalCount", () => {
    expect(pageProgress(20, 0, 20)).toEqual({ returned_so_far: 20, remaining: 0 });
  });
});

function fakeServer() {
  const handlers: Record<string, (args?: any) => Promise<any>> = {};
  const registeredConfig: Record<string, any> = {};
  return {
    handlers,
    registeredConfig,
    registerTool: vi.fn((name: string, config: any, handler: (args?: any) => Promise<any>) => {
      registeredConfig[name] = config;
      handlers[name] = handler;
    }),
  };
}

describe("registerReadOnlyTool", () => {
  it("registers the tool with the given description and an input schema that validates the same shape", () => {
    const server = fakeServer();
    const schema = { search_term: z.string() };
    registerReadOnlyTool(
      server as any,
      "find_client",
      { description: "Find a client", inputSchema: schema, maxCost: 100 },
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );
    const [name, config] = server.registerTool.mock.calls[0];
    expect(name).toBe("find_client");
    expect(config.description).toBe("Find a client");
    // registerReadOnlyTool wraps the raw shape in an audited z.object(...) rather than passing it
    // through unchanged (see auditValidationFailures) - assert it still behaves like the same
    // schema (advertises/validates the same fields) rather than asserting reference identity.
    expect(config.inputSchema.parse({ search_term: "Acme" })).toEqual({ search_term: "Acme" });
    expect(() => config.inputSchema.parse({})).toThrow();
  });

  it("audit-logs a shape-invalid call even though the SDK rejects it before the handler runs", async () => {
    const server = fakeServer();
    registerReadOnlyTool(
      server as any,
      "find_client",
      { description: "Find a client", inputSchema: { search_term: z.string().min(1) }, maxCost: 100 },
      async () => ({ content: [{ type: "text", text: "should never run" }] })
    );
    const [, config] = server.registerTool.mock.calls[0];
    const result = await (config.inputSchema as any)["~standard"].validate({});
    expect(result.issues).toBeDefined();
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "find_client", outcome: "error" })
    );
  });

  it("passes through a successful handler result unchanged", async () => {
    const server = fakeServer();
    registerReadOnlyTool(
      server as any,
      "find_client",
      { description: "x", maxCost: 100 },
      async () => ({ content: [{ type: "text", text: "success payload" }] })
    );
    const result = await server.handlers["find_client"]({});
    expect(result.content[0].text).toBe("success payload");
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("catches a thrown error, logs it, and returns an isError result", async () => {
    const server = fakeServer();
    registerReadOnlyTool(
      server as any,
      "find_client",
      { description: "x", maxCost: 100 },
      async () => {
        throw new Error("upstream failure");
      }
    );
    const result = await server.handlers["find_client"]({ search_term: "Acme" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("upstream failure");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "find_client", outcome: "error", error_message: "upstream failure", args: { search_term: "Acme" } })
    );
  });
});

describe("registerReadOnlyTool cost enforcement", () => {
  it("binds a numeric maxCost into the query-runner passed to the handler", async () => {
    const server = fakeServer();
    registerReadOnlyTool(
      server as any,
      "overdue_invoices",
      { description: "x", maxCost: 250 },
      async (_args, jobberGraphQL) => {
        const data = await jobberGraphQL("query { x }", { first: 20 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );
    await server.handlers["overdue_invoices"]({});
    expect(mockJobberGraphQL).toHaveBeenCalledWith("query { x }", { first: 20 }, 250);
  });

  it("binds a record maxCost, forwarding the value for the requested cost key", async () => {
    const server = fakeServer();
    registerReadOnlyTool(
      server as any,
      "client_history",
      { description: "x", maxCost: { main: 50, paymentsPage: 20 } },
      async (_args, jobberGraphQL) => {
        const data = await jobberGraphQL("query { payments }", { invoiceId: "1" }, "paymentsPage");
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );
    await server.handlers["client_history"]({});
    expect(mockJobberGraphQL).toHaveBeenCalledWith("query { payments }", { invoiceId: "1" }, 20);
  });

  it("errors instead of silently calling jobberGraphQL when an undeclared cost key is requested", async () => {
    const server = fakeServer();
    registerReadOnlyTool(
      server as any,
      "client_history",
      { description: "x", maxCost: { main: 50, paymentsPage: 20 } },
      async (_args, jobberGraphQL) => {
        const data = await (jobberGraphQL as any)("query { x }", {}, "nonexistent");
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );
    const result = await server.handlers["client_history"]({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no maxCost declared for cost key "nonexistent"');
    expect(mockJobberGraphQL).not.toHaveBeenCalled();
  });
});

describe("registerWriteTool", () => {
  it("throws immediately and never registers when JOBBER_READ_ONLY is true", () => {
    process.env.JOBBER_READ_ONLY = "true";
    const server = fakeServer();
    expect(() =>
      registerWriteTool(server as any, "delete_client", { description: "x", capability: "records", maxCost: 100 }, async () => ({
        content: [{ type: "text", text: "should never run" }],
      }))
    ).toThrow(/JOBBER_READ_ONLY/);
    expect(server.registerTool).not.toHaveBeenCalled();
  });

  it("registers normally when JOBBER_READ_ONLY is false and uses the mutation executor", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    const server = fakeServer();
    registerWriteTool(server as any, "delete_client", { description: "x", capability: "records", maxCost: 100 }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    expect(server.registerTool).toHaveBeenCalledWith("delete_client", expect.anything(), expect.any(Function));
    await server.handlers["delete_client"]({});
    expect(mockJobberGraphQLWrite).not.toHaveBeenCalled();
    expect(mockJobberGraphQL).not.toHaveBeenCalled();
  });

  it("binds write handlers to the mutation executor instead of the retrying read executor", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    const server = fakeServer();
    registerWriteTool(
      server as any,
      "create_client",
      { description: "x", capability: "records", maxCost: 100 },
      async (_args, jobberGraphQL) => {
        const data = await jobberGraphQL("mutation { createClient { id } }", { input: {} });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );
    await server.handlers["create_client"]({});
    expect(mockJobberGraphQLWrite).toHaveBeenCalledWith(
      "mutation { createClient { id } }",
      { input: {} },
      100
    );
    expect(mockJobberGraphQL).not.toHaveBeenCalled();
  });
});
