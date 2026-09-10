import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerWriteTool } from "../tool-helpers.js";
import { UPDATE_CLIENT_COMPANY_NAME_MUTATION } from "../jobber/queries.js";
import { appendAuditLog } from "../utils/auditLog.js";

// Conservative ceiling until this mutation has been measured against Williams.
export const MAX_COST = 100;

interface UserError {
  message: string;
  path?: string[] | null;
}

interface UpdateClientResponse {
  clientEdit: {
    client: { id: string; name: string; companyName: string | null } | null;
    userErrors: UserError[];
  };
}

function formatUserErrors(errors: UserError[]): string {
  return errors
    .map((error) => `${error.path?.length ? `${error.path.join(".")}: ` : ""}${error.message}`)
    .join("; ");
}

export function registerUpdateClientCompanyNameTool(server: McpServer): void {
  registerWriteTool(
    server,
    "update_client_company_name",
    {
      description:
        "Set the company name on a known Jobber client after interactive approval. Check Jobber before retrying an uncertain result.",
      inputSchema: {
        client_id: z.string().trim().min(1).describe("Jobber client ID returned by find_client"),
        company_name: z.string().trim().min(1).max(200).describe("The replacement company name"),
        confirm_write: z.literal(true).describe("Must be true after reviewing the client and replacement value"),
      },
      maxCost: MAX_COST,
    },
    async ({ client_id, company_name }, jobberGraphQL) => {
      const data = await jobberGraphQL<UpdateClientResponse>(UPDATE_CLIENT_COMPANY_NAME_MUTATION, {
        clientId: client_id,
        input: { companyName: company_name },
      });
      const result = data.clientEdit;
      if (result.userErrors.length > 0) {
        throw new Error(`Jobber rejected the client update: ${formatUserErrors(result.userErrors)}`);
      }
      if (!result.client) {
        throw new Error("Jobber did not return the updated client; check Jobber before trying again.");
      }

      await appendAuditLog({
        tool: "update_client_company_name",
        args: { client_id, company_name },
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
