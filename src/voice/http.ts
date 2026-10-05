import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { timingSafeEqual } from "node:crypto";
import { VoiceService } from "./service.js";

export function registerVoiceRoutes(app: Hono, service: VoiceService, key: string): void {
  app.get("/voice/v1/health", c => {
    const expected = Buffer.from(`Bearer ${key}`), got = Buffer.from(c.req.header("Authorization") || "");
    if (key.length < 32 || got.length !== expected.length || !timingSafeEqual(got, expected) || c.req.header("Origin")) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ operations: service.health() });
  });
  app.post("/voice/v1/execute", bodyLimit({ maxSize: 65536, onError: c => c.json({ error: "Request too large" }, 413) }), async c => {
    const expected = Buffer.from(`Bearer ${key}`), got = Buffer.from(c.req.header("Authorization") || "");
    if (key.length < 32 || got.length !== expected.length || !timingSafeEqual(got, expected)) return c.json({ error: "Unauthorized" }, 401);
    if (c.req.header("Origin")) return c.json({ error: "Browser access forbidden" }, 403);
    const body = await c.req.text();
    if (Buffer.byteLength(body) > 65536) return c.json({ error: "Request too large" }, 413);
    try { return c.json(await service.execute(JSON.parse(body))); }
    catch { return c.json({ outcome: "unresolved", error: "Unable to verify this operation; retain intake for staff review." }, 422); }
  });
}
