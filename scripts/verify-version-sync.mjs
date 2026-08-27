#!/usr/bin/env node
// Fails if package.json's version and server.json's version(s) drift apart.
// Wired into prepublishOnly so a forgotten bump can't ship.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const registry = JSON.parse(readFileSync(path.join(root, "server.json"), "utf8"));

const mismatches = [];

if (registry.version !== pkg.version) {
  mismatches.push(`server.json version "${registry.version}" !== package.json version "${pkg.version}"`);
}

for (const [i, p] of (registry.packages ?? []).entries()) {
  if (p.version !== pkg.version) {
    mismatches.push(`server.json packages[${i}].version "${p.version}" !== package.json version "${pkg.version}"`);
  }
}

if (mismatches.length > 0) {
  console.error("[verify-version-sync] FAILED:");
  for (const m of mismatches) console.error(`  - ${m}`);
  process.exit(1);
}

console.log(`[verify-version-sync] OK - all versions match package.json (${pkg.version}).`);
