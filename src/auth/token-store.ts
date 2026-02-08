/**
 * Persistent Token Store
 * Stores MCP OAuth tokens encrypted on disk
 * Survives server restarts and provides long-lived sessions
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

const ALGORITHM = "aes-256-gcm";

// Token durations
export const ACCESS_TOKEN_DURATION_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const REFRESH_TOKEN_DURATION_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface StoredToken {
  accessToken: string;
  tokenType: string;
  expiresAt: string; // ISO date string
  refreshToken: string;
  refreshExpiresAt: string; // ISO date string
  scope?: string;
  userId: string;
  email: string;
  createdAt: string;
}

interface EncryptedToken {
  encrypted: string;
  iv: string;
  authTag: string;
}

interface TokensDB {
  // Keyed by access token
  tokens: { [accessToken: string]: EncryptedToken };
  // Index by refresh token for quick lookup
  refreshIndex: { [refreshToken: string]: string }; // refreshToken -> accessToken
  // Index by email for session lookup
  emailIndex: { [email: string]: string[] }; // email -> accessToken[]
}

function getEncryptionKey(): string {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY || "";
  if (!key || key.length !== 64) {
    // In single-user mode without encryption key, use a derived key from env
    const fallback = process.env.AXIGEN_PASSWORD || "default-mcp-key-not-secure";
    return crypto.createHash("sha256").update(fallback).digest("hex");
  }
  return key;
}

function getTokensFile(): string {
  return process.env.TOKENS_FILE || "./data/mcp-tokens.json";
}

function ensureDataDir(): void {
  const tokensFile = getTokensFile();
  const dir = path.dirname(tokensFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function loadTokensDB(): TokensDB {
  ensureDataDir();
  const tokensFile = getTokensFile();
  if (!fs.existsSync(tokensFile)) {
    return { tokens: {}, refreshIndex: {}, emailIndex: {} };
  }
  try {
    const data = fs.readFileSync(tokensFile, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    console.error("[TokenStore] Failed to load tokens file:", err);
    return { tokens: {}, refreshIndex: {}, emailIndex: {} };
  }
}

function saveTokensDB(db: TokensDB): void {
  ensureDataDir();
  const tokensFile = getTokensFile();
  fs.writeFileSync(tokensFile, JSON.stringify(db, null, 2), "utf-8");
  try {
    fs.chmodSync(tokensFile, 0o600);
  } catch {
    // chmod may fail on Windows
  }
}

function encrypt(data: string): EncryptedToken {
  const key = Buffer.from(getEncryptionKey(), "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(data, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return {
    encrypted,
    iv: iv.toString("hex"),
    authTag,
  };
}

function decrypt(encToken: EncryptedToken): string {
  const key = Buffer.from(getEncryptionKey(), "hex");
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(encToken.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(encToken.authTag, "hex"));

  let decrypted = decipher.update(encToken.encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Store a token (encrypted)
 */
export function storeToken(token: StoredToken): void {
  const db = loadTokensDB();

  // Encrypt the token data
  const encToken = encrypt(JSON.stringify(token));

  // Store by access token
  db.tokens[token.accessToken] = encToken;

  // Index by refresh token
  db.refreshIndex[token.refreshToken] = token.accessToken;

  // Index by email (append to list)
  const normalizedEmail = token.email.toLowerCase();
  if (!db.emailIndex[normalizedEmail]) {
    db.emailIndex[normalizedEmail] = [];
  }
  if (!db.emailIndex[normalizedEmail].includes(token.accessToken)) {
    db.emailIndex[normalizedEmail].push(token.accessToken);
  }

  saveTokensDB(db);
  console.log(`[TokenStore] Stored token for ${normalizedEmail} (expires: ${token.expiresAt})`);
}

/**
 * Get a token by access token
 * Returns null if not found or expired
 */
export function getToken(accessToken: string): StoredToken | null {
  const db = loadTokensDB();
  const encToken = db.tokens[accessToken];

  if (!encToken) {
    return null;
  }

  try {
    const token: StoredToken = JSON.parse(decrypt(encToken));

    // Check if access token is expired
    if (new Date(token.expiresAt) < new Date()) {
      console.log(`[TokenStore] Access token expired for ${token.email}`);
      return null;
    }

    return token;
  } catch (err) {
    console.error("[TokenStore] Failed to decrypt token:", err);
    return null;
  }
}

