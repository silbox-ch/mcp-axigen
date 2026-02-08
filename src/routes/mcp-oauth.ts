/**
 * MCP OAuth 2.0 Authorization Routes
 * Implements the MCP Authorization Specification (2025-03-26)
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
 *
 * This allows Claude.ai to authenticate users via OAuth flow
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import {
  isOIDCConfigured,
  getAuthorizationUrl as getOIDCAuthUrl,
  exchangeCodeForTokens as exchangeOIDCTokens,
  getUserInfo,
  generatePKCE,
  generateState,
} from "../auth/oidc.js";
import {
  createSession,
  getSession,
  updateSessionWithAxigenCredentials,
} from "../auth/sessions.js";
import {
  hasAxigenPassword,
  getAxigenPassword,
  storeAxigenPassword,
} from "../auth/credentials-store.js";
import {
  storeToken,
  getToken,
  getTokenByRefresh,
  deleteToken,
  startTokenCleanup,
  ACCESS_TOKEN_DURATION_SECONDS,
  REFRESH_TOKEN_DURATION_SECONDS,
  StoredToken,
} from "../auth/token-store.js";
import { config } from "../config.js";
import axios from "axios";
import https from "https";

const router = Router();

// HTTPS agent for self-signed certificates
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Get base URL (MCP server URL without /mcp path)
function getBaseUrl(): string {
  const publicUrl = config.server.publicUrl || `http://localhost:${config.server.port}`;
  return publicUrl.replace(/\/mcp$/, "");
}

// ═══════════════════════════════════════════════════════════════════════════
// MCP OAuth Token Storage (now using persistent token-store.ts)
// ═══════════════════════════════════════════════════════════════════════════

// Start token cleanup on module load
startTokenCleanup();

// Store pending OAuth authorizations (state -> PKCE data)
interface PendingMcpAuth {
  codeVerifier: string;
  codeChallenge: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  createdAt: Date;
}
const pendingMcpAuths = new Map<string, PendingMcpAuth>();

// Store authorization codes (code -> auth data)
interface AuthorizationCode {
  userId: string;
  email: string;
  name: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
  axigenPassword?: string;
  createdAt: Date;
}
const authorizationCodes = new Map<string, AuthorizationCode>();

// Cleanup expired pending auths and authorization codes every minute
// (Token cleanup is handled by token-store.ts hourly)
setInterval(() => {
  const now = Date.now();

  // Cleanup pending auths (10 minutes TTL)
  for (const [state, data] of pendingMcpAuths.entries()) {
    if (now - data.createdAt.getTime() > 600000) {
      pendingMcpAuths.delete(state);
    }
  }

  // Cleanup authorization codes (5 minutes TTL)
  for (const [code, data] of authorizationCodes.entries()) {
    if (now - data.createdAt.getTime() > 300000) {
      authorizationCodes.delete(code);
    }
  }
}, 60000);

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function generateCode(): string {
  return crypto.randomBytes(32).toString("hex");
}

function verifyCodeChallenge(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  const computed = hash.toString("base64url");
  return computed === codeChallenge;
}

/**
 * Test Axigen connection with provided credentials
 */
async function testAxigenConnection(email: string, password: string): Promise<boolean> {
  const axigenBaseUrl =
    process.env.AXIGEN_BASE_URL || `https://${process.env.AXIGEN_HOST}`;

  try {
    const response = await axios.post(
      `${axigenBaseUrl}/api/v1/login/cookie`,
      { username: email, password },
      {
        headers: { "Content-Type": "application/json" },
        httpsAgent,
        timeout: 10000,
      }
    );
    return !!response.data?.sessid;
  } catch {
    return false;
  }
}

/**
 * HTML template for authorization pages
 */
