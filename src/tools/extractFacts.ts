import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CheerioAPI } from "cheerio";
import { z } from "zod";
import {
  absoluteUrl,
  collapseWhitespace,
  contentRoot,
  documentTitle,
  isRecord,
  loadHtml,
  removeNoise,
} from "../lib/html.js";
import { safeFetch } from "../lib/http.js";
import { errorResult, jsonResult } from "../lib/toolResult.js";

export const extractFactsInput = z.object({
  url: z.string().min(1).describe("Absolute http or https URL to analyse."),
  focus: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      "Optional terms to look for. Sentences containing any term are returned with their nearest preceding heading.",
    ),
  maxFacts: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe("Maximum number of focus-matching sentences to return (default 10, maximum 25)."),
});

export type ExtractFactsArgs = z.infer<typeof extractFactsInput>;

export type PageMetadata = {
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  author: string | null;
  publishedDate: string | null;
  siteName: string | null;
  language: string | null;
};

export type Heading = { level: number; text: string };
export type Fact = { text: string; heading: string | null };

export type ExtractFactsOutput = {
  metadata: PageMetadata;
  headings: Heading[];
  jsonLdTypes: string[];
  facts?: Fact[];
};

type JsonLdNode = Record<string, unknown>;

const MAX_HEADINGS = 20;
const BLOCK_CANDIDATES =
  "h1, h2, h3, h4, h5, h6, p, li, blockquote, td, dd, figcaption, div, section";
const NESTED_BLOCK = "p, li, blockquote, td, dd, figcaption, div, section, h1, h2, h3, h4, h5, h6";

