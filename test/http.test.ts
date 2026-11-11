import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, ResearchError } from "../src/lib/errors.js";
import { safeFetch } from "../src/lib/http.js";

const PUBLIC = "http://8.8.8.8/page";

async function fetchCode(url = PUBLIC): Promise<string> {
  try {
    await safeFetch(url);
    return "ok";
  } catch (error) {
    if (error instanceof ResearchError) return error.code;
    throw error;
  }
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("safeFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns html and follows a redirect to another public URL", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL) => {
      const href = input instanceof URL ? input.href : input;
      seen.push(href);
      if (seen.length === 1) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "http://1.1.1.1/next" } }),
        );
      }
      return Promise.resolve(htmlResponse("<p>ok</p>"));
    });

    const page = await safeFetch(PUBLIC);
    expect(seen).toEqual([PUBLIC, "http://1.1.1.1/next"]);
    expect(page).toMatchObject({
      finalUrl: "http://1.1.1.1/next",
      status: 200,
      contentType: "text/html",
      body: "<p>ok</p>",
    });
  });

  it("re-checks every redirect and stops after five", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
      ),
    );
    expect(await fetchCode()).toBe(ErrorCodes.BlockedHost);

    let hops = 0;
    vi.stubGlobal("fetch", (input: string | URL) => {
      const url = new URL(input instanceof URL ? input.href : input);
      const hop = Number(url.pathname.slice(1) || "0");
      hops += 1;
      return Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: `http://1.0.0.${hop + 1}/${hop + 1}` },
        }),
      );
    });
    expect(await fetchCode("http://1.0.0.1/0")).toBe(ErrorCodes.TooManyRedirects);
    expect(hops).toBe(6);
  });

  it("rejects non-html responses, http errors, and bodies over 2 MB", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("hi", { status: 200, headers: { "content-type": "text/plain" } })),
    );
    expect(await fetchCode()).toBe(ErrorCodes.UnsupportedContentType);

    vi.stubGlobal("fetch", () => Promise.resolve(htmlResponse("missing", 503)));
    expect(await fetchCode()).toBe(ErrorCodes.HttpError);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/xhtml+xml" },
        }),
      ),
    );
    expect(await fetchCode()).toBe(ErrorCodes.TooLarge);
  });

  it("rejects unsafe URLs before making a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect(await fetchCode("file:///etc/passwd")).toBe(ErrorCodes.InvalidUrl);
    expect(await fetchCode("http://127.0.0.1/")).toBe(ErrorCodes.BlockedHost);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports network failures as FETCH_FAILED", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    expect(await fetchCode()).toBe(ErrorCodes.FetchFailed);
  });

  it("aborts the request after 10 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_input: string | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const abort = (): void => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort);
      });
    });

    const pending = safeFetch(PUBLIC);
    const assertion = expect(pending).rejects.toMatchObject({ code: ErrorCodes.Timeout });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});
