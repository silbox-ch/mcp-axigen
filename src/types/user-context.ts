/**
 * User Context Types
 * For multi-user OAuth mode
 */

/**
 * Credentials for Axigen access
 */
export interface UserCredentials {
  email: string;
  password: string;
}

/**
 * User context for authenticated requests
 */
export interface UserContext {
  // OAuth session info
  sessionId: string;
  username: string;
  email: string;
  name: string;

  // Axigen credentials
  credentials: UserCredentials;
}

/**
 * Get CalDAV URL for a specific user
 */
export function getUserCalDavUrl(baseUrl: string, email: string): string {
  return `${baseUrl}/caldav/${email}/`;
}

/**
 * Get CardDAV URL for a specific user
 */
export function getUserCardDavUrl(baseUrl: string, email: string): string {
  return `${baseUrl}/carddav/${email}/`;
}
