import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { appendAuditLog } from "./utils/auditLog.js";
import { jobberGraphQL, jobberGraphQLWrite } from "./jobber/client.js";

export function isReadOnly(): boolean {
  return (process.env.JOBBER_READ_ONLY ?? "true").toLowerCase() !== "false";
}

export function pageSizeSchema(cap: number) {
  return z
    .number()
    .int()
    .min(1)
    .max(cap)
    .default(Math.min(20, cap));
}

/** A page cursor from a previous response's `next_cursor`, used to fetch the next page. */
export function cursorSchema() {
  return z.string().optional().describe("Cursor from a previous response's next_cursor, to fetch the next page");
}

/** Rounds a money amount to the nearest cent, avoiding float-accumulation noise from summing many values. */
export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Items already returned by prior pages of the same cursor walk. Callers echo back
 * the previous response's `returned_so_far` so `remaining` can be computed correctly
 * on every page, not just the first.
 */
export function returnedSoFarSchema() {
  return z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe(
      "Items already returned by prior pages of this same query - echo back the previous response's returned_so_far; omit on the first call."
    );
}

export interface PageProgress {
  returned_so_far: number;
  remaining: number;
}

/** Computes the running total returned so far and how many remain, across a cursor walk. */
export function pageProgress(totalCount: number, itemsThisPage: number, previousReturned: number): PageProgress {
  const returned_so_far = previousReturned + itemsThisPage;
  return { returned_so_far, remaining: Math.max(0, totalCount - returned_so_far) };
}

