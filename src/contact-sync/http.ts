import type { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { JobberAuthenticationError, JobberPermissionError } from "../jobber/errors.js";

type Run = (query: string, variables: Record<string, unknown>, maxCost: number) => Promise<any>;
const pi = `pageInfo{hasNextPage endCursor}`;
const email = `address description primary`;
const phone = `number description primary`;
const contact = `id name firstName lastName emails(first:10){nodes{${email}} ${pi}} phones(first:10){nodes{${phone}} ${pi}}`;
const clients = `query ContactSyncClients($after:String){clients(first:10,after:$after){nodes{id name firstName lastName companyName isLead isArchived emails{${email}} phones{${phone}} billingAddress{street1 street2 city province postalCode country} contacts(first:1,filter:{includePropertyContacts:true}){nodes{${contact}} ${pi}}} ${pi}}}`;
const contacts = `query ContactSyncContacts($id:EncodedId!,$after:String){client(id:$id){contacts(first:10,after:$after,filter:{includePropertyContacts:true}){nodes{${contact}} ${pi}}}}`;
const emails = `query ContactSyncEmails($id:EncodedId!,$after:String){clientContact(id:$id){emails(first:50,after:$after){nodes{${email}} ${pi}}}}`;
const phones = `query ContactSyncPhones($id:EncodedId!,$after:String){clientContact(id:$id){phones(first:50,after:$after){nodes{${phone}} ${pi}}}}`;
const accountQuery = `query ContactSyncAccount{account{id}}`;

/** Private fixed read operations; this credential has no MCP or mutation access. */
export function registerContactSyncRoutes(app: Hono, run: Run, key: string, account: string): void {
  if (key.length < 32 || !account || key === process.env.MCP_API_KEY || key === process.env.JOBBER_VOICE_API_KEY) {
    throw new Error("Contact sync requires a separate service credential and pinned account");
  }
  app.get("/contact-sync/v1/page", async c => {
    const expected = Buffer.from(`Bearer ${key}`), presented = Buffer.from(c.req.header("Authorization") || "");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return c.json({ error: "unauthorized" }, 401);
    if (c.req.header("Origin")) return c.json({ error: "browser_access_forbidden" }, 403);
    const params = c.req.query();
    const kind = params.kind;
    if (Object.keys(params).some(k => !["kind", "id", "after"].includes(k)) || !["clients", "contacts", "emails", "phones"].includes(kind) || kind !== "clients" && !params.id || kind === "clients" && params.id || (params.after?.length || 0) > 4096 || (params.id?.length || 0) > 4096) {
      return c.json({ error: "invalid_input" }, 422);
    }
    try {
      if (String((await run(accountQuery, {}, 1)).account?.id || "") !== account) return c.json({ error: "account_binding_mismatch" }, 409);
      const variables = { after: params.after || null, ...(params.id ? { id: params.id } : {}) };
      const data = await run(kind === "clients" ? clients : kind === "contacts" ? contacts : kind === "emails" ? emails : phones, variables, 900);
      const page = kind === "clients" ? data.clients : kind === "contacts" ? data.client?.contacts : data.clientContact?.[kind];
      if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== "boolean" || page.pageInfo.hasNextPage && (!page.pageInfo.endCursor || page.pageInfo.endCursor === params.after)) return c.json({ error: "incomplete_response" }, 502);
      c.header("Cache-Control", "no-store");
      return c.json({ business: "williams", account, page });
    } catch (error) {
      return c.json({ error: error instanceof JobberAuthenticationError ? "authentication_failed" : error instanceof JobberPermissionError ? "permission_denied" : "provider_unavailable" }, error instanceof JobberAuthenticationError ? 401 : error instanceof JobberPermissionError ? 403 : 503);
    }
  });
}
