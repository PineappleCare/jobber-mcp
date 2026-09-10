import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerWriteTool } from "../tool-helpers.js";
import { CREATE_CLIENT_MUTATION } from "../jobber/queries.js";
import { appendAuditLog } from "../utils/auditLog.js";

// This is intentionally conservative until it has been measured against the
// Williams Jobber account. Its budget is enforced centrally by registerWriteTool.
export const MAX_COST = 100;

interface UserError {
  message: string;
  path?: string[] | null;
}

interface CreateClientResponse {
  clientCreate: {
    client: { id: string; name: string; companyName: string | null } | null;
    userErrors: UserError[];
  };
}

function formatUserErrors(errors: UserError[]): string {
  return errors
    .map((error) => `${error.path?.length ? `${error.path.join(".")}: ` : ""}${error.message}`)
    .join("; ");
}

export function registerCreateClientTool(server: McpServer): void {
  registerWriteTool(
    server,
    "create_client",
    {
      description:
        "Create a basic Jobber client after interactive approval. Does not add contact details; search first to avoid duplicates.",
      inputSchema: {
        first_name: z.string().trim().min(1).max(100).describe("Client first name"),
        last_name: z.string().trim().min(1).max(100).describe("Client last name"),
        company_name: z.string().trim().min(1).max(200).optional().describe("Optional company name"),
        confirm_create: z.literal(true).describe("Must be true after you have searched for an existing client"),
      },
      maxCost: MAX_COST,
    },
    async ({ first_name, last_name, company_name }, jobberGraphQL) => {
      const input: Record<string, string> = { firstName: first_name, lastName: last_name };
      if (company_name) input.companyName = company_name;

      const data = await jobberGraphQL<CreateClientResponse>(CREATE_CLIENT_MUTATION, { input });
      const result = data.clientCreate;
      if (result.userErrors.length > 0) {
        throw new Error(`Jobber rejected the client: ${formatUserErrors(result.userErrors)}`);
      }
      if (!result.client) {
        throw new Error("Jobber did not return the created client; check Jobber before trying again.");
      }

      await appendAuditLog({
        tool: "create_client",
        args: { first_name, last_name, company_name },
        outcome: "success",
        result_count: 1,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              client: {
                id: result.client.id,
                name: result.client.name,
                company_name: result.client.companyName,
              },
            }),
          },
        ],
      };
    }
  );
}
