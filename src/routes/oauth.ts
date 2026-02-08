/**
 * OAuth Routes
 * Handles OIDC authentication flow and Axigen account linking
 */

import { Router, Request, Response } from "express";
import axios from "axios";
import https from "https";
import {
  isOIDCConfigured,
  getAuthorizationUrl,
  exchangeCodeForTokens,
  getUserInfo,
  generatePKCE,
  generateState,
  getOIDCConfig,
} from "../auth/oidc";
import {
  createSession,
  getSession,
  updateSessionWithAxigenCredentials,
  deleteSession,
  getSessionStats,
} from "../auth/sessions";
import {
  storeAxigenPassword,
  hasAxigenPassword,
  deleteAxigenPassword,
} from "../auth/credentials-store";

const router = Router();

// HTTPS agent for self-signed certificates
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Temporary storage for PKCE challenges (in production, use Redis)
interface PendingAuth {
  codeVerifier: string;
  createdAt: Date;
  redirectUri?: string; // Where to redirect after auth
}
const pendingAuths = new Map<string, PendingAuth>();

// Cleanup expired pending auths every minute
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingAuths.entries()) {
    if (now - data.createdAt.getTime() > 600000) {
      // 10 minutes
      pendingAuths.delete(state);
    }
  }
}, 60000);

/**
 * Test Axigen connection with provided credentials
 */
async function testAxigenConnection(
  email: string,
  password: string
): Promise<boolean> {
  const axigenBaseUrl =
    process.env.AXIGEN_BASE_URL || `https://${process.env.AXIGEN_HOST}`;

  try {
    const response = await axios.post(
      `${axigenBaseUrl}/api/v1/login/cookie`,
      {
        username: email,
        password: password,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        httpsAgent,
        timeout: 10000,
      }
    );

    return !!response.data?.sessid;
  } catch (error) {
    console.error("[OAuth] Axigen connection test failed:", error);
    return false;
  }
}

/**
 * HTML template helper
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
    pre {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 6px;
      word-break: break-all;
      white-space: pre-wrap;
      font-size: 12px;
      border: 1px solid #e9ecef;
    }
    .icon { font-size: 3em; text-align: center; margin-bottom: 10px; }
    a { color: #007bff; }
  </style>
</head>
<body>
  <div class="card">
    ${content}
  </div>
</body>
</html>`;
}

/**
 * GET /oauth/status - Check OAuth configuration status
 */
router.get("/status", (req: Request, res: Response) => {
  const configured = isOIDCConfigured();
  const stats = getSessionStats();

  res.json({
    oauth: {
      enabled: configured,
      provider: configured ? getOIDCConfig().discoveryUrl : null,
    },
    sessions: stats,
  });
});

/**
 * GET /oauth/authorize - Initiate OIDC authentication
 * Supports ?redirect_uri= parameter to redirect after auth
 */
router.get("/authorize", async (req: Request, res: Response) => {
  if (!isOIDCConfigured()) {
    res.status(501).send(
      htmlPage(
        "OAuth Not Configured",
        `
        <div class="icon">⚠️</div>
        <h1>OAuth Not Configured</h1>
        <p>The server is running in single-user mode.</p>
        <p>To enable OAuth, configure the OIDC_* environment variables.</p>
      `
      )
    );
    return;
  }

  try {
    const state = generateState();
    const { codeVerifier, codeChallenge } = await generatePKCE();

    // Store redirect URI if provided (only allow same-origin paths)
    const redirectUri = req.query.redirect_uri as string;
    const safeRedirectUri = redirectUri?.startsWith('/') ? redirectUri : undefined;

    pendingAuths.set(state, { codeVerifier, createdAt: new Date(), redirectUri: safeRedirectUri });

    const authUrl = await getAuthorizationUrl(state, codeChallenge);
    res.redirect(authUrl);
  } catch (error) {
    console.error("[OAuth] Authorization init error:", error);
    res.status(500).send(
      htmlPage(
        "Error",
        `
        <div class="icon">❌</div>
        <h1>Configuration Error</h1>
        <p>The OIDC provider is not accessible.</p>
        <pre>${(error as Error).message}</pre>
        <a href="/oauth/authorize" class="btn">Try Again</a>
      `
      )
    );
  }
});

/**
 * GET /oauth/callback - OIDC callback handler
 * Note: This handles BOTH legacy OAuth callbacks AND MCP OAuth callbacks
 * (when Cloudron redirects to /oauth/callback instead of /authorize/callback)
 */
