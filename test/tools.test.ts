import { readFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractFactsTool } from "../src/tools/extractFacts.js";
import { fetchPageTool } from "../src/tools/fetchPage.js";

const PAGE_URL = "http://8.8.8.8/page";
const blog = await readFile(new URL("./fixtures/blog-article.html", import.meta.url), "utf8");

function stubPage(html: string, status = 200): void {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(html, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ),
  );
}

function body(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") throw new Error("missing text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function ok(result: Promise<CallToolResult>): Promise<Record<string, unknown>> {
  const resolved = await result;
  expect(resolved.isError).not.toBe(true);
  return body(resolved);
}

function errorBody(result: CallToolResult): { code: string; message: string } {
  expect(result.isError).toBe(true);
  const parsed = body(result);
  expect(typeof parsed.code).toBe("string");
  expect(typeof parsed.message).toBe("string");
  return parsed as { code: string; message: string };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetch_page", () => {
  it("returns cleaned main content and page details", async () => {
    stubPage(blog);

    const output = await ok(fetchPageTool.run({ url: PAGE_URL }));
    expect(output).toMatchObject({
      finalUrl: PAGE_URL,
      status: 200,
      contentType: "text/html",
      title: "Why offline tests matter | Example Research",
      truncated: false,
    });
    expect(output.text).toContain("Offline tests make continuous integration fast");
    expect(output.text).toContain("Saved HTML fixtures reproduce real pages");
    expect(output.text).not.toContain("Home | Blog | About");
    expect(output.text).not.toContain("All rights reserved");
  });

  it("truncates to maxChars and reports it", async () => {
    stubPage(blog);

    const output = await ok(fetchPageTool.run({ url: PAGE_URL, maxChars: 20 }));
    expect(output.truncated).toBe(true);
    expect(String(output.text).length).toBeLessThanOrEqual(20);
  });

  it("returns an error envelope for bad input and HTTP failures", async () => {
    expect(errorBody(await fetchPageTool.run({ url: "" })).code).toBe("INVALID_INPUT");
    expect(errorBody(await fetchPageTool.run({})).code).toBe("INVALID_INPUT");
    expect(
      errorBody(await fetchPageTool.run({ url: PAGE_URL, maxChars: 20_001 })).code,
    ).toBe("INVALID_INPUT");
    expect(errorBody(await fetchPageTool.run({ url: "file:///etc/passwd" })).code).toBe(
      "INVALID_URL",
    );

    stubPage("unavailable", 503);
    expect(errorBody(await fetchPageTool.run({ url: PAGE_URL })).code).toBe("HTTP_ERROR");
  });
});

describe("extract_facts", () => {
  it("extracts metadata, headings, JSON-LD types, and focused facts", async () => {
    stubPage(blog);

    const output = await ok(
      extractFactsTool.run({
        url: PAGE_URL,
        focus: ["fixture", "mocked"],
      }),
    );

    expect(output.metadata).toEqual({
      title: "Why offline tests matter | Example Research",
      description: "A short article about reliable testing.",
      canonicalUrl: "https://research.example/blog/offline-tests",
      author: "Ada Lovelace",
      publishedDate: "2026-02-03",
      siteName: "Example Research",
      language: "en",
    });
    expect(output.headings).toEqual([
      { level: 1, text: "Why offline tests matter" },
      { level: 2, text: "Fixtures" },
      { level: 3, text: "Mocking network failures" },
    ]);
    expect(output.jsonLdTypes).toEqual(["WebSite", "BlogPosting"]);
    expect(output.facts).toEqual([
      {
        text: "Saved HTML fixtures reproduce real pages without a network connection.",
        heading: "Fixtures",
      },
      {
        text: "Each fixture should stay small enough to review in a pull request.",
        heading: "Fixtures",
      },
      {
        text: "A mocked fetch can simulate a timeout, an HTTP error, or a redirect loop.",
        heading: "Mocking network failures",
      },
    ]);
  });

  it("limits matches and omits facts when no focus is supplied", async () => {
    stubPage(blog);

    const withoutFocus = await ok(extractFactsTool.run({ url: PAGE_URL }));
    expect(withoutFocus.facts).toBeUndefined();

    const limited = await ok(
      extractFactsTool.run({ url: PAGE_URL, focus: ["fixture"], maxFacts: 1 }),
    );
    expect(limited.facts).toHaveLength(1);
  });

  it("returns an error envelope for bad input", async () => {
    expect(errorBody(await extractFactsTool.run({ url: PAGE_URL, focus: "2026" })).code).toBe(
      "INVALID_INPUT",
    );
    expect(
      errorBody(await extractFactsTool.run({ url: PAGE_URL, focus: ["x"], maxFacts: 26 })).code,
    ).toBe("INVALID_INPUT");
  });
});
