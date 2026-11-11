import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const targetUrl = process.env.SMOKE_URL ?? "https://example.com/";

try {
  await access(serverEntry);
} catch {
  console.error(`Built server not found at ${serverEntry}. Run "npm run build" first.`);
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: projectRoot,
  stderr: "inherit",
});

const client = new Client({
  name: "web-research-mcp-smoke",
  version: "0.1.0",
});

function textBody(result: unknown, label: string): Record<string, unknown> {
  const toolResult = result as CallToolResult;
  const first = toolResult.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error(`${label}: expected a text content block`);
  }

  if (toolResult.isError === true) {
    throw new Error(`${label} failed: ${first.text}`);
  }

  return JSON.parse(first.text) as Record<string, unknown>;
}

function print(label: string, value: Record<string, unknown>): void {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  const expected = ["extract_facts", "fetch_page"];
  if (names.join(",") !== expected.join(",")) {
    throw new Error(`unexpected tools: ${names.join(", ")}`);
  }
  console.log(`tools: ${names.join(", ")}`);

  const page = textBody(
    await client.callTool({
      name: "fetch_page",
      arguments: { url: targetUrl, maxChars: 2_000 },
    }),
    "fetch_page",
  );
  if (typeof page.text !== "string" || typeof page.finalUrl !== "string") {
    throw new Error("fetch_page returned an unexpected result shape");
  }
  print(`fetch_page ${targetUrl}`, page);

  const facts = textBody(
    await client.callTool({
      name: "extract_facts",
      arguments: {
        url: targetUrl,
        focus: ["example", "documentation"],
        maxFacts: 3,
      },
    }),
    "extract_facts",
  );
  if (typeof facts.metadata !== "object" || !Array.isArray(facts.headings)) {
    throw new Error("extract_facts returned an unexpected result shape");
  }
  print(`extract_facts ${targetUrl}`, facts);

  console.log("\nsmoke ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