router.get("/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description, iss } = req.query;

  // Check if this is an MCP OAuth flow (has mcp_oauth_state cookie)
  // This happens when the OIDC provider (Cloudron) is configured with /oauth/callback
  // but the MCP OAuth flow expects /authorize/callback
  if (req.cookies?.mcp_oauth_state) {
    console.log("[OAuth] Detected MCP OAuth flow, redirecting to /authorize/callback");
    // Preserve all query params and redirect to MCP OAuth callback
    const redirectUrl = new URL(`/authorize/callback`, `${req.protocol}://${req.get("host")}`);
    if (code) redirectUrl.searchParams.set("code", code as string);
    if (state) redirectUrl.searchParams.set("state", state as string);
    if (error) redirectUrl.searchParams.set("error", error as string);
    if (error_description) redirectUrl.searchParams.set("error_description", error_description as string);
    if (iss) redirectUrl.searchParams.set("iss", iss as string);
    res.redirect(redirectUrl.toString());
    return;
  }

  if (error) {
    res.status(400).send(
      htmlPage(
        "Authentication Error",
        `
        <div class="icon">❌</div>
        <h1>Authentication Error</h1>
        <p><strong>${error}</strong>: ${error_description || "Unknown error"}</p>
        <a href="/oauth/authorize" class="btn">Try Again</a>
      `
      )
    );
    return;
  }

  const pending = pendingAuths.get(state as string);
  if (!pending) {
    res.status(400).send(
      htmlPage(
        "Session Expired",
        `
        <div class="icon">⏰</div>
        <h1>Session Expired</h1>
        <p>Your authentication request has expired.</p>
        <a href="/oauth/authorize" class="btn">Start Over</a>
      `
      )
    );
    return;
  }
  pendingAuths.delete(state as string);

  try {
    const tokens = await exchangeCodeForTokens(
      code as string,
      state as string,
      pending.codeVerifier
    );
    const userInfo = await getUserInfo(tokens.access_token!);

    if (!userInfo.email) {
      throw new Error("Email not provided by OIDC provider");
    }

    const { sessionId, needsAxigenLink } = createSession(
      userInfo.username,
      userInfo.email,
      userInfo.name,
      tokens.access_token!,
      tokens.refresh_token,
      tokens.expires_in
    );

    // Set OAuth session cookie for MCP requests
    res.cookie("oauth_session", sessionId, {
      httpOnly: true,
      secure: true, // Requires HTTPS
      sameSite: "none", // Allow cross-site requests from claude.ai
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    // Get redirect URI from pending auth
    const redirectAfterAuth = pending.redirectUri;

    if (needsAxigenLink) {
      // Pass redirect URI to link-axigen flow
      const linkUrl = redirectAfterAuth
        ? `/oauth/link-axigen?session=${sessionId}&redirect_uri=${encodeURIComponent(redirectAfterAuth)}`
        : `/oauth/link-axigen?session=${sessionId}`;
      res.redirect(linkUrl);
    } else if (redirectAfterAuth) {
      // Redirect to original URL
      res.redirect(redirectAfterAuth);
    } else {
      res.send(
        htmlPage(
          "Connected!",
          `
          <div class="icon">✅</div>
          <h1>Connected!</h1>
          <p>Welcome <strong>${userInfo.name}</strong></p>
          <p>Your MCP session is ready.</p>
          <p><strong>Session ID:</strong></p>
          <pre>${sessionId}</pre>
          <p class="info">This Session ID is automatically associated with MCP requests via cookie.</p>
          <p class="info">For clients that don't support cookies, use the header <code>x-oauth-session-id</code></p>
          <a href="/oauth/logout?session=${sessionId}" class="btn btn-secondary">Log Out</a>
        `
        )
      );
    }
  } catch (error) {
    console.error("[OAuth] Callback error:", error);
    res.status(500).send(
      htmlPage(
        "Error",
        `
        <div class="icon">❌</div>
        <h1>Authentication Error</h1>
        <p>Token exchange failed.</p>
        <pre>${(error as Error).message}</pre>
        <a href="/oauth/authorize" class="btn">Try Again</a>
      `
      )
    );
  }
});

/**
 * GET /oauth/link-axigen - Show account linking form
 * Supports ?redirect_uri= parameter
 */
router.get("/link-axigen", (req: Request, res: Response) => {
  const { session, error, redirect_uri } = req.query;

  const sessionData = getSession(session as string);
  if (!sessionData) {
    res.redirect("/oauth/authorize");
    return;
  }

  // Include redirect_uri in hidden field if present
  const redirectUriField = redirect_uri
    ? `<input type="hidden" name="redirect_uri" value="${redirect_uri}" />`
    : "";

  res.send(
    htmlPage(
      "Email Account Linking",
      `
      <div class="icon">🔗</div>
      <h1>Email Account Linking</h1>
      <p>Hello <strong>${sessionData.name}</strong>,</p>
      <p>To access your email, enter your email password:</p>

      ${error ? `<p class="error">${decodeURIComponent(error as string)}</p>` : ""}

      <form method="POST" action="/oauth/link-axigen">
        <input type="hidden" name="session" value="${session}" />
        ${redirectUriField}
        <input type="email" name="email" value="${sessionData.email}" readonly />
        <input type="password" name="password" placeholder="Email password" required autofocus />
        <button type="submit">Connect My Email</button>
      </form>

      <p class="info">🔒 This password will be stored encrypted and won't be asked again.</p>
    `
    )
  );
});

/**
 * POST /oauth/link-axigen - Process account linking
 * Supports redirect_uri in form body
 */
router.post("/link-axigen", async (req: Request, res: Response) => {
  const { session, password, redirect_uri } = req.body;

  const sessionData = getSession(session);
  if (!sessionData) {
    res.redirect("/oauth/authorize");
    return;
  }

  try {
    // Test the Axigen connection
    const connectionOk = await testAxigenConnection(sessionData.email, password);

    if (!connectionOk) {
      // Preserve redirect_uri on error
      const errorRedirect = redirect_uri
        ? `/oauth/link-axigen?session=${session}&error=${encodeURIComponent("Incorrect password or connection failed")}&redirect_uri=${encodeURIComponent(redirect_uri)}`
        : `/oauth/link-axigen?session=${session}&error=${encodeURIComponent("Incorrect password or connection failed")}`;
      res.redirect(errorRedirect);
      return;
    }

    // Store the encrypted password
    storeAxigenPassword(sessionData.email, password);
    updateSessionWithAxigenCredentials(session, password);

    // Refresh the OAuth session cookie
    res.cookie("oauth_session", session, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 24 * 60 * 60 * 1000,
    });

    // Redirect to original URL if provided
    if (redirect_uri && redirect_uri.startsWith('/')) {
      res.redirect(redirect_uri);
      return;
    }

    res.send(
      htmlPage(
        "Account Linked!",
        `
        <div class="icon">✅</div>
        <h1>Account Linked Successfully!</h1>
        <p>Welcome <strong>${sessionData.name}</strong></p>
        <p>Your MCP session is ready.</p>
        <p><strong>Session ID:</strong></p>
        <pre>${session}</pre>
        <p class="info">This Session ID is automatically associated with MCP requests via cookie.</p>
        <p class="info">For clients that don't support cookies, use the header <code>x-oauth-session-id</code></p>
        <a href="/oauth/logout?session=${session}" class="btn btn-secondary">Log Out</a>
      `
      )
    );
  } catch (error) {
    console.error("[OAuth] Link account error:", error);
    res.redirect(
      `/oauth/link-axigen?session=${session}&error=${encodeURIComponent("Connection error")}`
    );
  }
});

