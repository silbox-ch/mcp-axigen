/**
 * Authentication Module Exports
 * Central export point for all auth-related functionality
 */

// OIDC client
export {
  isOIDCConfigured,
  getOIDCConfig,
  getAuthorizationServer,
  getAuthorizationUrl,
  exchangeCodeForTokens,
  getUserInfo,
  refreshTokens,
  generatePKCE,
  generateState,
  getProviderMetadata,
  clearOIDCCache,
} from "./oidc.js";

// Credentials store
export {
  encryptPassword,
  decryptPassword,
  storeAxigenPassword,
  getAxigenPassword,
  hasAxigenPassword,
  deleteAxigenPassword,
  listStoredEmails,
  getCredentialMetadata,
} from "./credentials-store.js";

// Session management
export {
  createSession,
  getSession,
  updateSessionWithAxigenCredentials,
  updateSessionTokens,
  deleteSession,
  isSessionReady,
  getSessionsByEmail,
  invalidateSessionsForEmail,
  getSessionStats,
  cleanupExpiredSessions,
  startSessionCleanup,
  stopSessionCleanup,
} from "./sessions.js";
export type { UserSession, AxigenCredentials } from "./sessions.js";

// Middleware
export {
  requireAuth,
  optionalAuth,
  getUserContextFromSession,
  getUserContextFromRequest,
  isOAuthEnabled,
  getAuthMode,
} from "./middleware.js";
export type { AuthenticatedRequest, UserContext } from "./middleware.js";

// Token store (persistent MCP OAuth tokens)
export {
  storeToken,
  getToken,
  getTokenByRefresh,
  deleteToken,
  getTokensByEmail,
  cleanupExpiredTokens,
  getTokenStats,
  startTokenCleanup,
  stopTokenCleanup,
  ACCESS_TOKEN_DURATION_SECONDS,
  REFRESH_TOKEN_DURATION_SECONDS,
} from "./token-store.js";
export type { StoredToken } from "./token-store.js";
