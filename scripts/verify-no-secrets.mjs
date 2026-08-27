#!/usr/bin/env node
// Verifies the acceptance criterion "no credentials exist anywhere in the
// published package": enumerates exactly what `npm pack` would ship and
// scans it for secret-shaped content. Wired into `prepublishOnly` so
// `npm publish` is blocked on failure.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Case-insensitive, underscore-optional name pattern: "client_secret" also matches "clientSecret". */
function namePattern(name) {
  return name.split("_").join("[_]?");
}

/** A quoted assignment like `client_secret: "abc123..."` or `clientSecret = 'abc123...'`. */
function quotedAssignment(name, minLen = 10) {
  // `['"]?` before the separator so a quoted JSON key ("refresh_token": "...")
  // matches too, not just a bare JS/env key. Added 2026-08-27 after a planted
  // refresh token in JSON form scanned clean.
  return new RegExp(`${namePattern(name)}['"]?\\s*[:=]\\s*['"]([^'"]{${minLen},})['"]`, "i");
}

/**
 * A whole-line, .env-shaped assignment like `CLIENT_SECRET=abc123...`. Anchored to the full line
 * (not just `[:=]value`) so it doesn't match ordinary JS/TS property access like
 * `access_token: tokens.access_token,` - that always has trailing punctuation, an env line doesn't.
 */
function unquotedAssignment(name, minLen = 16) {
  return new RegExp(
    `^[ \\t]*${namePattern(name)}[ \\t]*=[ \\t]*[A-Za-z0-9_\\-.]{${minLen},}[ \\t]*(#.*)?$`,
    "im"
  );
}

const CREDENTIAL_NAMES = ["client_secret", "access_token", "refresh_token", "api_key", "encryption_key", "password"];

export const SECRET_PATTERNS = [
  ...CREDENTIAL_NAMES.flatMap((name) => [
    { name: `${name} assignment (quoted)`, pattern: quotedAssignment(name) },
    { name: `${name} assignment (unquoted/.env-style)`, pattern: unquotedAssignment(name) },
  ]),
  { name: "credentials embedded in a URL", pattern: /:\/\/[^\s'"/]+:[^\s'"/]+@/ },
  { name: "bare long hex string (matches this repo's 64-hex encryption key format)", pattern: /\b[0-9a-f]{40,}\b/i },
  { name: "JWT-shaped string", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "Bearer token", pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/i },
];

/**
 * Documentation placeholders are not secrets. The quoted-assignment patterns
 * deliberately match a JSON key ("client_secret": "..."), which is also the
 * exact shape of the config example in the README, so without this every
 * install snippet would fail the guard and the guard would get switched off.
 * Only the captured VALUE is tested here, never the key.
 */
const PLACEHOLDER =
  /^(your[-_ ]|my[-_ ]|<|\{\{|\.\.\.|x{4,}$|abc123$|changeme|placeholder|example|replace[-_ ]|paste[-_ ]|sk_test_)/i;

function isPlaceholder(value) {
  return typeof value === "string" && PLACEHOLDER.test(value.trim());
}

export function findSecretMatches(content) {
  return SECRET_PATTERNS.filter(({ pattern }) => {
    const m = pattern.exec(content);
    if (!m) return false;
    // A capture group means the pattern isolated the value; if every hit is a
    // documented placeholder, it is not a finding.
    if (m.length > 1 && m[1] !== undefined) {
      const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
      let hit, real = false;
      while ((hit = global.exec(content)) !== null) {
        if (!isPlaceholder(hit[1])) { real = true; break; }
      }
      return real;
    }
    return true;
  }).map(({ name }) => name);
}

function getPackedFilePaths() {
  const output = execSync("npm pack --dry-run --json", { encoding: "utf8" });
  const [pkgInfo] = JSON.parse(output);
  return pkgInfo.files.map((f) => f.path);
}

export function main() {
  const files = getPackedFilePaths();
  let failed = false;

  for (const relPath of files) {
    let content;
    try {
      content = readFileSync(relPath, "utf8");
    } catch {
      continue; // not a text file - nothing to scan
    }

    for (const name of findSecretMatches(content)) {
      console.error(`[verify-no-secrets] FAIL: ${relPath} matches "${name}" pattern.`);
      failed = true;
    }
  }

  if (failed) {
    console.error(`[verify-no-secrets] Scanned ${files.length} file(s) that would ship in the npm package - FAILED.`);
    process.exit(1);
  }

  console.log(`[verify-no-secrets] Scanned ${files.length} file(s) that would ship in the npm package - clean.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
