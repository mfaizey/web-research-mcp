import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ErrorCodes, ResearchError } from "./errors.js";

/** Wrap a JSON-serialisable value in the single text block MCP tools return. */
export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

/** Convert any failure into the stable { code, message } error envelope. */
export function errorResult(error: unknown): CallToolResult {
  const failure = toResearchError(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ code: failure.code, message: failure.message }) }],
    isError: true,
  };
}

export function toResearchError(error: unknown): ResearchError {
  if (error instanceof ResearchError) return error;

  if (error instanceof z.ZodError) {
    return new ResearchError(ErrorCodes.InvalidInput, formatZodError(error));
  }

  if (error instanceof Error && error.message.trim() !== "") {
    return new ResearchError(ErrorCodes.InternalError, error.message);
  }

  return new ResearchError(ErrorCodes.InternalError, "Unexpected failure");
}

function formatZodError(error: z.ZodError): string {
  const details = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "input";
    return `${path}: ${issue.message}`;
  });
  return details.length > 0 ? details.join("; ") : "Invalid input";
}
