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

import { registerUpdateClientCompanyNameTool } from "../update-client-company-name.js";

const previousReadOnly = process.env.JOBBER_READ_ONLY;
process.env.JOBBER_READ_ONLY = "false";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerUpdateClientCompanyNameTool(fakeServer as any);
  if (previousReadOnly === undefined) delete process.env.JOBBER_READ_ONLY;
  else process.env.JOBBER_READ_ONLY = previousReadOnly;
});

beforeEach(() => vi.clearAllMocks());

describe("update_client_company_name", () => {
  it("uses the fixed clientEdit mutation and returns the updated client", async () => {
    mockJobberGraphQLWrite.mockResolvedValue({
      clientEdit: { client: { id: "gid://Jobber/Client/1", name: "Ada Lovelace", companyName: "Analytical Co" }, userErrors: [] },
    });

    const result = await handlers.update_client_company_name({
      client_id: "gid://Jobber/Client/1",
      company_name: "Analytical Co",
      confirm_write: true,
    });

    expect(mockJobberGraphQLWrite).toHaveBeenCalledWith(
      expect.stringContaining("clientEdit"),
      { clientId: "gid://Jobber/Client/1", input: { companyName: "Analytical Co" } },
      100
    );
    expect(JSON.parse(result.content[0].text)).toEqual({
      client: { id: "gid://Jobber/Client/1", name: "Ada Lovelace", company_name: "Analytical Co" },
    });
  });

  it("returns an error when Jobber rejects the update", async () => {
    mockJobberGraphQLWrite.mockResolvedValue({
      clientEdit: { client: null, userErrors: [{ message: "client not found", path: ["clientId"] }] },
    });

    const result = await handlers.update_client_company_name({
      client_id: "gid://Jobber/Client/missing",
      company_name: "Analytical Co",
      confirm_write: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("client not found");
  });
});
