/**
 * Generic OIDC Client
 * Works with any OIDC-compliant provider (Cloudron, Keycloak, Auth0, Okta, Azure AD, etc.)
 * Uses oauth4webapi directly for fine-grained control over validation
 *
 * Note: We use oauth4webapi directly instead of openid-client because Cloudron
 * incorrectly advertises authorization_response_iss_parameter_supported=true
 * but doesn't actually return the iss parameter. oauth4webapi allows us to
 * modify the server metadata before validation.
 */

import * as oauth from "oauth4webapi";

// Configuration from environment variables
export interface OIDCConfig {
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
}

export function getOIDCConfig(): OIDCConfig {
  return {
    discoveryUrl: process.env.OIDC_DISCOVERY_URL || "",
    clientId: process.env.OIDC_CLIENT_ID || "",
    clientSecret: process.env.OIDC_CLIENT_SECRET || "",
    redirectUri: process.env.OIDC_REDIRECT_URI || "",
    scopes: process.env.OIDC_SCOPES || "openid profile email",
  };
}

export function isOIDCConfigured(): boolean {
  const config = getOIDCConfig();
  return !!(
    config.discoveryUrl &&
    config.clientId &&
    config.clientSecret &&
    config.redirectUri
  );
}

// Cached authorization server metadata
let cachedAS: oauth.AuthorizationServer | null = null;

/**
 * Initialize and cache the authorization server metadata via discovery
 * Handles providers where issuer URL differs from discovery URL (e.g., Cloudron)
 */
export async function getAuthorizationServer(): Promise<oauth.AuthorizationServer> {
  if (cachedAS) {
    return cachedAS;
  }

  const oidcConfig = getOIDCConfig();

  if (!oidcConfig.discoveryUrl) {
    throw new Error("OIDC_DISCOVERY_URL is not configured");
  }

  console.log(
    `[OIDC] Discovering provider from: ${oidcConfig.discoveryUrl}`
  );

  // First, fetch the discovery document to get the actual issuer
  // This handles providers like Cloudron where issuer differs from base URL
  const discoveryResponse = await fetch(oidcConfig.discoveryUrl);
  if (!discoveryResponse.ok) {
    throw new Error(`Failed to fetch OIDC discovery document: ${discoveryResponse.status}`);
  }
  const discoveryDoc = await discoveryResponse.json();
  const issuerUrl = discoveryDoc.issuer;

  if (!issuerUrl) {
    throw new Error("OIDC discovery document does not contain an issuer");
  }

  console.log(`[OIDC] Issuer from discovery: ${issuerUrl}`);

  // Use the actual issuer URL for discovery
  const issuer = new URL(issuerUrl);
  const response = await oauth.discoveryRequest(issuer);
  const as = await oauth.processDiscoveryResponse(issuer, response);

  // Workaround for Cloudron bug: it advertises authorization_response_iss_parameter_supported=true
  // but doesn't actually return the iss parameter in the authorization response.
  // We disable this check by setting it to false in our cached copy.
  if (as.authorization_response_iss_parameter_supported) {
    console.log(`[OIDC] Warning: Provider claims iss parameter support, disabling check for compatibility`);
    // Create a modified copy with iss check disabled
    cachedAS = {
      ...as,
      authorization_response_iss_parameter_supported: false,
    };
  } else {
    cachedAS = as;
  }

  console.log(`[OIDC] Provider discovered: ${cachedAS.issuer}`);

  return cachedAS;
}

/**
 * Get the OAuth client configuration
 */
export function getOAuthClient(): oauth.Client {
  const oidcConfig = getOIDCConfig();
  return {
    client_id: oidcConfig.clientId,
  };
}

/**
 * Get client authentication method
 */
export function getClientAuth(): oauth.ClientAuth {
  const oidcConfig = getOIDCConfig();
  return oauth.ClientSecretPost(oidcConfig.clientSecret);
}

/**
 * Generate PKCE code verifier and challenge
 */
export async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
}

/**
 * Generate a random state parameter
 */
export function generateState(): string {
  return oauth.generateRandomState();
}

/**
 * Build the authorization URL with PKCE
 * @param state - OAuth state parameter
 * @param codeChallenge - PKCE code challenge
 * @param customRedirectUri - Optional custom redirect URI (for MCP OAuth flow)
 */