function htmlPage(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 450px;
      margin: 50px auto;
      padding: 20px;
      background: #f5f5f5;
      line-height: 1.6;
    }
    .card {
      background: white;
      padding: 30px;
      border-radius: 12px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.1);
    }
    h1 { font-size: 1.5em; margin-top: 0; color: #333; }
    input {
      width: 100%;
      padding: 12px;
      margin: 8px 0;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 16px;
    }
    input[readonly] { background: #f5f5f5; color: #666; }
    input:focus { outline: none; border-color: #007bff; box-shadow: 0 0 0 3px rgba(0,123,255,0.1); }
    button, .btn {
      display: inline-block;
      width: 100%;
      padding: 14px;
      background: #007bff;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
      margin-top: 10px;
      text-decoration: none;
      text-align: center;
    }
    button:hover, .btn:hover { background: #0056b3; }
    .btn-secondary { background: #6c757d; }
    .btn-secondary:hover { background: #545b62; }
    .btn-danger { background: #dc3545; }
    .btn-danger:hover { background: #c82333; }
    .error {
      color: #d32f2f;
      background: #ffebee;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 15px;
    }
    .success {
      color: #2e7d32;
      background: #e8f5e9;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 15px;
    }
    .info { color: #666; font-size: 0.9em; margin-top: 15px; }
    .icon { font-size: 3em; text-align: center; margin-bottom: 10px; }
    .scope-list { background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 15px 0; }
    .scope-item { margin: 5px 0; }
    .client-info { background: #e3f2fd; padding: 15px; border-radius: 6px; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="card">
    ${content}
  </div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// RFC 9728 - OAuth 2.0 Protected Resource Metadata (MCP Nov 2025 spec)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /.well-known/oauth-protected-resource
 * Returns OAuth 2.0 Protected Resource Metadata (RFC 9728)
 * This is required by the MCP November 2025 spec for 401 challenge flow
 */
router.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
  console.log("[MCP OAuth] GET /.well-known/oauth-protected-resource");
  const baseUrl = getBaseUrl();

  const response = {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ["email", "calendar", "contacts", "tasks", "offline_access"],
    bearer_methods_supported: ["header"],
  };
  console.log("[MCP OAuth] Returning protected resource metadata:", JSON.stringify(response));
  res.json(response);
});

// Also support path-based resource metadata
router.get("/.well-known/oauth-protected-resource/mcp", (_req: Request, res: Response) => {
  const baseUrl = getBaseUrl();

  res.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ["email", "calendar", "contacts", "tasks", "offline_access"],
    bearer_methods_supported: ["header"],
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RFC 8414 - OAuth 2.0 Authorization Server Metadata
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /.well-known/oauth-authorization-server
 * Returns OAuth 2.0 Authorization Server Metadata (RFC 8414)
 */
router.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
  console.log("[MCP OAuth] GET /.well-known/oauth-authorization-server");
  const baseUrl = getBaseUrl();

  const response = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`, // RFC 7591 Dynamic Client Registration
    scopes_supported: ["email", "calendar", "contacts", "tasks", "offline_access"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: "https://github.com/silbox-ch/mcp-axigen",
  };
  console.log("[MCP OAuth] Returning auth server metadata:", JSON.stringify(response));
  res.json(response);
});

/**
 * GET /.well-known/openid-configuration
 * OpenID Connect Discovery (fallback for some clients)
 */
router.get("/.well-known/openid-configuration", (_req: Request, res: Response) => {
  const baseUrl = getBaseUrl();

  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    scopes_supported: ["openid", "email", "profile", "offline_access"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RFC 7591 - Dynamic Client Registration (Required by Claude.ai)
// ═══════════════════════════════════════════════════════════════════════════

interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  createdAt: Date;
}

// Store registered clients (in production, use database)
const registeredClients = new Map<string, RegisteredClient>();

/**
 * POST /register - Dynamic Client Registration (RFC 7591)
 * Claude.ai uses this to register itself as an OAuth client
 */
router.post("/register", (req: Request, res: Response) => {
  console.log("[MCP OAuth] POST /register - Body:", JSON.stringify(req.body));
  const {
    client_name,
    redirect_uris,
    grant_types,
    response_types,
    token_endpoint_auth_method,
    scope,
  } = req.body;

  // Validate required fields
  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({
      error: "invalid_client_metadata",
      error_description: "redirect_uris is required and must be a non-empty array",
    });
    return;
  }

  // Validate redirect URIs (must be HTTPS or localhost)
  for (const uri of redirect_uris) {
    try {
      const url = new URL(uri);
      if (url.hostname !== "localhost" && url.protocol !== "https:") {
        res.status(400).json({
          error: "invalid_redirect_uri",
          error_description: `Redirect URI must be HTTPS or localhost: ${uri}`,
        });
        return;
      }
    } catch {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: `Invalid redirect URI: ${uri}`,
      });
      return;
    }
  }

  // Generate client credentials
  const clientId = crypto.randomBytes(16).toString("hex");
  // For public clients (like Claude.ai), we don't require a secret
  const clientSecret = token_endpoint_auth_method === "none"
    ? undefined
    : crypto.randomBytes(32).toString("hex");

  const client: RegisteredClient = {
    clientId,
    clientSecret,
    clientName: client_name || "MCP Client",
    redirectUris: redirect_uris,
    grantTypes: grant_types || ["authorization_code", "refresh_token"],
    responseTypes: response_types || ["code"],
    tokenEndpointAuthMethod: token_endpoint_auth_method || "none",
    createdAt: new Date(),
  };

  registeredClients.set(clientId, client);

  console.log(`[MCP OAuth] Registered new client: ${clientId} (${client.clientName})`);
  console.log(`[MCP OAuth] Redirect URIs: ${redirect_uris.join(", ")}`);

  // Return client registration response (RFC 7591)
  const response: Record<string, unknown> = {
    client_id: clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
  };

  // Only include secret if one was generated
  if (clientSecret) {
    response.client_secret = clientSecret;
    response.client_secret_expires_at = 0; // Never expires
  }

  res.status(201).json(response);
});

/**
 * Check if a client is registered and valid
 */
export function isClientRegistered(clientId: string): boolean {
  return registeredClients.has(clientId);
}

/**
 * Get registered client by ID
 */
export function getRegisteredClient(clientId: string): RegisteredClient | undefined {
  return registeredClients.get(clientId);
}

// ═══════════════════════════════════════════════════════════════════════════
// OAuth 2.0 Authorization Endpoint
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /authorize - Start OAuth authorization flow
 * Claude.ai will redirect users here to authenticate
 */
router.get("/authorize", async (req: Request, res: Response) => {
  const {
    client_id,
    redirect_uri,
    response_type,
    code_challenge,
    code_challenge_method,
    state,
    scope,
  } = req.query;

  // Validate required parameters
  if (!client_id || !redirect_uri || !response_type || !code_challenge || !state) {
    res.status(400).send(
      htmlPage(
        "Error",
        `
        <div class="icon">❌</div>
        <h1>Missing Parameters</h1>
        <p>Required OAuth parameters are missing.</p>
        <p class="info">Required: client_id, redirect_uri, response_type, code_challenge, state</p>
      `
      )
    );
    return;
  }

  if (response_type !== "code") {
    res.status(400).send(
      htmlPage(
        "Error",
        `
        <div class="icon">❌</div>
        <h1>Unsupported Response Type</h1>
        <p>Only response_type=code is supported.</p>
      `
      )
    );
    return;
  }

  if (code_challenge_method && code_challenge_method !== "S256") {
    res.status(400).send(
      htmlPage(
        "Error",
        `
        <div class="icon">❌</div>
        <h1>Unsupported PKCE Method</h1>
        <p>Only code_challenge_method=S256 is supported.</p>
      `
      )
    );
    return;
  }

  // Validate redirect_uri (must be localhost or HTTPS)
  const redirectUrl = new URL(redirect_uri as string);
  if (redirectUrl.hostname !== "localhost" && redirectUrl.protocol !== "https:") {
    res.status(400).send(
      htmlPage(
        "Error",
        `
        <div class="icon">❌</div>
        <h1>Invalid Redirect URI</h1>
        <p>The redirect URI must be localhost or HTTPS.</p>
      `
      )
    );
    return;
  }

  // Check if OIDC is configured - if so, delegate to upstream OIDC provider
  if (isOIDCConfigured()) {
    // Generate PKCE for upstream OIDC
    const { codeVerifier, codeChallenge: oidcCodeChallenge } = await generatePKCE();
    const oidcState = generateState();

    // Store pending auth with client's original parameters
    pendingMcpAuths.set(oidcState, {
      codeVerifier,
      codeChallenge: code_challenge as string,
      clientId: client_id as string,
      redirectUri: redirect_uri as string,
      scope: scope as string,
      createdAt: new Date(),
    });

    // Store the MCP state in cookie to retrieve after OIDC callback
    // This cookie is used by /oauth/callback to detect MCP OAuth flow and redirect
    res.cookie("mcp_oauth_state", state as string, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600000, // 10 minutes
    });

    console.log(`[MCP OAuth] Redirecting to OIDC (callback will be /oauth/callback which redirects to /authorize/callback)`);

    // Redirect to upstream OIDC provider
    // Note: Uses the configured OIDC_REDIRECT_URI (/oauth/callback) which then detects
    // the mcp_oauth_state cookie and redirects to /authorize/callback
    const authUrl = await getOIDCAuthUrl(oidcState, oidcCodeChallenge);
    res.redirect(authUrl);
  } else {
    // No OIDC - show direct login form
    res.send(
      htmlPage(
        "MCP Axigen Login",
        `
        <div class="icon">📧</div>
        <h1>Log in to MCP Axigen</h1>

        <div class="client-info">
          <strong>Application:</strong> ${client_id}<br>
          <strong>Requested permissions:</strong> ${scope || "email, calendar, contacts, tasks"}
        </div>

        <form method="POST" action="/authorize">
          <input type="hidden" name="client_id" value="${client_id}" />
          <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
          <input type="hidden" name="code_challenge" value="${code_challenge}" />
          <input type="hidden" name="state" value="${state}" />
          <input type="hidden" name="scope" value="${scope || ""}" />

          <input type="email" name="email" placeholder="Email" required autofocus />
          <input type="password" name="password" placeholder="Password" required />

          <button type="submit">Authorize Access</button>
        </form>

        <p class="info">🔒 Your credentials are only used to access your Axigen account.</p>
      `
      )
    );
  }
});

/**
 * POST /authorize - Process direct login (when no OIDC)
 */
router.post("/authorize", async (req: Request, res: Response) => {
  const { client_id, redirect_uri, code_challenge, state, scope, email, password } = req.body;

  // Validate Axigen credentials
  const connectionOk = await testAxigenConnection(email, password);

  if (!connectionOk) {
    res.send(
      htmlPage(
        "Authentication Error",
        `
        <div class="icon">❌</div>
        <h1>Login Failed</h1>
        <p class="error">Incorrect email or password.</p>
        <a href="/authorize?client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code&code_challenge=${encodeURIComponent(code_challenge)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope || "")}" class="btn">Try Again</a>
      `
      )
    );
    return;
  }

  // Generate authorization code
  const code = generateCode();

  // Store authorization code with user info
  authorizationCodes.set(code, {
    userId: email,
    email,
    name: email.split("@")[0],
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    scope,
    axigenPassword: password,
    createdAt: new Date(),
  });

  // Redirect back to client with authorization code
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", state);

  res.redirect(redirectUrl.toString());
});

/**
 * GET /authorize/callback - OIDC callback (when using upstream OIDC)
 */
router.get("/authorize/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query;
  const mcpState = req.cookies?.mcp_oauth_state;

  if (error) {
    res.status(400).send(
      htmlPage(
        "Authentication Error",
        `
        <div class="icon">❌</div>
        <h1>Authentication Error</h1>
        <p>${error}: ${error_description || "Unknown error"}</p>
      `
      )
    );
    return;
  }

  const pending = pendingMcpAuths.get(state as string);
  if (!pending) {
    res.status(400).send(
      htmlPage(
        "Session Expired",
        `
        <div class="icon">⏰</div>
        <h1>Session Expired</h1>
        <p>Your authentication session has expired.</p>
      `
      )
    );
    return;
  }
  pendingMcpAuths.delete(state as string);
  res.clearCookie("mcp_oauth_state");

  try {
    // Exchange OIDC code for tokens
    // Note: Uses the configured OIDC_REDIRECT_URI which is /oauth/callback
    // (even though we're in /authorize/callback after the redirect)
    const tokens = await exchangeOIDCTokens(code as string, state as string, pending.codeVerifier);
    const userInfo = await getUserInfo(tokens.access_token!);

    if (!userInfo.email) {
      throw new Error("Email not provided by OIDC provider");
    }

    // Check if we have stored Axigen credentials for this user
    const hasStoredPassword = hasAxigenPassword(userInfo.email);

    if (hasStoredPassword) {
      // User already has linked Axigen account - generate authorization code
      const authCode = generateCode();

      authorizationCodes.set(authCode, {
        userId: userInfo.username,
        email: userInfo.email,
        name: userInfo.name || userInfo.username,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scope: pending.scope,
        axigenPassword: getAxigenPassword(userInfo.email),
        createdAt: new Date(),
      });

      // Redirect back to Claude.ai with authorization code
      const redirectUrl = new URL(pending.redirectUri);
      redirectUrl.searchParams.set("code", authCode);
      redirectUrl.searchParams.set("state", mcpState);

      res.redirect(redirectUrl.toString());
    } else {
      // User needs to link Axigen account - show password form
      // Store temporary session for the linking process
      const linkState = generateState();
      pendingMcpAuths.set(linkState, {
        ...pending,
        codeVerifier: userInfo.email, // Reuse field for email
        codeChallenge: userInfo.name || userInfo.username, // Reuse field for name
        createdAt: new Date(),
      });

      res.send(
        htmlPage(
          "Email Account Linking",
          `
          <div class="icon">🔗</div>
          <h1>Email Account Linking</h1>
          <p>Hello <strong>${userInfo.name || userInfo.username}</strong>,</p>
          <p>To access your email via Claude, enter your email password:</p>

          <form method="POST" action="/authorize/link">
            <input type="hidden" name="link_state" value="${linkState}" />
            <input type="hidden" name="mcp_state" value="${mcpState}" />
            <input type="email" name="email" value="${userInfo.email}" readonly />
            <input type="password" name="password" placeholder="Email password" required autofocus />
            <button type="submit">Connect My Email</button>
          </form>

          <p class="info">🔒 This password will be stored encrypted and won't be asked again.</p>
        `
        )
      );
    }
  } catch (error) {
    console.error("[MCP OAuth] Callback error:", error);
    res.status(500).send(
      htmlPage(
        "Error",
        `
        <div class="icon">❌</div>
        <h1>Authentication Error</h1>
        <p>Token exchange failed.</p>
        <p class="error">${(error as Error).message}</p>
      `
      )
    );
  }
});

/**
 * POST /authorize/link - Link Axigen account after OIDC auth
 */
router.post("/authorize/link", async (req: Request, res: Response) => {
  const { link_state, mcp_state, email, password } = req.body;

  const pending = pendingMcpAuths.get(link_state);
  if (!pending) {
    res.status(400).send(
      htmlPage(
        "Session Expired",
        `
        <div class="icon">⏰</div>
        <h1>Session Expired</h1>
        <p>Your session has expired. Please start over.</p>
      `
      )
    );
    return;
  }

  // Test Axigen connection
  const connectionOk = await testAxigenConnection(email, password);

  if (!connectionOk) {
    res.send(
      htmlPage(
        "Connection Error",
        `
        <div class="icon">❌</div>
        <h1>Incorrect Password</h1>
        <p class="error">The email password is incorrect.</p>

        <form method="POST" action="/authorize/link">
          <input type="hidden" name="link_state" value="${link_state}" />
          <input type="hidden" name="mcp_state" value="${mcp_state}" />
          <input type="email" name="email" value="${email}" readonly />
          <input type="password" name="password" placeholder="Email password" required autofocus />
          <button type="submit">Try Again</button>
        </form>
      `
      )
    );
    return;
  }

  // Store encrypted password
  storeAxigenPassword(email, password);
  pendingMcpAuths.delete(link_state);

  // Generate authorization code
  const userName = pending.codeChallenge; // We stored the name here
  const authCode = generateCode();

  authorizationCodes.set(authCode, {
    userId: email,
    email,
    name: userName,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    scope: pending.scope,
    axigenPassword: password,
    createdAt: new Date(),
  });

  // Redirect back to Claude.ai with authorization code
  const redirectUrl = new URL(pending.redirectUri);
  redirectUrl.searchParams.set("code", authCode);
  redirectUrl.searchParams.set("state", mcp_state);

  res.redirect(redirectUrl.toString());
});

// ═══════════════════════════════════════════════════════════════════════════
// OAuth 2.0 Token Endpoint
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /token - Exchange authorization code for access token
 */
router.post("/token", async (req: Request, res: Response) => {
  const { grant_type, code, client_id, redirect_uri, code_verifier, refresh_token } = req.body;

  if (grant_type === "authorization_code") {
    // Validate authorization code
    const authData = authorizationCodes.get(code);
    if (!authData) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "Invalid or expired authorization code",
      });
      return;
    }

    // Verify PKCE code_verifier
    if (!verifyCodeChallenge(code_verifier, authData.codeChallenge)) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "Invalid code_verifier",
      });
      return;
    }

    // Verify client_id and redirect_uri match
    if (authData.clientId !== client_id || authData.redirectUri !== redirect_uri) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "Client ID or redirect URI mismatch",
      });
      return;
    }

    // Authorization code is valid - consume it
    authorizationCodes.delete(code);

    // Generate access token with long duration (7 days)
    const accessToken = generateToken();
    const refreshTokenValue = generateToken();
    const expiresIn = ACCESS_TOKEN_DURATION_SECONDS; // 7 days

    const now = new Date();

    // Store token persistently (encrypted on disk)
    const tokenData: StoredToken = {
      accessToken,
      tokenType: "Bearer",
      expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
      refreshToken: refreshTokenValue,
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_DURATION_SECONDS * 1000).toISOString(),
      scope: authData.scope,
      userId: authData.userId,
      email: authData.email,
      createdAt: now.toISOString(),
    };
    storeToken(tokenData);

    // Also create an internal session for use with MCP tools
    const { sessionId } = createSession(
      authData.userId,
      authData.email,
      authData.name,
      accessToken,
      refreshTokenValue,
      expiresIn
    );

    // If we have the Axigen password, link it to the session
    if (authData.axigenPassword) {
      updateSessionWithAxigenCredentials(sessionId, authData.axigenPassword);
    }

    console.log(`[MCP OAuth] Issued access token for ${authData.email} (expires in ${expiresIn / 86400} days)`);

    // Return token response
    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshTokenValue,
      scope: authData.scope || "email calendar contacts tasks",
    });
  } else if (grant_type === "refresh_token") {
    // Find token by refresh token (from persistent store)
    const foundToken = getTokenByRefresh(refresh_token);

    if (!foundToken) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "Invalid or expired refresh token",
      });
      return;
    }

    // Delete old token
    deleteToken(foundToken.accessToken);

    // Generate new tokens with fresh durations
    const newAccessToken = generateToken();
    const newRefreshToken = generateToken();
    const expiresIn = ACCESS_TOKEN_DURATION_SECONDS; // 7 days

    const now = new Date();

    // Store new token persistently
    const newTokenData: StoredToken = {
      accessToken: newAccessToken,
      tokenType: "Bearer",
      expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
      refreshToken: newRefreshToken,
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_DURATION_SECONDS * 1000).toISOString(),
      scope: foundToken.scope,
      userId: foundToken.userId,
      email: foundToken.email,
      createdAt: now.toISOString(),
    };
    storeToken(newTokenData);

    console.log(`[MCP OAuth] Refreshed token for ${foundToken.email} (new expiry: ${expiresIn / 86400} days)`);

    res.json({
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: foundToken.scope,
    });
  } else {
    res.status(400).json({
      error: "unsupported_grant_type",
      error_description: "Only authorization_code and refresh_token are supported",
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Token Validation Helper (for MCP requests)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validated token info (compatible with old McpOAuthToken interface)
 */
export interface McpOAuthToken {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
  refreshToken?: string;
  scope?: string;
  userId: string;
  email: string;
}

/**
 * Validate Bearer token and return user info
 * Now uses persistent token store
 */
export function validateBearerToken(authHeader: string | undefined): McpOAuthToken | null {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7);
  const tokenData = getToken(token);

  if (!tokenData) {
    return null;
  }

  // Convert stored token to McpOAuthToken format
  return {
    accessToken: tokenData.accessToken,
    tokenType: tokenData.tokenType,
    expiresAt: new Date(tokenData.expiresAt),
    refreshToken: tokenData.refreshToken,
    scope: tokenData.scope,
    userId: tokenData.userId,
    email: tokenData.email,
  };
}

/**
 * Get the internal session ID for a Bearer token
 */
export function getSessionForToken(token: string): string | undefined {
  const tokenData = getToken(token);
  if (!tokenData) return undefined;

  // Find session by email
  return tokenData.email;
}

/**
 * Get WWW-Authenticate header for 401 challenges (MCP Nov 2025 spec)
 */
export function getWWWAuthenticateHeader(): string {
  const baseUrl = getBaseUrl();
  return `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;
}

/**
 * Get the protected resource metadata URL
 */
export function getResourceMetadataUrl(): string {
  const baseUrl = getBaseUrl();
  return `${baseUrl}/.well-known/oauth-protected-resource`;
}

export default router;