/**
 * Get a token by refresh token
 * Returns null if not found or refresh token expired
 */
export function getTokenByRefresh(refreshToken: string): StoredToken | null {
  const db = loadTokensDB();
  const accessToken = db.refreshIndex[refreshToken];

  if (!accessToken) {
    return null;
  }

  const encToken = db.tokens[accessToken];
  if (!encToken) {
    return null;
  }

  try {
    const token: StoredToken = JSON.parse(decrypt(encToken));

    // Check if refresh token is expired
    if (new Date(token.refreshExpiresAt) < new Date()) {
      console.log(`[TokenStore] Refresh token expired for ${token.email}`);
      // Clean up expired token
      deleteToken(accessToken);
      return null;
    }

    return token;
  } catch (err) {
    console.error("[TokenStore] Failed to decrypt token:", err);
    return null;
  }
}

/**
 * Delete a token
 */
export function deleteToken(accessToken: string): void {
  const db = loadTokensDB();
  const encToken = db.tokens[accessToken];

  if (!encToken) {
    return;
  }

  try {
    const token: StoredToken = JSON.parse(decrypt(encToken));

    // Remove from refresh index
    delete db.refreshIndex[token.refreshToken];

    // Remove from email index
    const normalizedEmail = token.email.toLowerCase();
    if (db.emailIndex[normalizedEmail]) {
      db.emailIndex[normalizedEmail] = db.emailIndex[normalizedEmail].filter(
        (t) => t !== accessToken
      );
      if (db.emailIndex[normalizedEmail].length === 0) {
        delete db.emailIndex[normalizedEmail];
      }
    }
  } catch {
    // Ignore decryption errors during deletion
  }

  // Remove token
  delete db.tokens[accessToken];
  saveTokensDB(db);
}

/**
 * Get all tokens for an email
 */
export function getTokensByEmail(email: string): StoredToken[] {
  const db = loadTokensDB();
  const normalizedEmail = email.toLowerCase();
  const accessTokens = db.emailIndex[normalizedEmail] || [];

  const tokens: StoredToken[] = [];
  for (const accessToken of accessTokens) {
    const token = getToken(accessToken);
    if (token) {
      tokens.push(token);
    }
  }

  return tokens;
}

/**
 * Clean up expired tokens
 */
export function cleanupExpiredTokens(): number {
  const db = loadTokensDB();
  const now = new Date();
  let cleanedUp = 0;

  for (const accessToken of Object.keys(db.tokens)) {
    const encToken = db.tokens[accessToken];
    try {
      const token: StoredToken = JSON.parse(decrypt(encToken));

      // Delete if refresh token is expired (access token expiry is checked on get)
      if (new Date(token.refreshExpiresAt) < now) {
        deleteToken(accessToken);
        cleanedUp++;
      }
    } catch {
      // If we can't decrypt, delete it
      delete db.tokens[accessToken];
      cleanedUp++;
    }
  }

  if (cleanedUp > 0) {
    saveTokensDB(db);
    console.log(`[TokenStore] Cleaned up ${cleanedUp} expired token(s)`);
  }

  return cleanedUp;
}

/**
 * Get token statistics
 */
export function getTokenStats(): {
  totalTokens: number;
  activeTokens: number;
  uniqueUsers: number;
} {
  const db = loadTokensDB();
  const now = new Date();
  let activeTokens = 0;

  for (const accessToken of Object.keys(db.tokens)) {
    const encToken = db.tokens[accessToken];
    try {
      const token: StoredToken = JSON.parse(decrypt(encToken));
      if (new Date(token.expiresAt) > now) {
        activeTokens++;
      }
    } catch {
      // Ignore
    }
  }

  return {
    totalTokens: Object.keys(db.tokens).length,
    activeTokens,
    uniqueUsers: Object.keys(db.emailIndex).length,
  };
}

// Start periodic cleanup (every hour)
let cleanupInterval: NodeJS.Timeout | null = null;

export function startTokenCleanup(): void {
  if (cleanupInterval) {
    return;
  }
  // Clean up on start
  cleanupExpiredTokens();
  // Then every hour
  cleanupInterval = setInterval(cleanupExpiredTokens, 60 * 60 * 1000);
  console.log("[TokenStore] Started token cleanup interval (hourly)");
}

export function stopTokenCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