interface ToolResultContent {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface ToolConfig<Args, Cost extends number | Record<string, number> = number> {
  description: string;
  inputSchema?: Args;
  annotations?: Record<string, boolean>;
  /**
   * The tool's declared cost ceiling(s) - a single number for a tool with one query path, or a
   * named record (e.g. `{ main: 50, paymentsPage: 20 }`) for a tool whose handler makes more than
   * one distinct query with different ceilings. This is the *only* place a cost is declared:
   * registerReadOnlyTool binds it into the query-runner handed to the handler, so the handler
   * cannot call jobberGraphQL with a cost other than the one declared here. Omit entirely for a
   * tool that never calls Jobber's GraphQL API at all (e.g. get_audit_log reads a local file) -
   * such a tool's handler must not accept the query-runner parameter.
   */
  maxCost?: Cost;
}

/** The handler-visible shape for a tool's declared Zod inputSchema - `{}` when the tool takes no args. */
type InferArgs<Args extends Record<string, z.ZodTypeAny> | undefined> = Args extends Record<
  string,
  z.ZodTypeAny
>
  ? z.infer<z.ZodObject<Args>>
  : Record<string, never>;

/**
 * The query-runner passed to a tool's handler - jobberGraphQL with the declared maxCost(s)
 * already bound in. A numeric maxCost yields a 2-arg runner; a record maxCost yields a 3-arg
 * runner whose third argument is constrained to a declared cost key, so passing an undeclared
 * key (or forgetting it) is a compile-time error rather than a silent NaN budget check.
 */
export type CostedGraphQL<Cost extends number | Record<string, number>> = Cost extends number
  ? <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>
  : <T = any>(query: string, variables: Record<string, unknown> | undefined, costKey: keyof Cost & string) => Promise<T>;

type GraphQLExecutor = <T = any>(
  query: string,
  variables: Record<string, unknown> | undefined,
  maxCost: number
) => Promise<T>;

function makeCostedGraphQL<Cost extends number | Record<string, number>>(
  toolName: string,
  maxCost: Cost | undefined,
  execute: GraphQLExecutor = jobberGraphQL
): CostedGraphQL<Cost> {
  return ((query: string, variables?: Record<string, unknown>, costKey?: string) => {
    if (maxCost === undefined) {
      throw new Error(`registerReadOnlyTool("${toolName}"): tool has no declared maxCost - it should not call jobberGraphQL`);
    }
    const cost = typeof maxCost === "number" ? maxCost : (maxCost as Record<string, number>)[costKey as string];
    if (cost === undefined) {
      throw new Error(`registerReadOnlyTool("${toolName}"): no maxCost declared for cost key "${String(costKey)}"`);
    }
    return execute(query, variables, cost);
  }) as CostedGraphQL<Cost>;
}

/**
 * The MCP SDK validates a tool's declared inputSchema (Standard Schema's `~standard.validate`)
 * *before* invoking the registered callback - so a shape-invalid call never reaches this file's
 * try/catch-and-audit-log wrapper below, leaving rejected calls with zero audit trail. This wraps
 * the schema's `~standard` entry to observe validation failures and log them, while otherwise
 * delegating untouched to the real Zod object (`{...std, validate: ...}` preserves `jsonSchema`/
 * `vendor`/`version`, so tools/list's advertised schema and successful-call parsing are unchanged
 * - only failures gain a side effect).
 */
function auditValidationFailures<T extends z.ZodTypeAny>(schema: T, toolName: string): T {
  const std = (schema as unknown as { "~standard": Record<string, any> })["~standard"];
  const auditedStd = {
    ...std,
    validate: async (value: unknown) => {
      const result = await std.validate(value);
      if (result?.issues?.length) {
        const message = result.issues.map((i: any) => i.message).join("; ");
        await appendAuditLog({
          tool: toolName,
          args: value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {},
          outcome: "error",
          error_message: `Input validation error: ${message}`,
        });
      }
      return result;
    },
  };
  return Object.create(schema, {
    "~standard": { value: auditedStd, enumerable: true, configurable: true },
  }) as T;
}

/**
 * Registers a read-only tool. Wraps the handler with the standard
 * try/audit-log/catch boilerplate shared by every v1 tool.
 */
export function registerReadOnlyTool<
  Args extends Record<string, z.ZodTypeAny> | undefined,
  Cost extends number | Record<string, number> = number
>(
  server: McpServer,
  name: string,
  config: ToolConfig<Args, Cost>,
  handler: (args: InferArgs<Args>, jobberGraphQL: CostedGraphQL<Cost>) => Promise<ToolResultContent>
): void {
  registerTool(server, name, { ...config, annotations: { readOnlyHint: true, openWorldHint: true, ...config.annotations } }, handler, jobberGraphQL);
}

function registerTool<
  Args extends Record<string, z.ZodTypeAny> | undefined,
  Cost extends number | Record<string, number> = number
>(
  server: McpServer,
  name: string,
  config: ToolConfig<Args, Cost>,
  handler: (args: InferArgs<Args>, jobberGraphQL: CostedGraphQL<Cost>) => Promise<ToolResultContent>,
  execute: GraphQLExecutor
): void {
  const inputSchema = config.inputSchema ? auditValidationFailures(z.object(config.inputSchema), name) : undefined;
  const runQuery = makeCostedGraphQL(name, config.maxCost, execute);

  // The SDK's registerTool overloads are exact-shaped around its full result
  // union (including elicitation's InputRequiredResult, which this wrapper
  // never returns); casting here keeps the public helper signature simple
  // for every tool file without fighting the overload resolver.
  (server.registerTool as (...args: unknown[]) => void)(
    name,
    {
      description: config.description,
      ...(config.annotations ? { annotations: config.annotations } : {}),
      ...(inputSchema ? { inputSchema } : {}),
    },
    async (args: any) => {
      try {
        const result = await handler(args ?? {}, runQuery);
        return result;
      } catch (err: any) {
        await appendAuditLog({ tool: name, args: args ?? {}, outcome: "error", error_message: err.message });
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

export type WriteCapability = "records" | "scheduling" | "communications";

/**
 * A second, narrow gate after JOBBER_READ_ONLY. This lets a host expose record
 * changes without accidentally also exposing scheduling or customer sends.
 */
export function isWriteCapabilityEnabled(capability: WriteCapability): boolean {
  const configured = (process.env.JOBBER_WRITE_CAPABILITIES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes(capability);
}

/**
 * Registers a write tool. Write tools must be deliberately enabled with
 * JOBBER_READ_ONLY=false and use the no-retry mutation client: an ambiguous
 * network failure must never create a duplicate record through an automatic
 * retry. The caller is still responsible for configuring its MCP host to ask
 * for interactive approval before it invokes this tool.
 */
export function registerWriteTool<
  Args extends Record<string, z.ZodTypeAny> | undefined,
  Cost extends number | Record<string, number> = number
>(
  server: McpServer,
  name: string,
  config: ToolConfig<Args, Cost> & { capability: WriteCapability },
  handler: (args: InferArgs<Args>, jobberGraphQL: CostedGraphQL<Cost>) => Promise<ToolResultContent>
): void {
  if (isReadOnly()) {
    throw new Error(
      `Refusing to register write tool "${name}": JOBBER_READ_ONLY is enabled.`
    );
  }
  if (!isWriteCapabilityEnabled(config.capability)) {
    throw new Error(
      `Refusing to register write tool "${name}": JOBBER_WRITE_CAPABILITIES does not include "${config.capability}".`
    );
  }
  registerTool(
    server,
    name,
    {
      ...config,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: config.capability === "communications" || config.capability === "scheduling",
        idempotentHint: false,
        ...config.annotations,
      },
    },
    handler,
    jobberGraphQLWrite
  );
}
