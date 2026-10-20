import { describe, it, expect, afterEach, vi } from "vitest";
import { apiServer, viewerServer } from "../http.js";
import { request } from "node:http";
import { WebError } from "../contracts.js";
const servers: any[] = [];
async function listen(server: any) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
const service = () => ({
  status: vi.fn().mockResolvedValue({ state: "ready" }),
  login: vi.fn().mockResolvedValue(undefined),
  get: vi.fn(),
});
describe("browser private API and owner-only viewer", () => {
  it("requires a separate bearer, rejects browser origins and arbitrary operations", async () => {
    const s = service(),
      url = await listen(apiServer(s as any, "a".repeat(32)));
    expect(
      (await fetch(url + "/v1/status", { method: "POST", body: "{}" })).status,
    ).toBe(403);
    expect(
      (
        await fetch(url + "/v1/status", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + "a".repeat(32),
            Origin: "https://evil.test",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url + "/v1/status", {
          method: "POST",
          headers: { Authorization: "Bearer " + "a".repeat(32) },
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(url + "/v1/fetch", {
          method: "POST",
          headers: { Authorization: "Bearer " + "a".repeat(32) },
          body: "{}",
        })
      ).status,
    ).toBe(409);
    expect(s.status).toHaveBeenCalledTimes(1);
  });
  it("requires owner identity on all viewer paths and refuses cross-origin login", async () => {
    const s = service(),
      url = await listen(
        viewerServer(
          s as any,
          "https://browser.example",
          "owner@example.test",
          "b".repeat(32),
        ),
      );
    expect((await fetch(url)).status).toBe(403);
    const auth = {
      "X-Auth-Request-Email": "owner@example.test",
      "X-Jobber-Viewer-Key": "b".repeat(32),
    };
    expect((await fetch(url, { headers: auth })).status).toBe(200);
    expect(
      (await fetch(url + "/viewer/vnc.html", { headers: auth })).status,
    ).toBe(404);
    expect(
      (
        await fetch(url + "/login/start", {
          method: "POST",
          headers: { ...auth, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(409);
    expect(s.login).not.toHaveBeenCalled();
    const r = await fetch(url + "/login/start", {
      method: "POST",
      redirect: "manual",
      headers: { ...auth, Origin: "https://browser.example" },
    });
    expect(r.status).toBe(303);
    expect(s.login).toHaveBeenCalledWith(true);
  });
  it("rejects unauthorized websocket upgrades even with owner header and never starts a login", async () => {
    const s = service(),
      url = await listen(
        viewerServer(
          s as any,
          "https://browser.example",
          "owner@example.test",
          "b".repeat(32),
        ),
      );
    await new Promise<void>((resolve) => {
      const req = request(url + "/viewer/websockify", {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "X-Auth-Request-Email": "owner@example.test",
          Origin: "https://evil.example",
        },
      });
      req.on("error", () => resolve());
      req.on("upgrade", () => {
        throw Error("Unexpected upgrade");
      });
      req.end();
    });
    expect(s.login).not.toHaveBeenCalled();
  });
  it("sanitizes website errors", async () => {
    const s = service();
    s.status.mockRejectedValue(new WebError("login_required"));
    const url = await listen(apiServer(s as any, "a".repeat(32)));
    const r = await fetch(url + "/v1/status", {
      method: "POST",
      headers: { Authorization: "Bearer " + "a".repeat(32) },
      body: "{}",
    });
    expect(await r.json()).toEqual({ error: "login_required" });
  });
});
