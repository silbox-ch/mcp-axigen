import type { ToolResponse } from "../types/mcp.js";

export class AxigenError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public code?: string
  ) {
    super(message);
    this.name = "AxigenError";
  }
}

export function handleAxiosError(error: unknown): never {
  if (error && typeof error === "object" && "response" in error) {
    const axiosError = error as {
      response?: { status: number; data?: unknown };
      message: string;
    };

    const status = axiosError.response?.status;

    switch (status) {
      case 401:
        throw new AxigenError(
          "Authentication failed. Check credentials.",
          401,
          "AUTH_FAILED"
        );
      case 403:
        throw new AxigenError(
          "Access denied to this resource.",
          403,
          "ACCESS_DENIED"
        );
      case 404:
        throw new AxigenError(
          "Resource not found.",
          404,
          "NOT_FOUND"
        );
      case 429:
        throw new AxigenError(
          "Too many requests. Please wait.",
          429,
          "RATE_LIMITED"
        );
      default:
        if (status && status >= 500) {
          throw new AxigenError(
            "Axigen server error. Try again later.",
            status,
            "SERVER_ERROR"
          );
        }
        throw new AxigenError(
          axiosError.message || "Unknown error occurred",
          status
        );
    }
  }

  if (error instanceof Error) {
    throw new AxigenError(error.message);
  }

  throw new AxigenError("Unknown error occurred");
}

export function formatErrorResponse(error: unknown): ToolResponse {
  const message =
    error instanceof Error ? error.message : "Unknown error occurred";

  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