/**
 * GET /oauth/logout - Logout and optionally unlink account
 */
router.get("/logout", (req: Request, res: Response) => {
  const { session, unlink } = req.query;

  if (session) {
    const sessionData = getSession(session as string);

    if (unlink === "true" && sessionData) {
      deleteAxigenPassword(sessionData.email);
    }

    deleteSession(session as string);
  }

  // Clear the OAuth session cookie
  res.clearCookie("oauth_session");

  res.send(
    htmlPage(
      "Logged Out",
      `
      <div class="icon">👋</div>
      <h1>Logged Out</h1>
      <p>Your session has been closed.</p>
      ${req.query.unlink === "true" ? "<p>Your email account has been unlinked.</p>" : ""}
      <a href="/oauth/authorize" class="btn">Log In Again</a>
    `
    )
  );
});

/**
 * GET /oauth/unlink - Unlink Axigen account (requires active session)
 */
router.get("/unlink", (req: Request, res: Response) => {
  const { session, confirm } = req.query;

  const sessionData = getSession(session as string);
  if (!sessionData) {
    res.redirect("/oauth/authorize");
    return;
  }

  if (confirm === "true") {
    deleteAxigenPassword(sessionData.email);
    res.send(
      htmlPage(
        "Account Unlinked",
        `
        <div class="icon">🔓</div>
        <h1>Account Unlinked</h1>
        <p>Your email password has been removed.</p>
        <p>You will need to enter it again on your next login.</p>
        <a href="/oauth/authorize" class="btn">Log In Again</a>
      `
      )
    );
  } else {
    res.send(
      htmlPage(
        "Unlink Account",
        `
        <div class="icon">⚠️</div>
        <h1>Unlink email account?</h1>
        <p>This will remove your stored email password.</p>
        <p>You will need to enter it again on your next login.</p>
        <a href="/oauth/unlink?session=${session}&confirm=true" class="btn">Confirm Removal</a>
        <a href="/oauth/logout?session=${session}" class="btn btn-secondary">Cancel</a>
      `
      )
    );
  }
});

/**
 * GET /oauth/session - Get session info (for debugging)
 */
router.get("/session", (req: Request, res: Response) => {
  const { session } = req.query;

  if (!session) {
    res.status(400).json({ error: "Session ID required" });
    return;
  }

  const sessionData = getSession(session as string);
  if (!sessionData) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  // Return safe session info (no tokens or passwords)
  res.json({
    id: sessionData.id,
    username: sessionData.username,
    email: sessionData.email,
    name: sessionData.name,
    hasAxigenCredentials: !!sessionData.axigenCredentials,
    needsAxigenLink: sessionData.needsAxigenLink,
    createdAt: sessionData.createdAt,
    expiresAt: sessionData.expiresAt,
    lastActivity: sessionData.lastActivity,
  });
});

export default router;
