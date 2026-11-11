import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  collapseWhitespace,
  documentTitle,
  loadHtml,
  readableText,
  removeNoise,
} from "../lib/html.js";
import { safeFetch } from "../lib/http.js";
import { errorResult, jsonResult } from "../lib/toolResult.js";

export const fetchPageInput = z.object({
  url: z.string().min(1).describe("Absolute http or https URL to fetch."),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(20_000)
    .default(8_000)
    .describe("Maximum number of text characters to return (default 8000, maximum 20000)."),
});

export type FetchPageArgs = z.infer<typeof fetchPageInput>;

export type FetchPageOutput = {
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  truncated: boolean;
};

export type ParsedPageContent = {
  title: string;
  text: string;
  truncated: boolean;
};

/** Parse an HTML document into a title and cleaned, length-limited main text. */
export function parsePageContent(html: string, maxChars: number): ParsedPageContent {
  const $ = loadHtml(html);

  const socialTitle = $(
    'meta[property="og:title"], meta[name="og:title"], meta[name="twitter:title"]',
  )
    .first()
    .attr("content");
  const title =
    documentTitle($) ||
    collapseWhitespace(socialTitle ?? "") ||
    collapseWhitespace($("h1").first().text());

  removeNoise($);
  const fullText = readableText($);
  const truncated = fullText.length > maxChars;
  const text = truncated ? fullText.slice(0, maxChars).trimEnd() : fullText;

  return { title, text, truncated };
}

export const fetchPageTool = {
  name: "fetch_page",
  config: {
    title: "Fetch page",
    description:
      "Fetch one public http(s) page and return its readable main content as clean text. Use this when you need the full body of a page to read, quote, or summarise. Returns JSON with the final URL after redirects, HTTP status, content type, page title, up to maxChars characters of cleaned text, and a truncated flag. Prefer extract_facts instead when you only need metadata, headings, structured data, or sentences about specific terms, because it returns a smaller result.",
    inputSchema: fetchPageInput.shape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async run(rawArgs: unknown): Promise<CallToolResult> {
    try {
      const args = fetchPageInput.parse(rawArgs ?? {});
      const page = await safeFetch(args.url);
      const parsed = parsePageContent(page.body, args.maxChars);

      const output: FetchPageOutput = {
        finalUrl: page.finalUrl,
        status: page.status,
        contentType: page.contentType,
        ...parsed,
      };
      return jsonResult(output);
    } catch (error) {
      return errorResult(error);
    }
  },
} as const;

export function registerFetchPage(server: McpServer): void {
  server.registerTool(fetchPageTool.name, fetchPageTool.config, (args) =>
    fetchPageTool.run(args),
  );
}
