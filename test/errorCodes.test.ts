import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ErrorCodes, ResearchError, type ErrorCode } from "../src/lib/errors.js";
import { errorResult } from "../src/lib/toolResult.js";
import { fetchPageInput } from "../src/tools/fetchPage.js";

function body(result: CallToolResult): { code: string; message: string } {
  expect(result.isError).toBe(true);
  const first = result.content[0];
  if (first === undefined || first.type !== "text") throw new Error("missing text content");
  return JSON.parse(first.text) as { code: string; message: string };
}

describe("error envelope", () => {
  for (const code of Object.values(ErrorCodes) as ErrorCode[]) {
    it(`preserves ${code}`, () => {
      const result = errorResult(new ResearchError(code, `failure for ${code}`));
      expect(body(result)).toEqual({ code, message: `failure for ${code}` });
    });
  }

  it("maps zod validation failures to INVALID_INPUT", () => {
    const parsed = fetchPageInput.safeParse({ url: 42, maxChars: "lots" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const result = errorResult(parsed.error);
    const error = body(result);
    expect(error.code).toBe(ErrorCodes.InvalidInput);
    expect(error.message).toContain("url");
    expect(error.message).toContain("maxChars");
  });

  it("maps unexpected exceptions to INTERNAL_ERROR", () => {
    expect(body(errorResult(new Error("boom")))).toEqual({
      code: ErrorCodes.InternalError,
      message: "boom",
    });
    expect(body(errorResult("not an error"))).toEqual({
      code: ErrorCodes.InternalError,
      message: "Unexpected failure",
    });
  });
});
