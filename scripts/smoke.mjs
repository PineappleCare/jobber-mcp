#!/usr/bin/env node
// Verifies the built package starts correctly over stdio and that basic MCP
// wiring works: initialize succeeds and tools/list returns the expected
// read-only tool set with no write tools and no raw-GraphQL tool. Run after
// `npm run build`; wired into prepublishOnly.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildEntry = path.join(__dirname, "../build/index.js");

const EXPECTED_TOOLS = [
  "auth_status",
  "authenticate",
  "logout",
  "find_client",
  "client_history",
  "overdue_invoices",
  "quotes_outstanding",
  "jobs_summary",
  "revenue_summary",
  "schedule_lookup",
  "requests_inbox",
  "get_audit_log",
  "search_records",
  "get_record",
  "catalog_search",
  "team_list",
];

function send(child, message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

function waitForResponse(child, id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for response id=${id}`));
    }, timeoutMs);

    function onData(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id === id) {
          cleanup();
          resolve(parsed);
          return;
        }
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
    }

    child.stdout.on("data", onData);
  });
}

async function main() {
  const child = spawn("node", [buildEntry], {
    env: {
      ...process.env,
      TRANSPORT: "stdio",
      JOBBER_CLIENT_ID: process.env.JOBBER_CLIENT_ID ?? "smoke-test-client-id",
      JOBBER_CLIENT_SECRET: process.env.JOBBER_CLIENT_SECRET ?? "smoke-test-client-secret",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  const failWith = (message) => {
    child.kill();
    console.error(`[smoke] FAILED: ${message}`);
    if (stderr) console.error(`[smoke] stderr:\n${stderr}`);
    process.exit(1);
  };

  try {
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.0.1" },
      },
    });
    const initResponse = await waitForResponse(child, 1);
    if (!initResponse.result?.serverInfo?.name) {
      failWith(`initialize did not return serverInfo: ${JSON.stringify(initResponse)}`);
      return;
    }

    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listResponse = await waitForResponse(child, 2);
    const names = (listResponse.result?.tools ?? []).map((t) => t.name).sort();

    const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
    if (missing.length > 0) {
      failWith(`tools/list is missing expected tools: ${missing.join(", ")}`);
      return;
    }

    const unexpected = names.filter((name) => !EXPECTED_TOOLS.includes(name));
    if (unexpected.length > 0) {
      failWith(`tools/list returned unexpected tools (write or raw-GraphQL tool leaked in?): ${unexpected.join(", ")}`);
      return;
    }

    console.log(`[smoke] OK - server started, initialize succeeded, ${names.length} expected read-only tools registered.`);
    child.kill();
    process.exit(0);
  } catch (err) {
    failWith(err.message);
  }
}

main();
