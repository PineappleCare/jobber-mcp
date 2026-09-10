#!/usr/bin/env node
// The public source distribution has one version authority: package.json.
// server.json is intentionally absent until this project is published to a
// registry that can truthfully serve it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) {
  throw new Error(`package.json version is not valid semver: ${pkg.version}`);
}
console.log(`[verify-version-sync] OK - package.json is the version authority (${pkg.version}).`);
