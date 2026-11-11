import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";

/** Chrome and boilerplate that is never part of the readable main content. */
export const NOISE_SELECTOR = "script, style, nav, header, footer, aside, form";

export const BLOCK_SELECTOR =
  "address, article, blockquote, dd, div, dl, dt, fieldset, figcaption, figure, h1, h2, h3, h4, h5, h6, li, main, ol, p, pre, section, table, td, th, tr, ul";

export function loadHtml(html: string): CheerioAPI {
  return cheerio.load(html);
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function removeNoise($: CheerioAPI): void {
  $(NOISE_SELECTOR).remove();
}

/** Prefer the first article, then main, then the whole body. */
export function contentRoot($: CheerioAPI): ReturnType<CheerioAPI> {
  const article = $("article").first();
  if (article.length > 0) return article;

  const main = $("main").first();
  if (main.length > 0) return main;

  return $("body");
}

export function documentTitle($: CheerioAPI): string {
  return collapseWhitespace($("title").first().text());
}

/**
 * Readable text from the page's main content. Block boundaries become spaces
 * so adjacent paragraphs do not run together before whitespace is collapsed.
 */
export function readableText($: CheerioAPI): string {
  const root = contentRoot($);
  const clone = root.clone();
  clone.find("br").replaceWith(" ");
  clone.find(BLOCK_SELECTOR).each((_index, element) => {
    $(element).append(" ");
  });
  return collapseWhitespace(clone.text());
}

/** Resolve a possibly-relative URL, returning the original on failure. */
export function absoluteUrl(value: string | undefined, base: string): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
