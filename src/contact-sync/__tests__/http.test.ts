import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerContactSyncRoutes } from "../http.js";
import { JobberAuthenticationError } from "../../jobber/errors.js";
const key = "test-contact-service-key-0123456789abcdef";
const page = { nodes: [{ id: "client", emails: [{ address: "test@example.invalid" }] }], pageInfo: { hasNextPage: false } };
let app: Hono;
let run: ReturnType<typeof vi.fn>;
beforeEach(() => {
  run = vi.fn(async query => query.includes("ContactSyncAccount") ? { account: { id: "williams" } } : { clients: page });
  app = new Hono(); registerContactSyncRoutes(app, run, key, "williams");
});
const headers = { Authorization: `Bearer ${key}` };
describe("private contact read surface", () => {
  it("rejects unauthenticated, browser and arbitrary operation requests before reading Jobber", async () => {
    expect((await app.request("/contact-sync/v1/page?kind=clients")).status).toBe(401);
    expect((await app.request("/contact-sync/v1/page?kind=clients", { headers: { ...headers, Origin: "https://example.invalid" } })).status).toBe(403);
    expect((await app.request("/contact-sync/v1/page?kind=clients&query=mutation", { headers })).status).toBe(422);
    expect((await app.request("/contact-sync/v1/page?kind=jobs", { headers })).status).toBe(422);
    expect(run).not.toHaveBeenCalled();
  });
  it("returns pinned client pages without exposing a general GraphQL interface", async () => {
    const response = await app.request("/contact-sync/v1/page?kind=clients&after=cursor", { headers });
    expect(await response.json()).toEqual({ business: "williams", account: "williams", page });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(run.mock.calls[1][1]).toEqual({ after: "cursor" });
    expect(run.mock.calls.every(([query]) => !query.includes("mutation"))).toBe(true);
  });
  it("rejects another account before fetching a client page", async () => {
    run.mockResolvedValue({ account: { id: "other" } });
    const response = await app.request("/contact-sync/v1/page?kind=clients", { headers });
    expect(response.status).toBe(409); expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await response.json())).not.toContain("test@example");
  });
  it("reports revoked credentials without exposing provider messages", async () => {
    run.mockRejectedValue(new JobberAuthenticationError("secret provider message"));
    const response = await app.request("/contact-sync/v1/page?kind=clients", { headers });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "authentication_failed" });
  });
  it("fails incomplete pages instead of reporting a successful partial inventory", async () => {
    run.mockImplementation(async query => query.includes("ContactSyncAccount") ? { account: { id: "williams" } } : { clients: { nodes: [], pageInfo: { hasNextPage: true } } });
    expect((await app.request("/contact-sync/v1/page?kind=clients", { headers })).status).toBe(502);
  });
});
