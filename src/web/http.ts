import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { WebService } from "./service.js";
import {
  execution,
  id,
  paymentInput,
  pinInput,
  snapshot,
  WebError,
} from "./contracts.js";
function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new WebError("request_too_large");
  }
  return JSON.parse(text);
}
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function apiServer(service: WebService, key: string) {
  if (key.length < 32) throw new Error("Browser service credential required");
  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      reply(res, 200, { service: "up" });
      return;
    }
    if (
      req.headers.origin ||
      !equal(String(req.headers.authorization ?? ""), `Bearer ${key}`)
    ) {
      reply(res, 403, { error: "forbidden" });
      return;
    }
    try {
      if (req.method !== "POST") throw new WebError("unsupported_operation");
      const raw = await body(req);
      let result: unknown;
      switch (req.url) {
        case "/v1/status":
          z.object({}).strict().parse(raw);
          result = await service.status();
          break;
        case "/v1/preview-payment": {
          const a = z
            .object({ input: paymentInput, snapshot })
            .strict()
            .parse(raw);
          result = await service.previewPayment(a.input, a.snapshot);
          break;
        }
        case "/v1/preview-pin": {
          const a = z.object({ input: pinInput, snapshot }).strict().parse(raw);
          result = await service.previewPin(a.input, a.snapshot);
          break;
        }
        case "/v1/execute": {
          const a = z.object({ execution, snapshot }).strict().parse(raw);
          result = await service.execute(a.execution, a.snapshot);
          break;
        }
        case "/v1/operation": {
          const a = z.object({ operation_id: id }).strict().parse(raw);
          result = service.get(a.operation_id);
          break;
        }
        case "/v1/verify": {
          const a = z
            .object({ operation_id: id, snapshot })
            .strict()
            .parse(raw);
          result = await service.verify(a.operation_id, a.snapshot);
          break;
        }
        default:
          throw new WebError("unsupported_operation");
      }
      reply(res, 200, result);
    } catch (e) {
      reply(res, e instanceof WebError ? 409 : 400, {
        error:
          e instanceof WebError
            ? e.code
            : e instanceof z.ZodError || e instanceof SyntaxError
              ? "invalid_request"
              : "website_changed",
      });
    }
  });
}
export function viewerServer(
  service: WebService,
  origin: string,
  owner: string,
  proxyKey: string,
) {
  const trustedOrigin = new URL(origin).origin;
  const prefix = new URL(origin).pathname.replace(/\/$/, "");
  if (!owner.trim() || proxyKey.length < 32)
    throw new Error("Viewer owner and proxy credential must be explicit");
  let active = false;
  const sockets = new Set<WebSocket>();
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });
  const ownerAllowed = (req: IncomingMessage) =>
    typeof req.headers["x-auth-request-email"] === "string" &&
    equal(
      req.headers["x-auth-request-email"].toLowerCase(),
      owner.toLowerCase(),
    ) &&
    equal(String(req.headers["x-jobber-viewer-key"] ?? ""), proxyKey);
  const server = createServer(async (req, res) => {
    if (!ownerAllowed(req)) {
      reply(res, 403, { error: "forbidden" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (req.method === "GET" && req.url === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          '<!doctype html><title>Jobber browser login</title><h1>Jobber browser login</h1><p>Automation pauses while you control this browser. Finish login before closing.</p><form method="post" action="' +
            prefix +
            '/login/start"><button>Open browser for login</button></form><form method="post" action="' +
            prefix +
            '/login/finish"><button>Finish login and resume automation</button></form>' +
            (active
              ? '<iframe title="Jobber login" style="width:100%;height:80vh" src="' +
                prefix +
                '/viewer/index.html"></iframe>'
              : ""),
        );
        return;
      }
      if (
        req.method === "POST" &&
        ["/login/start", "/login/finish"].includes(req.url ?? "")
      ) {
        if (req.headers.origin !== trustedOrigin)
          throw new WebError("invalid_origin");
        if (req.url === "/login/start") {
          await service.login(true);
          active = true;
        } else {
          await service.login(false);
          active = false;
          for (const s of sockets) s.terminate();
          sockets.clear();
        }
        res.writeHead(303, { Location: prefix + "/" });
        res.end();
        return;
      }
      if (req.method === "GET" && active) {
        if (req.url === "/viewer/index.html") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            '<!doctype html><style>html,body,#screen{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="screen"></div><script type="module" src="' +
              prefix +
              '/viewer/login.js"></script>',
          );
          return;
        }
        if (req.url === "/viewer/login.js") {
          res.setHeader("Content-Type", "text/javascript");
          res.end(await readFile(new URL("./viewer.js", import.meta.url)));
          return;
        }
      }
      reply(res, 404, { error: "not_found" });
    } catch (e) {
      reply(res, 409, {
        error: e instanceof WebError ? e.code : "login_verification_failed",
      });
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (
      !ownerAllowed(req) ||
      req.headers.origin !== trustedOrigin ||
      !active ||
      req.url !== "/viewer/websockify"
    ) {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      const tcp = connect(5900, "127.0.0.1");
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          ws.close(1003);
          return;
        }
        if (!tcp.write(data as Buffer)) ws.pause();
      });
      tcp.on("drain", () => ws.resume());
      tcp.on("data", (data) => {
        if (ws.bufferedAmount > 8 * 1024 * 1024) {
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
      tcp.on("error", () => ws.close(1011));
      tcp.on("close", () => ws.close());
      ws.on("error", () => tcp.destroy());
      ws.on("close", () => {
        tcp.destroy();
        sockets.delete(ws);
      });
    });
  });
  server.on("close", () => {
    for (const s of sockets) s.terminate();
    websocket.close();
  });
  return server;
}
