/**
 * Authentication Middleware
 * Provides Express middleware for requiring authentication
 * and helpers for getting per-user Axigen clients
 */

import { Request, Response, NextFunction } from "express";
import { getSession, UserSession, AxigenCredentials } from "./sessions";
import { isOIDCConfigured } from "./oidc";

/**
 * Extended Request interface with authentication info
 */
export interface AuthenticatedRequest extends Request {
  axigenCredentials: AxigenCredentials;
  user: {
    username: string;
    email: string;
    name: string;
  };
  session: UserSession;
}

/**
 * User context for tool handlers
 * Provides credentials and user info without Express dependency
 */
export interface UserContext {
  credentials: AxigenCredentials;
  user: {
    username: string;
    email: string;
    name: string;
  };
}

/**
 * Middleware to require OAuth authentication
 * Checks for Bearer token and validates session
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Authentication required",
      message: "Please authenticate via OAuth first",
      authUrl: "/oauth/authorize",
    });
    return;
  }

  const sessionId = authHeader.substring(7);
  const session = getSession(sessionId);

  if (!session) {
    res.status(401).json({
      error: "Invalid or expired session",
      message: "Your session has expired. Please re-authenticate.",
      authUrl: "/oauth/authorize",
    });
    return;
  }

  if (!session.axigenCredentials) {
    res.status(403).json({
      error: "Axigen account not linked",
      message: "Please link your email account to continue.",
      linkUrl: `/oauth/link-axigen?session=${sessionId}`,
    });
    return;
  }

  // Attach auth info to request
  (req as AuthenticatedRequest).axigenCredentials = session.axigenCredentials;
  (req as AuthenticatedRequest).user = {
    username: session.username,
    email: session.email,
    name: session.name,
  };
  (req as AuthenticatedRequest).session = session;

  next();
}

/**
 * Optional auth middleware - doesn't fail if not authenticated
 * Useful for endpoints that can work both ways
 */
export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const sessionId = authHeader.substring(7);
    const session = getSession(sessionId);

    if (session && session.axigenCredentials) {
      (req as AuthenticatedRequest).axigenCredentials =
        session.axigenCredentials;
      (req as AuthenticatedRequest).user = {
        username: session.username,
        email: session.email,
        name: session.name,
      };
      (req as AuthenticatedRequest).session = session;
    }
  }

  next();
}

/**
 * Get user context from a session ID
 * Used by MCP handlers to get per-user credentials
 */
export function getUserContextFromSession(
  sessionId: string
): UserContext | null {
  const session = getSession(sessionId);

  if (!session || !session.axigenCredentials) {
    return null;
  }

  return {
    credentials: session.axigenCredentials,
    user: {
      username: session.username,
      email: session.email,
      name: session.name,
    },
  };
}

/**
 * Get user context from an authenticated request
 */
export function getUserContextFromRequest(req: Request): UserContext | null {
  const authReq = req as AuthenticatedRequest;

  if (!authReq.axigenCredentials) {
    return null;
  }

  return {
    credentials: authReq.axigenCredentials,
    user: authReq.user,
  };
}

/**
 * Check if OAuth mode is enabled
 * Returns true if OIDC is configured, false for single-user mode
 */
export function isOAuthEnabled(): boolean {
  return isOIDCConfigured();
}

/**
 * Get the authentication mode description
 */
export function getAuthMode(): "oauth" | "single-user" {
  return isOIDCConfigured() ? "oauth" : "single-user";
}
