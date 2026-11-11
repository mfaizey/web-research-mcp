export const ErrorCodes = {
  InvalidUrl: "INVALID_URL",
  BlockedHost: "BLOCKED_HOST",
  Timeout: "TIMEOUT",
  TooLarge: "TOO_LARGE",
  UnsupportedContentType: "UNSUPPORTED_CONTENT_TYPE",
  HttpError: "HTTP_ERROR",
  TooManyRedirects: "TOO_MANY_REDIRECTS",
  FetchFailed: "FETCH_FAILED",
  InvalidInput: "INVALID_INPUT",
  InternalError: "INTERNAL_ERROR",
  NotImplemented: "not_implemented",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class ResearchError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
  }
}
