#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { buildClientSchema, parse, validate } from "graphql";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const schema = buildClientSchema(
  JSON.parse(readFileSync(path.join(root, "schema", "jobber-2025-04-16.introspection.json"), "utf8"))
);

function sourcePaths(directory) {
  return readdirSync(directory).flatMap((name) => {
    const target = path.join(directory, name);
    if (name === "__tests__" || name.endsWith(".test.ts")) return [];
    return statSync(target).isDirectory() ? sourcePaths(target) : name.endsWith(".ts") ? [target] : [];
  });
}

function documentsIn(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const constants = new Map();
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  }
  collect(source);

  function evaluate(node, seen = new Set()) {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text) || !constants.has(node.text)) return undefined;
      return evaluate(constants.get(node.text), new Set([...seen, node.text]));
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const expression = evaluate(span.expression, seen);
        if (expression === undefined) return undefined;
        value += expression + span.literal.text;
      }
      return value;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left, seen);
      const right = evaluate(node.right, seen);
      return left === undefined || right === undefined ? undefined : left + right;
    }
  }

  const documents = new Set();
  function inspect(node) {
    const value = evaluate(node);
    if (value && /^(query|mutation)(?:\s+\w+)?\s*(?:\([^)]*\))?\s*\{/.test(value.trim())) documents.add(value.trim());
    ts.forEachChild(node, inspect);
  }
  inspect(source);
  return documents;
}

let checked = 0;
const failures = [];
for (const file of sourcePaths(path.join(root, "src"))) {
  for (const document of documentsIn(file)) {
    checked++;
    try {
      const errors = validate(schema, parse(document));
      if (errors.length) failures.push(`${path.relative(root, file)}: ${errors.map((error) => error.message).join("; ")}`);
    } catch (error) {
      failures.push(`${path.relative(root, file)}: ${error.message}`);
    }
  }
}

if (failures.length) {
  console.error("[schema:validate] FAILED");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`[schema:validate] OK - ${checked} fixed GraphQL documents match Jobber 2025-04-16.`);