export const extractFactsTool = {
  name: "extract_facts",
  config: {
    title: "Extract facts",
    description:
      "Fetch one public http(s) page and extract compact, structured facts without returning the whole page. Returns JSON with metadata (title, description, canonical URL, author, published date, site name, language) gathered from meta tags, Open Graph and JSON-LD; the first 20 h1-h3 headings; all JSON-LD @type values in jsonLdTypes; and, when focus terms are supplied, up to maxFacts matching sentences in the facts array, each with its text and nearest preceding heading. Use this for quick factual lookups, citation details, or scanning a page for specific terms; prefer fetch_page when you need the full readable text.",
    inputSchema: extractFactsInput.shape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async run(rawArgs: unknown): Promise<CallToolResult> {
    try {
      const args = extractFactsInput.parse(rawArgs ?? {});
      const page = await safeFetch(args.url);
      return jsonResult(
        parseFacts(page.body, page.finalUrl, {
          focus: args.focus,
          maxFacts: args.maxFacts,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
} as const;

export type ExtractFactsOptions = {
  focus?: string[];
  maxFacts?: number;
};

/** Parse a fetched HTML document into metadata, headings, and optional facts. */
export function parseFacts(
  html: string,
  finalUrl: string,
  options: ExtractFactsOptions = {},
): ExtractFactsOutput {
  const $ = loadHtml(html);

  const jsonLdNodes = readJsonLd($);
  const meta = readMeta($);

  removeNoise($);

  const metadata = readMetadata($, meta, jsonLdNodes, finalUrl);
  const headings = readHeadings($);
  const jsonLdTypes = readJsonLdTypes(jsonLdNodes);

  const output: ExtractFactsOutput = { metadata, headings, jsonLdTypes };
  if (options.focus !== undefined) {
    output.facts = readFacts($, options.focus, options.maxFacts ?? 10);
  }
  return output;
}

export function registerExtractFacts(server: McpServer): void {
  server.registerTool(extractFactsTool.name, extractFactsTool.config, (args) =>
    extractFactsTool.run(args),
  );
}

function readMeta($: CheerioAPI): Map<string, string> {
  const values = new Map<string, string>();
  $("meta").each((_index, element) => {
    const key = (
      $(element).attr("name") ??
      $(element).attr("property") ??
      $(element).attr("itemprop") ??
      $(element).attr("http-equiv") ??
      ""
    )
      .trim()
      .toLowerCase();
    const content = $(element).attr("content")?.trim();
    if (key !== "" && content !== undefined && content !== "" && !values.has(key)) {
      values.set(key, content);
    }
  });
  return values;
}

function readJsonLd($: CheerioAPI): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  $("script").each((_index, element) => {
    const type = ($(element).attr("type") ?? "").toLowerCase();
    if (!type.includes("ld+json")) return;

    const raw = $(element).text().trim();
    if (raw === "") return;

    try {
      nodes.push(...flattenJsonLd(JSON.parse(raw)));
    } catch {
      // Invalid JSON-LD is common on real pages; ignore that block.
    }
  });
  return nodes;
}

function flattenJsonLd(value: unknown): JsonLdNode[] {
  if (Array.isArray(value)) return value.flatMap((item) => flattenJsonLd(item));
  if (!isRecord(value)) return [];

  const graph = value["@graph"];
  if (graph === undefined) return [value];
  return [value, ...flattenJsonLd(graph)];
}

function readJsonLdTypes(nodes: JsonLdNode[]): string[] {
  const types = new Set<string>();
  for (const node of nodes) {
    const value = node["@type"];
    if (typeof value === "string" && value.trim() !== "") {
      types.add(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim() !== "") types.add(item.trim());
      }
    }
  }
  return [...types];
}

function readMetadata(
  $: CheerioAPI,
  meta: Map<string, string>,
  jsonLd: JsonLdNode[],
  finalUrl: string,
): PageMetadata {
  const title =
    documentTitle($) ||
    meta.get("og:title") ||
    meta.get("twitter:title") ||
    jsonLdString(jsonLd, ["headline", "name"]);

  const description =
    meta.get("description") ||
    meta.get("og:description") ||
    meta.get("twitter:description") ||
    jsonLdString(jsonLd, ["description"]);

  const canonical =
    canonicalHref($) ??
    meta.get("og:url") ??
    jsonLdString(jsonLd, ["url"]) ??
    jsonLdMainEntityUrl(jsonLd);

  const metaAuthor =
    meta.get("author") ?? meta.get("article:author") ?? meta.get("dc.creator") ?? undefined;
  const jsonLdAuthor = namesFromValue(jsonLdValue(jsonLd, ["author"])).join(", ");
  const author = metaAuthor ?? (jsonLdAuthor === "" ? undefined : jsonLdAuthor);

  const publishedDate =
    meta.get("article:published_time") ??
    meta.get("datepublished") ??
    meta.get("date") ??
    meta.get("pubdate") ??
    meta.get("dc.date") ??
    jsonLdString(jsonLd, ["datePublished", "dateCreated", "uploadDate"]);

  const siteName =
    meta.get("og:site_name") ??
    meta.get("application-name") ??
    namesFromValue(jsonLdValue(jsonLd, ["publisher"]))[0] ??
    namesFromValue(jsonLdValue(jsonLd, ["isPartOf"]))[0];

  const language =
    clean($("html").first().attr("lang")) ??
    meta.get("content-language") ??
    meta.get("og:locale") ??
    jsonLdString(jsonLd, ["inLanguage"]);

  return {
    title: clean(title) ?? null,
    description: clean(description) ?? null,
    canonicalUrl: absoluteUrl(clean(canonical), finalUrl) ?? null,
    author: clean(author) ?? null,
    publishedDate: clean(publishedDate) ?? null,
    siteName: clean(siteName) ?? null,
    language: clean(language) ?? null,
  };
}

function canonicalHref($: CheerioAPI): string | undefined {
  let href: string | undefined;
  $("link[rel]").each((_index, element) => {
    if (href !== undefined) return;
    const rel = ($(element).attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("canonical")) href = clean($(element).attr("href"));
  });
  return href;
}

function readHeadings($: CheerioAPI): Heading[] {
  const headings: Heading[] = [];
  $("h1, h2, h3").each((_index, element) => {
    if (headings.length >= MAX_HEADINGS) return false;
    const text = collapseWhitespace($(element).text());
    if (text !== "") {
      const level = Number.parseInt((element as { tagName: string }).tagName.slice(1), 10);
      headings.push({ level, text });
    }
    return;
  });
  return headings;
}

function readFacts($: CheerioAPI, focus: string[], maxFacts: number): Fact[] {
  const terms = focus.map((term) => collapseWhitespace(term).toLowerCase()).filter(Boolean);
  if (terms.length === 0) return [];

  const facts: Fact[] = [];
  const root = contentRoot($);
  let heading: string | null = null;

  for (const element of root.find(BLOCK_CANDIDATES).toArray()) {
    if (facts.length >= maxFacts) break;

    const tag = (element as { tagName: string }).tagName.toLowerCase();
    const text = collapseWhitespace($(element).text());
    if (text === "") continue;

    if (/^h[1-6]$/.test(tag)) {
      heading = text;
      continue;
    }

    // Container elements are covered by their child blocks. Skipping them
    // avoids duplicating the same sentence at several nesting levels.
    if ($(element).find(NESTED_BLOCK).length > 0) continue;

    for (const sentence of splitSentences(text)) {
      if (facts.length >= maxFacts) break;
      const lower = sentence.toLowerCase();
      if (terms.some((term) => lower.includes(term))) {
        facts.push({ text: sentence, heading });
      }
    }
  }

  return facts;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => collapseWhitespace(sentence))
    .filter((sentence) => sentence !== "");
}

function jsonLdValue(nodes: JsonLdNode[], keys: string[]): unknown {
  // Key order expresses precedence, so check every node for the most specific
  // key before falling back to a broader key on an earlier node.
  for (const key of keys) {
    for (const node of nodes) {
      if (node[key] !== undefined) return node[key];
    }
  }
  return undefined;
}

function jsonLdString(nodes: JsonLdNode[], keys: string[]): string | undefined {
  const value = jsonLdValue(nodes, keys);
  return namesFromValue(value)[0];
}

function jsonLdMainEntityUrl(nodes: JsonLdNode[]): string | undefined {
  const value = jsonLdValue(nodes, ["mainEntityOfPage"]);
  if (typeof value === "string") return clean(value);
  if (isRecord(value)) {
    return clean(value["@id"]) ?? clean(value.url);
  }
  return undefined;
}

function namesFromValue(value: unknown): string[] {
  if (typeof value === "string") {
    const name = clean(value);
    return name === undefined ? [] : [name];
  }
  if (Array.isArray(value)) return value.flatMap((item) => namesFromValue(item));
  if (isRecord(value)) {
    return namesFromValue(value.name ?? value["@id"] ?? value.url);
  }
  return [];
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = collapseWhitespace(value);
  return trimmed === "" ? undefined : trimmed;
}
