/**
 * Session Management
 * Handles user sessions with OIDC tokens and Axigen credentials
 * In production, consider using Redis for distributed session storage
 */

import crypto from "crypto";
import { getAxigenPassword } from "./credentials-store";

export interface AxigenCredentials {
  user: string;
  password: string;
}

export interface UserSession {
  id: string;
  username: string;
  email: string;
  name: string;
  axigenCredentials: AxigenCredentials | null;
  oidcAccessToken: string;
  oidcRefreshToken?: string;
  oidcExpiresAt?: Date;
  createdAt: Date;
  expiresAt: Date;
  needsAxigenLink: boolean;
  lastActivity: Date;
}

// In-memory session store
// In production, use Redis or another distributed store
const sessions = new Map<string, UserSession>();

// Session configuration
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a secure session ID
 */
function generateSessionId(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create a new session after OIDC authentication
 * Automatically links Axigen credentials if already stored
 */
export function createSession(
  username: string,
  email: string,
  name: string,
  oidcAccessToken: string,
  oidcRefreshToken?: string,
  oidcExpiresIn?: number
): { sessionId: string; needsAxigenLink: boolean } {
  const sessionId = generateSessionId();

  // Check if we already have Axigen credentials for this user
  const axigenPassword = getAxigenPassword(email);
  const needsAxigenLink = axigenPassword === null;

  const now = new Date();
  const session: UserSession = {
    id: sessionId,
    username,
    email,
    name,
    axigenCredentials: axigenPassword
      ? { user: email, password: axigenPassword }
      : null,
    oidcAccessToken,
    oidcRefreshToken,
    oidcExpiresAt: oidcExpiresIn
      ? new Date(now.getTime() + oidcExpiresIn * 1000)
      : undefined,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_DURATION_MS),
    needsAxigenLink,
    lastActivity: now,
  };

  sessions.set(sessionId, session);

  console.log(
    `[Sessions] Created session for ${email} (needsAxigenLink: ${needsAxigenLink})`
  );

  return { sessionId, needsAxigenLink };
}

/**
 * Get a session by ID
 * Returns null if session doesn't exist or is expired
 */
export function getSession(sessionId: string): UserSession | null {
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  // Check if expired
  if (session.expiresAt < new Date()) {
    sessions.delete(sessionId);
    console.log(`[Sessions] Session expired for ${session.email}`);
    return null;
  }

  // Update last activity
  session.lastActivity = new Date();

  return session;
}

/**
 * Update a session with Axigen credentials after linking
 */
export function updateSessionWithAxigenCredentials(
  sessionId: string,
  password: string
): boolean {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.axigenCredentials = {
    user: session.email,
    password,
  };
  session.needsAxigenLink = false;
  session.lastActivity = new Date();

  console.log(`[Sessions] Linked Axigen credentials for ${session.email}`);

  return true;
}

/**
 * Update OIDC tokens (after refresh)
 */
export function updateSessionTokens(
  sessionId: string,
  accessToken: string,
  refreshToken?: string,
  expiresIn?: number
): boolean {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.oidcAccessToken = accessToken;
  if (refreshToken) {
    session.oidcRefreshToken = refreshToken;
  }
  if (expiresIn) {
    session.oidcExpiresAt = new Date(Date.now() + expiresIn * 1000);
  }
  session.lastActivity = new Date();

  return true;
}

/**
 * Delete a session (logout)
 */
export function deleteSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    console.log(`[Sessions] Deleted session for ${session.email}`);
    sessions.delete(sessionId);
  }
}

/**
 * Check if a session is ready for Axigen operations
 * (has both OIDC auth and linked Axigen credentials)
 */
export function isSessionReady(sessionId: string): boolean {
  const session = getSession(sessionId);
  return session !== null && session.axigenCredentials !== null;
}

/**
 * Find the first active session for a user email
 * Returns null if no active session exists
 */
export function findSessionByEmail(email: string): UserSession | null {
  const normalizedEmail = email.toLowerCase();

  for (const session of sessions.values()) {
    if (
      session.email.toLowerCase() === normalizedEmail &&
      session.expiresAt > new Date()
    ) {
      return session;
    }
  }

  return null;
}

/**
 * Get all active sessions for a user email
 */
export function getSessionsByEmail(email: string): UserSession[] {
  const normalizedEmail = email.toLowerCase();
  const userSessions: UserSession[] = [];

  for (const session of sessions.values()) {
    if (
      session.email.toLowerCase() === normalizedEmail &&
      session.expiresAt > new Date()
    ) {
      userSessions.push(session);
    }
  }

  return userSessions;
}

/**
 * Invalidate all sessions for a user (e.g., when password changes)
 */
export function invalidateSessionsForEmail(email: string): number {
  const normalizedEmail = email.toLowerCase();
  let count = 0;

  for (const [sessionId, session] of sessions.entries()) {
    if (session.email.toLowerCase() === normalizedEmail) {
      sessions.delete(sessionId);
      count++;
    }
  }

  if (count > 0) {
    console.log(
      `[Sessions] Invalidated ${count} session(s) for ${normalizedEmail}`
    );
  }

  return count;
}

/**
 * Get session statistics
 */
export function getSessionStats(): {
  totalSessions: number;
  activeSessions: number;
  linkedSessions: number;
} {
  const now = new Date();
  let activeSessions = 0;
  let linkedSessions = 0;

  for (const session of sessions.values()) {
    if (session.expiresAt > now) {
      activeSessions++;
      if (session.axigenCredentials) {
        linkedSessions++;
      }
    }
  }

  return {
    totalSessions: sessions.size,
    activeSessions,
    linkedSessions,
  };
}

/**
 * Clean up expired sessions
 */
export function cleanupExpiredSessions(): number {
  const now = new Date();
  let cleanedUp = 0;

  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt < now) {
      sessions.delete(sessionId);
      cleanedUp++;
    }
  }

  if (cleanedUp > 0) {
    console.log(`[Sessions] Cleaned up ${cleanedUp} expired session(s)`);
  }

  return cleanedUp;
}

// Start periodic cleanup
let cleanupInterval: NodeJS.Timeout | null = null;

export function startSessionCleanup(): void {
  if (cleanupInterval) {
    return;
  }
  cleanupInterval = setInterval(
    cleanupExpiredSessions,
    SESSION_CLEANUP_INTERVAL_MS
  );
  console.log("[Sessions] Started session cleanup interval");
}

export function stopSessionCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log("[Sessions] Stopped session cleanup interval");
  }
}
