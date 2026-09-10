import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockJobberGraphQLWrite, mockAppendAuditLog } = vi.hoisted(() => ({
  mockJobberGraphQLWrite: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({
  jobberGraphQL: vi.fn(),
  jobberGraphQLWrite: mockJobberGraphQLWrite,
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerCreateClientTool } from "../create-client.js";

const previousReadOnly = process.env.JOBBER_READ_ONLY;
process.env.JOBBER_READ_ONLY = "false";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerCreateClientTool(fakeServer as any);
  if (previousReadOnly === undefined) delete process.env.JOBBER_READ_ONLY;
  else process.env.JOBBER_READ_ONLY = previousReadOnly;
});

beforeEach(() => vi.clearAllMocks());

describe("create_client", () => {
  it("uses the fixed clientCreate mutation with only the approved basic fields", async () => {
    mockJobberGraphQLWrite.mockResolvedValue({
      clientCreate: { client: { id: "gid://Jobber/Client/1", name: "Ada Lovelace", companyName: "Analytical Co" }, userErrors: [] },
    });

    const result = await handlers.create_client({
      first_name: "Ada",
      last_name: "Lovelace",
      company_name: "Analytical Co",
      confirm_create: true,
    });

    expect(mockJobberGraphQLWrite).toHaveBeenCalledWith(
      expect.stringContaining("clientCreate"),
      { input: { firstName: "Ada", lastName: "Lovelace", companyName: "Analytical Co" } },
      100
    );
    expect(JSON.parse(result.content[0].text)).toEqual({
      client: { id: "gid://Jobber/Client/1", name: "Ada Lovelace", company_name: "Analytical Co" },
    });
  });

  it("does not send an undefined optional company name", async () => {
    mockJobberGraphQLWrite.mockResolvedValue({
      clientCreate: { client: { id: "gid://Jobber/Client/2", name: "Ada Lovelace", companyName: null }, userErrors: [] },
    });

    await handlers.create_client({ first_name: "Ada", last_name: "Lovelace", confirm_create: true });

    expect(mockJobberGraphQLWrite).toHaveBeenCalledWith(
      expect.any(String),
      { input: { firstName: "Ada", lastName: "Lovelace" } },
      100
    );
  });

  it("returns an error rather than claiming success when Jobber returns user errors", async () => {
    mockJobberGraphQLWrite.mockResolvedValue({
      clientCreate: { client: null, userErrors: [{ message: "firstName is invalid", path: ["input", "firstName"] }] },
    });

    const result = await handlers.create_client({ first_name: "Ada", last_name: "Lovelace", confirm_create: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("firstName is invalid");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ tool: "create_client", outcome: "error" }));
  });
});
