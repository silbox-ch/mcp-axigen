import * as dotenv from "dotenv";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load .env file
dotenv.config();

// OAuth configuration (optional - for multi-user mode)
export interface OAuthConfig {
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  credentialsEncryptionKey: string;
  credentialsFile: string;
}

export function getOAuthConfig(): OAuthConfig {
  return {
    discoveryUrl: process.env.OIDC_DISCOVERY_URL || "",
    clientId: process.env.OIDC_CLIENT_ID || "",
    clientSecret: process.env.OIDC_CLIENT_SECRET || "",
    redirectUri: process.env.OIDC_REDIRECT_URI || "",
    scopes: process.env.OIDC_SCOPES || "openid profile email",
    credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY || "",
    credentialsFile: process.env.CREDENTIALS_FILE || "./data/axigen-credentials.json",
  };
}

/**
 * Check if OAuth multi-user mode is enabled
 * OAuth is enabled when OIDC_DISCOVERY_URL is configured
 */
export function isOAuthEnabled(): boolean {
  const oauth = getOAuthConfig();
  return !!(
    oauth.discoveryUrl &&
    oauth.clientId &&
    oauth.clientSecret &&
    oauth.redirectUri
  );
}

/**
 * Get the current authentication mode
 */
export function getAuthMode(): "oauth" | "single-user" {
  return isOAuthEnabled() ? "oauth" : "single-user";
}

// Read version from package.json
function getPackageVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const packagePath = join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

// Check if OIDC is configured (before schema validation)
const oidcConfigured = !!(
  process.env.OIDC_DISCOVERY_URL &&
  process.env.OIDC_CLIENT_ID &&
  process.env.OIDC_CLIENT_SECRET &&
  process.env.OIDC_REDIRECT_URI
);

// In OAuth mode, username/password are optional (per-user credentials)
// In single-user mode, they are required
const configSchema = z.object({
  axigen: z.object({
    host: z.string().min(1),
    port: z.number().default(443),
    useSsl: z.boolean().default(true),
    // Username/password optional in OAuth mode
    username: oidcConfigured ? z.string().default("") : z.string().min(1),
    password: oidcConfigured ? z.string().default("") : z.string().min(1),
    apiToken: z.string().optional(),
    caldavUrl: z.string().optional(),
    carddavUrl: z.string().optional(),
    imapPort: z.number().default(993),
    imapUseSsl: z.boolean().default(true),
  }),
  server: z.object({
    name: z.string().default("mcp-axigen"),
    version: z.string().default("1.0.0"),
    mode: z.enum(["stdio", "sse"]).default("stdio"),
    port: z.number().default(3000),
    publicUrl: z.string().optional(),
  }),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const config = {
    axigen: {
      host: process.env.AXIGEN_HOST || "",
      port: parseInt(process.env.AXIGEN_PORT || "443", 10),
      useSsl: process.env.AXIGEN_USE_SSL !== "false",
      username: process.env.AXIGEN_USERNAME || "",
      password: process.env.AXIGEN_PASSWORD || "",
      apiToken: process.env.AXIGEN_API_TOKEN,
      caldavUrl: process.env.AXIGEN_CALDAV_URL,
      carddavUrl: process.env.AXIGEN_CARDDAV_URL,
      imapPort: parseInt(process.env.AXIGEN_IMAP_PORT || "993", 10),
      imapUseSsl: process.env.AXIGEN_IMAP_USE_SSL !== "false",
    },
    server: {
      name: process.env.MCP_SERVER_NAME || "mcp-axigen",
      version: getPackageVersion(),
      mode: (process.env.MCP_MODE as "stdio" | "sse") || "stdio",
      port: parseInt(process.env.MCP_PORT || "3000", 10),
      publicUrl: process.env.MCP_PUBLIC_URL,
    },
    logLevel: (process.env.LOG_LEVEL as Config["logLevel"]) || "info",
  };

  return configSchema.parse(config);
}

export const config = loadConfig();

export function getBaseUrl(): string {
  const protocol = config.axigen.useSsl ? "https" : "http";
  const port = config.axigen.port === 443 ? "" : `:${config.axigen.port}`;
  return `${protocol}://${config.axigen.host}${port}`;
}

export function getCalDavUrl(): string {
  if (config.axigen.caldavUrl) {
    return config.axigen.caldavUrl;
  }
  return `${getBaseUrl()}/caldav/${config.axigen.username}/`;
}

export function getCardDavUrl(): string {
  if (config.axigen.carddavUrl) {
    return config.axigen.carddavUrl;
  }
  return `${getBaseUrl()}/carddav/${config.axigen.username}/`;
}
