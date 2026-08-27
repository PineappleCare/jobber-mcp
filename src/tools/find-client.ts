import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool, pageSizeSchema, cursorSchema, returnedSoFarSchema, pageProgress } from "../tool-helpers.js";
import { FIND_CLIENT_QUERY } from "../jobber/queries.js";
import { appendAuditLog } from "../utils/auditLog.js";

const PAGE_CAP = 20;
// measured via scripts/measure-costs.mjs - see README cost table. Sole enforcement point:
// passed directly to jobberGraphQL() below.
export const MAX_COST = 500;

interface JobberEmail {
  address: string;
  primary: boolean;
}
interface JobberPhone {
  number: string;
  primary: boolean;
}
interface JobberAddress {
  street1: string | null;
  street2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
}
interface JobberClientNode {
  id: string;
  name: string;
  companyName: string | null;
  emails: JobberEmail[];
  phones: JobberPhone[];
  billingAddress: JobberAddress | null;
}
interface FindClientResponse {
  clients: {
    totalCount: number;
    nodes: JobberClientNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export function registerFindClientTool(server: McpServer): void {
  registerReadOnlyTool(
    server,
    "find_client",
    {
      description: "Search Jobber clients by name, email, or phone. Returns contact info and addresses.",
      inputSchema: {
        search_term: z.string().min(1).describe("Name, email, or phone number to search for"),
        page_size: pageSizeSchema(PAGE_CAP).describe(`Max results to return (1-${PAGE_CAP})`),
        cursor: cursorSchema(),
        returned_so_far: returnedSoFarSchema(),
      },
      maxCost: MAX_COST,
    },
    async (
      {
        search_term,
        page_size,
        cursor,
        returned_so_far = 0,
      }: {
        search_term: string;
        page_size: number;
        cursor?: string;
        returned_so_far?: number;
      },
      jobberGraphQL
    ) => {
      const data = await jobberGraphQL<FindClientResponse>(FIND_CLIENT_QUERY, {
        searchTerm: search_term,
        first: page_size,
        after: cursor,
      });

      const clients = data.clients.nodes.map((c) => ({
        id: c.id,
        name: c.name,
        company_name: c.companyName,
        emails: c.emails.map((e) => ({ address: e.address, primary: e.primary })),
        phones: c.phones.map((p) => ({ number: p.number, primary: p.primary })),
        address: c.billingAddress
          ? {
              street1: c.billingAddress.street1,
              street2: c.billingAddress.street2,
              city: c.billingAddress.city,
              province: c.billingAddress.province,
              postal_code: c.billingAddress.postalCode,
              country: c.billingAddress.country,
            }
          : null,
      }));

      await appendAuditLog({
        tool: "find_client",
        args: { search_term, page_size, cursor },
        outcome: "success",
        result_count: clients.length,
      });

      const { returned_so_far: returnedSoFar, remaining } = pageProgress(
        data.clients.totalCount,
        clients.length,
        returned_so_far
      );
      const result: Record<string, unknown> = {
        total_count: data.clients.totalCount,
        returned_so_far: returnedSoFar,
        clients,
      };
      if (data.clients.pageInfo.hasNextPage) {
        result.note = remaining > 0 ? `${remaining} more available` : "more available";
        result.next_cursor = data.clients.pageInfo.endCursor;
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
