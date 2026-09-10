#!/usr/bin/env node
/**
 * Download the schema for the explicitly selected Jobber API version.
 *
 * This script intentionally uses the connector's encrypted local OAuth token;
 * it never accepts or writes an access token, refresh token, or client secret.
 * Run it only after `authenticate` has completed for a developer app with the
 * relevant scopes. The committed result is a public API schema, not account
 * data.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getValidAccessToken } from "../build/auth/oauth.js";

const version = process.env.JOBBER_GRAPHQL_VERSION ?? "2025-04-16";
if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) {
  throw new Error("JOBBER_GRAPHQL_VERSION must be a YYYY-MM-DD Jobber API version");
}

const token = await getValidAccessToken();
const result = await fetch(process.env.JOBBER_GRAPHQL_URL ?? "https://api.getjobber.com/api/graphql", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-JOBBER-GRAPHQL-VERSION": version,
  },
  body: JSON.stringify({ query: "query IntrospectionQuery { __schema { queryType { name } mutationType { name } subscriptionType { name } types { ...FullType } directives { name description locations args { ...InputValue } } } } fragment FullType on __Type { kind name description fields(includeDeprecated: true) { name description args { ...InputValue } type { ...TypeRef } isDeprecated deprecationReason } inputFields(includeDeprecated: true) { ...InputValue } interfaces { ...TypeRef } enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason } possibleTypes { ...TypeRef } } fragment InputValue on __InputValue { name description type { ...TypeRef } defaultValue isDeprecated deprecationReason } fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }" }),
});
if (!result.ok) throw new Error(`Schema download failed: HTTP ${result.status}`);
const body = await result.json();
if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join("; "));
if (!body.data?.__schema) throw new Error("Jobber returned no GraphQL schema");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schema");
await mkdir(root, { recursive: true });
const destination = path.join(root, `jobber-${version}.introspection.json`);
await writeFile(destination, `${JSON.stringify(body.data, null, 2)}\n`, "utf8");
console.error(`[schema] Wrote ${path.relative(process.cwd(), destination)}`);
