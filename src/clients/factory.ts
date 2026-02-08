/**
 * Client Factory
 * Creates API clients with the appropriate credentials based on authentication mode
 */

import { AxigenRestClient } from "./axigen-rest.js";
import { CalDavClient } from "./caldav.js";
import { CardDavClient } from "./carddav.js";
import { ImapClient } from "./imap.js";
import { isOAuthEnabled } from "../config.js";
import { getSession } from "../auth/sessions.js";
import { getAxigenPassword } from "../auth/credentials-store.js";
import type { UserCredentials } from "../types/user-context.js";
import { logger } from "../utils/logger.js";

/**
 * Get user credentials from OAuth session
 * Returns null if not in OAuth mode or session is invalid
 */
export function getCredentialsFromSession(oauthSessionId?: string): UserCredentials | null {
  if (!isOAuthEnabled()) {
    return null; // Single-user mode - use config credentials
  }

  if (!oauthSessionId) {
    logger.warn("[ClientFactory] OAuth enabled but no session ID provided");
    return null;
  }

  const session = getSession(oauthSessionId);
  if (!session) {
    logger.warn(`[ClientFactory] Session not found: ${oauthSessionId}`);
    return null;
  }

  // Get the Axigen password from session or credentials store
  let password: string | null = null;

  if (session.axigenCredentials?.password) {
    // Password is cached in session
    password = session.axigenCredentials.password;
  } else {
    // Try to get from credentials store
    password = getAxigenPassword(session.email);
  }

  if (!password) {
    logger.warn(`[ClientFactory] No Axigen password for user: ${session.email}`);
    return null;
  }

  return {
    email: session.email,
    password,
  };
}

/**
 * Create an Axigen REST client with the appropriate credentials
 * @param oauthSessionId - Optional OAuth session ID for multi-user mode
 */
export function createRestClient(oauthSessionId?: string): AxigenRestClient {
  const credentials = getCredentialsFromSession(oauthSessionId);
  return new AxigenRestClient(credentials || undefined);
}

/**
 * Create a CalDAV client with the appropriate credentials
 * @param oauthSessionId - Optional OAuth session ID for multi-user mode
 */
export function createCalDavClient(oauthSessionId?: string): CalDavClient {
  const credentials = getCredentialsFromSession(oauthSessionId);
  return new CalDavClient(credentials || undefined);
}

/**
 * Create a CardDAV client with the appropriate credentials
 * @param oauthSessionId - Optional OAuth session ID for multi-user mode
 */
export function createCardDavClient(oauthSessionId?: string): CardDavClient {
  const credentials = getCredentialsFromSession(oauthSessionId);
  return new CardDavClient(credentials || undefined);
}

/**
 * Create an IMAP client with the appropriate credentials
 * @param oauthSessionId - Optional OAuth session ID for multi-user mode
 */
export function createImapClient(oauthSessionId?: string): ImapClient {
  const credentials = getCredentialsFromSession(oauthSessionId);
  return new ImapClient(credentials || undefined);
}

/**
 * Validate that credentials are available for the current request
 * @param oauthSessionId - OAuth session ID (if OAuth mode)
 * @returns Error message if credentials are missing, null if OK
 */
export function validateCredentials(oauthSessionId?: string): string | null {
  if (!isOAuthEnabled()) {
    return null; // Single-user mode always has credentials
  }

  if (!oauthSessionId) {
    return "Authentication required. Please login at /oauth/authorize";
  }

  const session = getSession(oauthSessionId);
  if (!session) {
    return "Session expired or invalid. Please login again at /oauth/authorize";
  }

  const password = session.axigenCredentials?.password || getAxigenPassword(session.email);
  if (!password) {
    return "Axigen account not linked. Please complete setup at /oauth/link-axigen";
  }

  return null; // All good
}
