import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { timingSafeEqual } from "node:crypto";
import { VoiceService } from "./service.js";
import { z } from "zod";

const rejectedInput = (fields: string[], safeToCorrect = false) => ({ outcome: "failed", reason_code: "invalid_input", submission_rejected: safeToCorrect, records: {}, invalid_fields: fields,
  reason: "This input was rejected before dispatch. Correct the reported fields; retain any prior operation and verify its outcome before confirming again." });

export function registerVoiceRoutes(app: Hono, service: VoiceService, key: string): void {
  app.get("/voice/v1/health", c => {
    const expected = Buffer.from(`Bearer ${key}`), got = Buffer.from(c.req.header("Authorization") || "");
    if (key.length < 32 || got.length !== expected.length || !timingSafeEqual(got, expected) || c.req.header("Origin")) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ operations: service.health(), directory: service.directoryHealth() });
  });
  app.post("/voice/v1/execute", bodyLimit({ maxSize: 65536, onError: c => c.json(rejectedInput(["payload_size"]), 413) }), async c => {
    const expected = Buffer.from(`Bearer ${key}`), got = Buffer.from(c.req.header("Authorization") || "");
    if (key.length < 32 || got.length !== expected.length || !timingSafeEqual(got, expected)) return c.json({ error: "Unauthorized" }, 401);
    if (c.req.header("Origin")) return c.json({ error: "Browser access forbidden" }, 403);
    const body = await c.req.text();
    if (Buffer.byteLength(body) > 65536) return c.json(rejectedInput(["payload_size"]), 413);
    let input:any;
    try {input=JSON.parse(body);} catch {return c.json(rejectedInput(["payload"]),422);}
    try {return c.json(await service.dispatch(input));}
    catch (error) {
      if (error instanceof z.ZodError) return c.json(rejectedInput([...new Set(error.issues.map(i => i.path.join(".") || "payload"))],service.inputNeverJournaled(input?.operation_id)), 422);
      return c.json({ outcome: "unresolved", error: "Unable to verify this operation; retain intake for staff review." }, 422);
    }
  });
}
