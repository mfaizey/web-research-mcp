#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCodes, ResearchError } from "./lib/errors.js";
import { errorResult } from "./lib/toolResult.js";
import { registerExtractFacts } from "./tools/extractFacts.js";
import { registerFetchPage } from "./tools/fetchPage.js";

const server = new McpServer({
  name: "web-research-mcp",
  version: "0.1.0",
});

jsonifySdkToolErrors(server);
registerFetchPage(server);
registerExtractFacts(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

/**
 * The SDK rejects schema-invalid arguments before a tool handler runs and
 * normally returns a plain-text error. Keep the { code, message } envelope
 * consistent by routing those errors through the same formatter.
 */
function jsonifySdkToolErrors(target: McpServer): void {
  const internals = target as unknown as {
    createToolError: (message: string) => CallToolResult;
  };
  internals.createToolError = (message: string) => {
    const code = message.includes("Input validation error")
      ? ErrorCodes.InvalidInput
      : ErrorCodes.InternalError;
    return errorResult(new ResearchError(code, message));
  };
}

export async function runTool(
  tool: string,
  args: { url?: string },
  handler: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = performance.now();
  let outcome: "ok" | "error" = "ok";
  try {
    const result = await handler();
    if (result.isError === true) outcome = "error";
    return result;
  } catch (error) {
    outcome = "error";
    return errorResult(error);
  } finally {
    console.error(
      JSON.stringify({
        tool,
        host: hostnameOf(args.url),
        durationMs: Math.round(performance.now() - started),
        outcome,
      }),
    );
  }
}

function hostnameOf(raw: string | undefined): string {
  if (raw === undefined || raw === "") return "";
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}