export async function getAuthorizationUrl(
  state: string,
  codeChallenge: string,
  customRedirectUri?: string
): Promise<string> {
  const as = await getAuthorizationServer();
  const oidcConfig = getOIDCConfig();
  const client = getOAuthClient();

  if (!as.authorization_endpoint) {
    throw new Error("Authorization endpoint not found in server metadata");
  }

  const redirectUri = customRedirectUri || oidcConfig.redirectUri;

  const authUrl = new URL(as.authorization_endpoint);
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", oidcConfig.scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return authUrl.href;
}

/**
 * Token response interface
 */
export interface TokenEndpointResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

/**
 * Exchange authorization code for tokens
 * @param code - Authorization code from the callback
 * @param state - OAuth state parameter
 * @param codeVerifier - PKCE code verifier
 * @param customRedirectUri - Optional custom redirect URI (must match the one used in authorization)
 */
export async function exchangeCodeForTokens(
  code: string,
  state: string,
  codeVerifier: string,
  customRedirectUri?: string
): Promise<TokenEndpointResponse> {
  const as = await getAuthorizationServer();
  const oidcConfig = getOIDCConfig();
  const client = getOAuthClient();
  const clientAuth = getClientAuth();

  const redirectUri = customRedirectUri || oidcConfig.redirectUri;

  // Build the callback URL with all parameters from the authorization response
  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);
  callbackUrl.searchParams.set("state", state);

  // Validate the authorization response
  // Using the modified AS metadata where authorization_response_iss_parameter_supported is false
  // validateAuthResponse throws AuthorizationResponseError if there's an OAuth error
  const params = oauth.validateAuthResponse(as, client, callbackUrl, state);

  // Exchange the authorization code for tokens
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    clientAuth,
    params,
    redirectUri,
    codeVerifier
  );

  // processAuthorizationCodeResponse throws ResponseBodyError for OAuth errors
  const result = await oauth.processAuthorizationCodeResponse(as, client, response);

  return {
    access_token: result.access_token,
    token_type: result.token_type,
    expires_in: result.expires_in,
    refresh_token: result.refresh_token,
    id_token: result.id_token,
    scope: result.scope,
  };
}

/**
 * Get user info from the OIDC provider
 */
export async function getUserInfo(
  accessToken: string
): Promise<{ username: string; email: string; name: string }> {
  const as = await getAuthorizationServer();
  const client = getOAuthClient();

  if (!as.userinfo_endpoint) {
    throw new Error("Userinfo endpoint not found in server metadata");
  }

  const response = await oauth.userInfoRequest(as, client, accessToken);
  // Use skipSubjectCheck since we don't have the sub from the ID token yet
  const userinfo = await oauth.processUserInfoResponse(as, client, oauth.skipSubjectCheck, response);

  return {
    username: (userinfo.preferred_username || userinfo.sub || "") as string,
    email: (userinfo.email || "") as string,
    name:
      ((userinfo.name ||
        userinfo.preferred_username ||
        userinfo.email ||
        "") as string),
  };
}

/**
 * Refresh tokens using a refresh token
 */
export async function refreshTokens(
  refreshToken: string
): Promise<TokenEndpointResponse> {
  const as = await getAuthorizationServer();
  const client = getOAuthClient();
  const clientAuth = getClientAuth();

  const response = await oauth.refreshTokenGrantRequest(as, client, clientAuth, refreshToken);
  // processRefreshTokenResponse throws ResponseBodyError for OAuth errors
  const result = await oauth.processRefreshTokenResponse(as, client, response);

  return {
    access_token: result.access_token,
    token_type: result.token_type,
    expires_in: result.expires_in,
    refresh_token: result.refresh_token,
    id_token: result.id_token,
    scope: result.scope,
  };
}

/**
 * Get the provider metadata (for debugging/info)
 */
export async function getProviderMetadata(): Promise<oauth.AuthorizationServer> {
  return getAuthorizationServer();
}

/**
 * Clear cached configuration (useful for testing or config changes)
 */
export function clearOIDCCache(): void {
  cachedAS = null;
}

// Re-export for backward compatibility with openid-client types
export type { oauth as client };
