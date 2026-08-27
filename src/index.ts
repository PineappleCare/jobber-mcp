#!/usr/bin/env node
import { readFileSync } from "fs";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MCP clients pass env vars directly rather than relying on a .env file, so neither path
// matters for them. For a source checkout run directly (`npm start`), try the process's CWD
// first (typical when running from the repo root), then fall back to the path relative to
// this installed package's own directory (e.g. inside node_modules under npx/global installs).
// dotenv.config() never overwrites a var the first call already set, so this is precedence,
// not a double-load.
dotenv.config({ path: path.join(process.cwd(), ".env") });
dotenv.config({ path: path.join(__dirname, "../.env") });
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function validateAuthEnv(): void {
  const clientId = (process.env.JOBBER_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.JOBBER_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) {
    console.error(
      "[startup] Fatal: JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET are required. " +
      "Register a developer app at https://developer.getjobber.com and set both in your environment."
    );
    process.exit(1);
  }
}

async function main() {
  validateAuthEnv();

  const mode = (process.env.TRANSPORT ?? "stdio").toLowerCase();

  if (mode === "stdio") {
    const { McpServer } = await import("@modelcontextprotocol/server");
    const { StdioServerTransport } = await import("@modelcontextprotocol/server/stdio");
    const { registerAllTools } = await import("./registerAllTools.js");

    const server = new McpServer({ name: "jobber-mcp", version: pkg.version });
    registerAllTools(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Jobber MCP server running on stdio");
  } else {
    if (!process.env.MCP_BASE_URL) {
      console.error(
        "[startup] Fatal: MCP_BASE_URL is required in HTTP mode (e.g. https://mcp.example.com). " +
        "Set TRANSPORT=stdio for local single-user mode."
      );
      process.exit(1);
    }
    if (!process.env.MCP_API_KEY && process.env.MCP_ALLOW_NO_API_KEY !== "true") {
      console.error(
        "[startup] Fatal: MCP_API_KEY is required in HTTP mode - leaving it unset exposes the /mcp " +
        "endpoint (and everything it can read from Jobber) to anyone who can reach this port. Set " +
        "MCP_API_KEY, or set MCP_ALLOW_NO_API_KEY=true to explicitly opt out (e.g. behind a trusted " +
        "network or a reverse proxy that already enforces auth)."
      );
      process.exit(1);
    }
    const { startHttpServer } = await import("./server/http.js");
    startHttpServer();
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
