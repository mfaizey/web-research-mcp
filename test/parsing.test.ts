import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseFacts } from "../src/tools/extractFacts.js";
import { parsePageContent } from "../src/tools/fetchPage.js";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const blog = await fixture("blog-article.html");
const docs = await fixture("docs-page.html");
const messy = await fixture("messy-page.html");

const BLOG_URL = "https://research.example/blog/offline-tests";

describe("parsePageContent", () => {
  it("extracts the article body and ignores site chrome", () => {
    const page = parsePageContent(blog, 8_000);

    expect(page.title).toBe("Why offline tests matter | Example Research");
    expect(page.truncated).toBe(false);
    expect(page.text).toContain("Offline tests make continuous integration fast");
    expect(page.text).toContain("Saved HTML fixtures reproduce real pages");
    expect(page.text).toContain("A mocked fetch can simulate a timeout");
    expect(page.text).not.toContain("Home | Blog | About");
    expect(page.text).not.toContain("All rights reserved");
  });

  it("drops nav, advertisements, forms, and scripts from a messy page", () => {
    const page = parsePageContent(messy, 8_000);

    expect(page.title).toBe("Messy page");
    expect(page.text).toContain("This paragraph is real content & should survive.");
    expect(page.text).toContain("More real content.");
    expect(page.text).not.toContain("Site banner");
    expect(page.text).not.toContain("Advertisement");
    expect(page.text).not.toContain("Newsletter");
    expect(page.text).not.toContain("Footer junk");
    expect(page.text).not.toContain("script junk");
  });

  it("truncates long documents at maxChars", () => {
    const page = parsePageContent(docs, 40);

    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThanOrEqual(40);
  });
});

describe("parseFacts", () => {
  it("reads metadata from meta tags, Open Graph, and JSON-LD", () => {
    const facts = parseFacts(blog, BLOG_URL);

    expect(facts.metadata).toEqual({
      title: "Why offline tests matter | Example Research",
      description: "A short article about reliable testing.",
      canonicalUrl: "https://research.example/blog/offline-tests",
      author: "Ada Lovelace",
      publishedDate: "2026-02-03",
      siteName: "Example Research",
      language: "en",
    });
    expect(facts.jsonLdTypes).toEqual(["WebSite", "BlogPosting"]);
    expect(facts.facts).toBeUndefined();
  });

  it("returns at most 20 h1-h3 headings from a docs page", () => {
    const facts = parseFacts(docs, "https://docs.example/reference");

    expect(facts.headings).toHaveLength(20);
    expect(facts.headings[0]).toEqual({ level: 1, text: "API Reference" });
    expect(facts.headings.at(-1)).toEqual({ level: 3, text: "Deprecation" });
    expect(facts.headings.some((heading) => heading.text === "Changelog")).toBe(false);
    expect(facts.headings.some((heading) => heading.text === "Documentation menu")).toBe(false);
  });

  it("matches focused sentences and attaches their nearest heading", () => {
    const facts = parseFacts(messy, "https://messy.example/page", {
      focus: ["real content"],
    });

    expect(facts.headings).toEqual([
      { level: 1, text: "Clean content" },
      { level: 2, text: "Details" },
    ]);
    expect(facts.facts).toEqual([
      {
        text: "This paragraph is real content & should survive.",
        heading: "Clean content",
      },
      { text: "More real content.", heading: "Details" },
    ]);
  });

  it("respects maxFacts", () => {
    const facts = parseFacts(blog, BLOG_URL, { focus: ["fixture"], maxFacts: 1 });

    expect(facts.facts).toHaveLength(1);
  });
});
