/**
 * Secure Credentials Store
 * Stores Axigen passwords encrypted with AES-256-GCM
 * Each user's email password is stored separately and encrypted with a server key
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

const ALGORITHM = "aes-256-gcm";

interface StoredCredential {
  email: string;
  encryptedPassword: string;
  iv: string;
  authTag: string;
  linkedAt: string;
}

interface CredentialsDB {
  [email: string]: StoredCredential;
}

function getEncryptionKey(): string {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY || "";
  if (!key || key.length !== 64) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY must be set (64 hex chars = 32 bytes). Generate with: openssl rand -hex 32"
    );
  }
  return key;
}

function getCredentialsFile(): string {
  return process.env.CREDENTIALS_FILE || "./data/axigen-credentials.json";
}

function ensureDataDir(): void {
  const credFile = getCredentialsFile();
  const dir = path.dirname(credFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function loadCredentials(): CredentialsDB {
  ensureDataDir();
  const credFile = getCredentialsFile();
  if (!fs.existsSync(credFile)) {
    return {};
  }
  try {
    const data = fs.readFileSync(credFile, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    console.error("[CredentialsStore] Failed to load credentials file:", err);
    return {};
  }
}

function saveCredentials(db: CredentialsDB): void {
  ensureDataDir();
  const credFile = getCredentialsFile();
  fs.writeFileSync(credFile, JSON.stringify(db, null, 2), "utf-8");
  // Set restrictive permissions (owner read/write only)
  try {
    fs.chmodSync(credFile, 0o600);
  } catch {
    // chmod may fail on Windows, that's ok
  }
}

/**
 * Encrypt a password using AES-256-GCM
 */
export function encryptPassword(password: string): {
  encrypted: string;
  iv: string;
  authTag: string;
} {
  const key = Buffer.from(getEncryptionKey(), "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(password, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return {
    encrypted,
    iv: iv.toString("hex"),
    authTag,
  };
}

/**
 * Decrypt a password using AES-256-GCM
 */
export function decryptPassword(
  encrypted: string,
  iv: string,
  authTag: string
): string {
  const key = Buffer.from(getEncryptionKey(), "hex");
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTag, "hex"));

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Store an Axigen password for a user (encrypted)
 */
export function storeAxigenPassword(email: string, password: string): void {
  const db = loadCredentials();
  const { encrypted, iv, authTag } = encryptPassword(password);

  const normalizedEmail = email.toLowerCase();
  db[normalizedEmail] = {
    email: normalizedEmail,
    encryptedPassword: encrypted,
    iv,
    authTag,
    linkedAt: new Date().toISOString(),
  };

  saveCredentials(db);
  console.log(`[CredentialsStore] Stored credentials for ${normalizedEmail}`);
}

/**
 * Get an Axigen password for a user (decrypted)
 * Returns null if not found or decryption fails
 */
export function getAxigenPassword(email: string): string | null {
  const db = loadCredentials();
  const cred = db[email.toLowerCase()];

  if (!cred) {
    return null;
  }

  try {
    return decryptPassword(cred.encryptedPassword, cred.iv, cred.authTag);
  } catch (err) {
    console.error(
      `[CredentialsStore] Failed to decrypt password for ${email}:`,
      err
    );
    return null;
  }
}

/**
 * Check if we have stored credentials for a user
 */
export function hasAxigenPassword(email: string): boolean {
  const db = loadCredentials();
  return email.toLowerCase() in db;
}

/**
 * Delete stored credentials for a user
 */
export function deleteAxigenPassword(email: string): void {
  const db = loadCredentials();
  const normalizedEmail = email.toLowerCase();
  if (normalizedEmail in db) {
    delete db[normalizedEmail];
    saveCredentials(db);
    console.log(
      `[CredentialsStore] Deleted credentials for ${normalizedEmail}`
    );
  }
}

/**
 * List all stored email addresses (without passwords)
 */
export function listStoredEmails(): string[] {
  const db = loadCredentials();
  return Object.keys(db);
}

/**
 * Get credential metadata (without the actual password)
 */
export function getCredentialMetadata(
  email: string
): { email: string; linkedAt: string } | null {
  const db = loadCredentials();
  const cred = db[email.toLowerCase()];
  if (!cred) {
    return null;
  }
  return {
    email: cred.email,
    linkedAt: cred.linkedAt,
  };
}
