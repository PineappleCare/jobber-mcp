#!/usr/bin/env bash
# Pull the latest connector code from the private development repo into this
# public mirror, re-apply the public identity, and stop.
#
# It never commits and never pushes. The whole point of a separate mirror is
# that publishing is a decision someone makes on purpose, so this script leaves
# you at `git status` and gets out of the way.
#
#   ./sync-from-dev.sh [branch]     # default: development
set -euo pipefail

SRC="${SRC:-/home/piterjov/projects/jobber-mcp}"
BRANCH="${1:-development}"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -d "$SRC/.git" ] || { echo "No git repo at $SRC. Set SRC=/path/to/private/repo."; exit 1; }

echo "==> source: $SRC ($BRANCH)"
git -C "$SRC" fetch --quiet origin || true
git -C "$SRC" checkout --quiet "$BRANCH"
if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
  echo "!! The private repo has uncommitted changes. Commit or stash there first."; exit 1
fi
echo "==> at $(git -C "$SRC" log --oneline -1)"

# .git is excluded on purpose: the mirror keeps its own history so the private
# repo's history can never be published by an accidental push.
rsync -a --delete \
  --exclude='.git' --exclude='node_modules' --exclude='build' --exclude='coverage' \
  --exclude='.env' --exclude='.env.*' --exclude='*.token.json' --exclude='*.tgz' \
  --exclude='sync-from-dev.sh' \
  "$SRC"/ "$HERE"/

echo "==> re-applying the public identity"
node - <<'NODE'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.name = "@adeocode/jobber-mcp";
pkg.mcpName = "io.github.adeocode/jobber-mcp";
pkg.author = "Adeocode (https://www.adeocode.com)";
pkg.homepage = "https://www.adeocode.com/jobber-mcp/";
pkg.repository = { type: "git", url: "git+https://github.com/adeocode/jobber-mcp.git" };
pkg.bugs = { url: "https://github.com/adeocode/jobber-mcp/issues" };
pkg.keywords = ["jobber","mcp","model-context-protocol","claude","chatgpt","copilot",
                "field-service","home-services","graphql","crm","integration"];
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

const srv = JSON.parse(fs.readFileSync("server.json", "utf8"));
srv.name = "io.github.adeocode/jobber-mcp";
if (srv.repository) srv.repository.url = "https://github.com/adeocode/jobber-mcp";
(srv.packages || []).forEach((p) => {
  if (p.registryType === "npm") p.identifier = "@adeocode/jobber-mcp";
});
fs.writeFileSync("server.json", JSON.stringify(srv, null, 2) + "\n");

for (const f of ["README.md"]) {
  if (!fs.existsSync(f)) continue;
  fs.writeFileSync(f, fs.readFileSync(f, "utf8")
    .replaceAll("@oktopeak/jobber-mcp", "@adeocode/jobber-mcp")
    .replaceAll("io.github.oktopeak/jobber-mcp", "io.github.adeocode/jobber-mcp")
    .replaceAll("github.com/oktopeak/jobber-mcp", "github.com/adeocode/jobber-mcp"));
}
NODE

echo "==> installing and running the full gate"
npm install --silent
npm run lint && npm test && npm run build && npm run smoke && npm run verify:no-secrets

if grep -rn "oktopeak" --include="*.json" --include="*.md" --include="*.ts" --include="*.mjs" --include="*.yml" . 2>/dev/null | grep -v node_modules | grep -v package-lock; then
  echo "!! 'oktopeak' still appears above. Fix before publishing."; exit 1
fi

echo
echo "==> clean. Review and commit yourself:"
git status --short
