/**
 * Request Context
 * Uses AsyncLocalStorage to pass OAuth session ID through the request chain
 * This allows tools to access the current user's credentials without explicit parameter passing
 */

import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  oauthSessionId?: string;
  mcpSessionId?: string;
}

// Global async local storage for request context
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a function with a specific request context
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

/**
 * Get the current request context
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Get the current OAuth session ID from context
 */
export function getCurrentOAuthSessionId(): string | undefined {
  return requestContextStorage.getStore()?.oauthSessionId;
}

/**
 * Map of MCP session IDs to OAuth session IDs
 * This persists the OAuth session association across MCP requests
 */
const mcpToOAuthSessionMap = new Map<string, string>();

/**
 * Associate an MCP session with an OAuth session
 */
export function associateMcpWithOAuthSession(mcpSessionId: string, oauthSessionId: string): void {
  mcpToOAuthSessionMap.set(mcpSessionId, oauthSessionId);
}

/**
 * Get the OAuth session ID associated with an MCP session
 */
export function getOAuthSessionForMcp(mcpSessionId: string): string | undefined {
  return mcpToOAuthSessionMap.get(mcpSessionId);
}

/**
 * Remove the OAuth session association for an MCP session
 */
export function removeMcpSessionAssociation(mcpSessionId: string): void {
  mcpToOAuthSessionMap.delete(mcpSessionId);
}

/**
 * Clear all session associations (for cleanup)
 */
export function clearAllSessionAssociations(): void {
  mcpToOAuthSessionMap.clear();
}
