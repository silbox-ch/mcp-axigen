import axios, { AxiosInstance } from "axios";
import https from "https";
import { config, getBaseUrl } from "../config.js";
import { handleAxiosError, AxigenError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type {
  Email,
  EmailFolder,
  SendEmailParams,
  SearchEmailParams,
  Contact,
} from "../types/axigen.js";
import type { UserCredentials } from "../types/user-context.js";

// Disable SSL verification for self-signed certificates
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

export class AxigenRestClient {
  private client: AxiosInstance;
  private sessid: string | null = null;
  private cookies: string[] = [];
  private isLoggedIn = false;

  // User credentials (for multi-user mode)
  private userCredentials: UserCredentials | null = null;

  /**
   * Create a new Axigen REST client
   * @param credentials - Optional user credentials for multi-user mode.
   *                      If not provided, uses config.axigen credentials (single-user mode)
   */
  constructor(credentials?: UserCredentials) {
    this.userCredentials = credentials || null;

    this.client = axios.create({
      baseURL: `${getBaseUrl()}/api/v1`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30000,
      httpsAgent,
    });

    // Log requests (without sensitive data)
    this.client.interceptors.request.use((req) => {
      logger.debug(`API Request: ${req.method?.toUpperCase()} ${req.url}`);
      return req;
    });

    // Log responses
    this.client.interceptors.response.use(
      (res) => {
        logger.debug(`API Response: ${res.status} ${res.config.url}`);
        return res;
      },
      (error) => {
        logger.error(
          `API Error: ${error.response?.status} ${error.config?.url}`
        );
        return Promise.reject(error);
      }
    );
  }

  /**
   * Get the username for this client
   */
  getUsername(): string {
    return this.userCredentials?.email || config.axigen.username;
  }

  /**
   * Login using cookie authentication
   * POST /api/v1/login/cookie with username/password
   * Then use Cookie header + ?_h=sessid for subsequent requests
   */
  async login(): Promise<void> {
    if (this.isLoggedIn) {
      return;
    }

    // Use user credentials if provided, otherwise fall back to config
    const username = this.userCredentials?.email || config.axigen.username;
    const password = this.userCredentials?.password || config.axigen.password;

    try {
      const response = await this.client.post("/login/cookie", {
        username,
        password,
      });

      if (response.data?.sessid) {
        this.sessid = response.data.sessid;
        this.cookies = response.headers["set-cookie"] || [];
        this.isLoggedIn = true;
        logger.info(`Successfully logged in to Axigen API as ${username}`);
      } else {
        throw new AxigenError("Login failed: no session ID returned", "AUTH_FAILED");
      }
    } catch (error) {
      this.isLoggedIn = false;
      handleAxiosError(error);
    }
  }

  /**
   * Make an authenticated request with session
   * Auto-retries once on 401 (session expired)
   */
  private async request<T>(
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    data?: unknown,
    params?: Record<string, unknown>,
    isRetry = false
  ): Promise<T> {
    await this.login();

    // Add sessid as query parameter
    const queryParams = { ...params, _h: this.sessid };

    try {
      const response = await this.client.request({
        method,
        url: path,
        data,
        params: queryParams,
        headers: {
          Cookie: this.cookies.join("; "),
        },
      });

      return response.data;
    } catch (error: unknown) {
      // If 401 and not already retrying, force re-login and retry once
      if (!isRetry && axios.isAxiosError(error) && error.response?.status === 401) {
        logger.debug("Session expired, re-authenticating...");
        this.isLoggedIn = false;
        this.sessid = null;
        this.cookies = [];
        return this.request<T>(method, path, data, params, true);
      }
      throw error;
    }
  }

  // ==================== Folders ====================

  async listFolders(): Promise<EmailFolder[]> {
    try {
      const response = await this.request<{ items: EmailFolder[] }>(
        "get",
        "/folders/"
      );
      return response.items || [];
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async getFolder(folderId: string): Promise<EmailFolder> {
    try {
      return await this.request<EmailFolder>("get", `/folders/${folderId}`);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  // ==================== Emails ====================

  async listEmails(
    folderId: string,
    options: { limit?: number; start?: number } = {}
  ): Promise<{ items: Email[]; totalItems: number; syncToken?: string }> {
    const { limit = 20, start = 0 } = options;

    try {
      return await this.request<{ items: Email[]; totalItems: number; syncToken?: string }>(
        "get",
        "/mails",
        undefined,
        { folderId, limit, start }
      );
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async getEmail(mailId: string): Promise<Email> {
    try {
      return await this.request<Email>("get", `/mails/${mailId}`);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async getEmailBody(
    mailId: string,
    type: "text" | "html" = "text"
  ): Promise<{ body: string; contentType: string }> {
    try {
      const response = await this.request<{
        data: string;
        contentType: string;
        isTruncated?: boolean;
      }>("get", `/mails/${mailId}/body`, undefined, { type });

      // Axigen returns body as base64-encoded in 'data' field
      const body = Buffer.from(response.data, "base64").toString("utf-8");

      return {
        body,
        contentType: response.contentType,
      };
    } catch (error) {
      handleAxiosError(error);
    }
  }

  /**
   * Search emails using POST /mails/search endpoint
   * Returns emails matching the search criteria
   *
   * Supported fields: from, to, cc, bcc, subject, body, anyfield,
   * before (dd-mm-yyyy), after (dd-mm-yyyy), hasatt, unread,
   * flag (followup|completed), importance, label, smaller, larger
   */
  async searchEmails(params: SearchEmailParams): Promise<Email[]> {
    try {
      if (!params.folder) {
        throw new AxigenError(
          "Search requires a folder_id parameter.",
          "FOLDER_REQUIRED"
        );
      }

      // Build query array for REST API
      // Note: value can be string or number (size filters require numbers)
      const query: Array<{ field: string; value: string | number; negate?: string }> = [];

      // Text search fields
      if (params.query) {
        query.push({ field: "anyfield", value: params.query });
      }
      if (params.from) {
        query.push({ field: "from", value: params.from });
      }
      if (params.to) {
        query.push({ field: "to", value: params.to });
      }
      if (params.cc) {
        query.push({ field: "cc", value: params.cc });
      }
      if (params.bcc) {
        query.push({ field: "bcc", value: params.bcc });
      }
      if (params.subject) {
        query.push({ field: "subject", value: params.subject });
      }
      if (params.body) {
        query.push({ field: "body", value: params.body });
      }

      // Date filters (convert ISO to dd-mm-yyyy)
      if (params.dateFrom) {
        const date = new Date(params.dateFrom);
        const formatted = `${String(date.getDate()).padStart(2, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${date.getFullYear()}`;
        query.push({ field: "after", value: formatted });
      }
      if (params.dateTo) {
        const date = new Date(params.dateTo);
        const formatted = `${String(date.getDate()).padStart(2, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${date.getFullYear()}`;
        query.push({ field: "before", value: formatted });
      }

      // Size filters - convert to bytes if needed (value must be a number, not string)
      if (params.smallerThan !== undefined) {
        const bytes = this.parseSizeToBytes(params.smallerThan);
        query.push({ field: "smaller", value: bytes });
      }
      if (params.largerThan !== undefined) {
        const bytes = this.parseSizeToBytes(params.largerThan);
        query.push({ field: "larger", value: bytes });
      }

      // Status filters
      if (params.isUnread !== undefined) {
        if (params.isUnread) {
          query.push({ field: "unread", value: "true" });
        } else {
          // unread with negate=yes means READ emails
          query.push({ field: "unread", value: "true", negate: "yes" });
        }
      }

      // Flag filter: isFlagged -> flag=followup
      if (params.isFlagged !== undefined) {
        if (params.isFlagged) {
          query.push({ field: "flag", value: "followup" });
        } else {
          query.push({ field: "flag", value: "followup", negate: "yes" });
        }
      }

      // Importance filter
      if (params.importance) {
        query.push({ field: "importance", value: params.importance });
      }

      // Has attachment filter
      if (params.hasAttachment) {
        query.push({ field: "hasatt", value: "true" });
      }

      // Label filter
      if (params.label) {
        query.push({ field: "label", value: params.label });
      }

      // If no criteria provided, we need at least one
      if (query.length === 0) {
        // Return all emails by default - use anyfield with empty-ish search
        // Actually, let's just list emails instead
        const response = await this.listEmails(params.folder, {
          limit: params.limit || 50,
          start: 0,
        });
        return response.items;
      }

      // Call POST /mails/search
      const searchResult = await this.request<{
        folderId: string;
        totalItems: number;
      }>("post", "/mails/search", {
        folderIds: [params.folder],
        query,
        recursive: params.recursive || false,
      });

      logger.debug(`Search created virtual folder: ${searchResult.folderId}, total: ${searchResult.totalItems}`);

      // Fetch emails from the virtual search folder
      if (searchResult.totalItems === 0) {
        return [];
      }

      const limit = params.limit || 50;
      const response = await this.listEmails(searchResult.folderId, {
        limit,
        start: 0,
      });

      return response.items;
    } catch (error) {
      handleAxiosError(error);
    }
  }

  /**
   * Parse size string (like "5M", "500K", "1000B") to bytes
   */
  private parseSizeToBytes(size: number | string): number {
    if (typeof size === "number") {
      return size;
    }

    const match = size.match(/^(\d+(?:\.\d+)?)\s*([BKMG]?)$/i);
    if (!match) {
      return parseInt(size, 10) || 0;
    }

    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();

    switch (unit) {
      case "G":
        return Math.round(value * 1024 * 1024 * 1024);
      case "M":
        return Math.round(value * 1024 * 1024);
      case "K":
        return Math.round(value * 1024);
      case "B":
      default:
        return Math.round(value);
    }
  }

  async sendEmail(params: SendEmailParams): Promise<{ mailId: string; processingId?: string }> {
    try {
      const emailData: Record<string, unknown> = {
        to: params.to.join(", "),
        subject: params.subject,
      };

      if (params.cc?.length) {
        emailData.cc = params.cc.join(", ");
      }
      if (params.bcc?.length) {
        emailData.bcc = params.bcc.join(", ");
      }
      if (params.htmlBody) {
        emailData.bodyHtml = params.htmlBody;
      }
      if (params.body) {
        emailData.bodyText = params.body;
      }

      return await this.request<{ mailId: string; processingId?: string }>(
        "post",
        "/mails/send",
        emailData
      );
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async replyEmail(
    mailId: string,
    body: string,
    replyAll: boolean = false
  ): Promise<{ mailId: string; processingId?: string }> {
    try {
      // Get original email to get recipients
      const original = await this.getEmail(mailId);

      const emailData: Record<string, unknown> = {
        refwType: "re",
        refwMailId: mailId,
        to: replyAll ? original.from : original.from,
        subject: `Re: ${original.subject}`,
        bodyText: body,
      };

      if (replyAll && original.cc) {
        emailData.cc = original.cc;
      }

      return await this.request<{ mailId: string; processingId?: string }>(
        "post",
        "/mails/send",
        emailData
      );
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async forwardEmail(
    mailId: string,
    to: string[],
    body?: string
  ): Promise<{ mailId: string; processingId?: string }> {
    try {
      const original = await this.getEmail(mailId);

      const emailData: Record<string, unknown> = {
        refwType: "fw",
        refwMailId: mailId,
        to: to.join(", "),
        subject: `Fwd: ${original.subject}`,
      };

      if (body) {
        emailData.bodyText = body;
      }

      return await this.request<{ mailId: string; processingId?: string }>(
        "post",
        "/mails/send",
        emailData
      );
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async moveEmail(mailId: string, destinationFolderId: string): Promise<void> {
    try {
      await this.request("post", `/mails/${mailId}/move`, {
        destinationFolderId,
      });
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async copyEmail(mailId: string, destinationFolderId: string): Promise<{ id: string }> {
    try {
      return await this.request<{ id: string }>("post", `/mails/${mailId}/copy`, {
        destinationFolderId,
      });
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async deleteEmail(mailId: string): Promise<void> {
    try {
      await this.request("delete", `/mails/${mailId}`);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  /**
   * Delete multiple emails in a single batch request
   * Uses POST /batch/mails/delete
   */
  async deleteEmailsBulk(mailIds: string[]): Promise<{ deleted: number; failed: string[] }> {
    try {
      const response = await this.request<{
        status: string;
        progress: number;
        failedItems?: string[];
      }>("post", "/batch/mails/delete", { ids: mailIds });

      const failed = response.failedItems || [];
      return {
        deleted: mailIds.length - failed.length,
        failed,
      };
    } catch (error) {
      handleAxiosError(error);
    }
  }

  /**
   * Move multiple emails in a single batch request
   * Uses POST /batch/mails/move
   */
  async moveEmailsBulk(
    mailIds: string[],
    destinationFolderId: string
  ): Promise<{ moved: number; failed: string[] }> {
    try {
      const response = await this.request<{
        status: string;
        progress: number;
        failedItems?: string[];
      }>("post", "/batch/mails/move", {
        ids: mailIds,
        destinationFolderId,
      });

      const failed = response.failedItems || [];
      return {
        moved: mailIds.length - failed.length,
        failed,
      };
    } catch (error) {
      handleAxiosError(error);
    }
  }

  /**
   * Update multiple emails (mark read/unread, flagged) in a single batch request
   * Uses POST /batch/mails/update
   */
  async updateEmailsBulk(
    mailIds: string[],
    updates: { isUnread?: boolean; isFlagged?: boolean }
  ): Promise<{ updated: number; failed: string[] }> {
    try {
      const response = await this.request<{
        status: string;
        progress: number;
        failedItems?: string[];
      }>("post", "/batch/mails/update", {
        ids: mailIds,
        ...updates,
      });

      const failed = response.failedItems || [];
      return {
        updated: mailIds.length - failed.length,
        failed,
      };
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async markRead(mailId: string, isUnread: boolean = false): Promise<void> {
    try {
      await this.request("patch", `/mails/${mailId}`, { isUnread });
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async markFlagged(mailId: string, isFlagged: boolean = true): Promise<void> {
    try {
      await this.request("patch", `/mails/${mailId}`, { isFlagged });
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async markSpam(mailId: string): Promise<void> {
    try {
      await this.request("post", `/mails/${mailId}/spam`);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async markNotSpam(mailId: string): Promise<void> {
    try {
      await this.request("post", `/mails/${mailId}/notspam`);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  // ==================== Folders ====================

  async createFolder(name: string, type: string = "mails", parentId?: string): Promise<{ id: string }> {
    try {
      const data: Record<string, unknown> = { name, type };
      if (parentId) {
        data.parentId = parentId;
      }
      return await this.request<{ id: string }>("post", "/folders/", data);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async deleteFolder(folderId: string): Promise<void> {
    try {
      await this.request("delete", `/folders/${folderId}`);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async renameFolder(folderId: string, newName: string): Promise<void> {
    try {
      await this.request("patch", `/folders/${folderId}`, { name: newName });
    } catch (error) {
      handleAxiosError(error);
    }
  }

  // ==================== Vacation ====================

  async getVacation(): Promise<{
    enabled: boolean;
    subject?: string;
    body?: string;
    startDate?: string;
    endDate?: string;
  }> {
    try {
      return await this.request<{
        enabled: boolean;
        subject?: string;
        body?: string;
        startDate?: string;
        endDate?: string;
      }>("get", "/account/vacation");
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async setVacation(params: {
    enabled: boolean;
    subject?: string;
    body?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<void> {
    try {
      await this.request("post", "/account/vacation", params);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  // ==================== Labels ====================

  async listLabels(): Promise<{ items: Array<{ id: string; name: string; color?: string }> }> {
    try {
      return await this.request<{ items: Array<{ id: string; name: string; color?: string }> }>(
        "get",
        "/labels/"
      );
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async createLabel(name: string, color?: string): Promise<{ id: string }> {
    try {
      const data: Record<string, unknown> = { name };
      if (color) {
        data.color = color;
      }
      return await this.request<{ id: string }>("post", "/labels/", data);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async deleteLabel(labelId: string): Promise<void> {
    try {
      await this.request("delete", `/labels/${labelId}`);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  // ==================== Scheduled Emails ====================

  async scheduleEmail(params: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body?: string;
    htmlBody?: string;
    sendAt: string; // ISO 8601 datetime
  }): Promise<{ mailId: string; processingId?: string }> {
    try {
      const emailData: Record<string, unknown> = {
        to: params.to.join(", "),
        subject: params.subject,
        sendAt: params.sendAt,
      };

      if (params.cc?.length) {
        emailData.cc = params.cc.join(", ");
      }
      if (params.bcc?.length) {
        emailData.bcc = params.bcc.join(", ");
      }
      if (params.htmlBody) {
        emailData.bodyHtml = params.htmlBody;
      }
      if (params.body) {
        emailData.bodyText = params.body;
      }

      return await this.request<{ mailId: string; processingId?: string }>(
        "post",
        "/mails/send/schedule",
        emailData
      );
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async undoSend(processingId: string): Promise<{ success: boolean }> {
    try {
      return await this.request<{ success: boolean }>("post", "/mails/send/undo", {
        processingId,
      });
    } catch (error) {
      handleAxiosError(error);
    }
  }

  // ==================== Account ====================

  async getAccountInfo(): Promise<{ name: string; domain: string; fullName: string }> {
    try {
      return await this.request<{ name: string; domain: string; fullName: string }>(
        "get",
        "/account/info"
      );
    } catch (error) {
      handleAxiosError(error);
    }
  }

  // ==================== Account Settings ====================
  // [TIMEZONE-FEATURE v1.5.5] Added to support VTIMEZONE in CalDAV
  // Read-only access to account settings, primarily for timezone
  // Rollback: Remove this method if causing issues (not used elsewhere)

  /**
   * Get account settings including timezone
   * Used by CalDAV client to generate proper VTIMEZONE blocks
   */
  async getAccountSettings(): Promise<{
    timezone?: string;
    language?: string;
    dateFormat?: string;
    timeFormat?: string;
    weekStartDay?: number;
  }> {
    try {
      return await this.request<{
        timezone?: string;
        language?: string;
        dateFormat?: string;
        timeFormat?: string;
        weekStartDay?: number;
      }>("get", "/account/settings");
    } catch (error) {
      handleAxiosError(error);
    }
  }

  // ==================== Contacts ====================

  async listContactFolders(): Promise<EmailFolder[]> {
    try {
      const response = await this.request<{ items: EmailFolder[] }>(
        "get",
        "/folders/",
        undefined,
        { type: "contacts" }
      );
      return response.items || [];
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async listContacts(
    folderId?: string,
    options: { limit?: number; start?: number } = {}
  ): Promise<{ items: Contact[]; totalItems: number }> {
    const { limit = 100, start = 0 } = options;

    try {
      const params: Record<string, unknown> = { limit, start };
      if (folderId) {
        params.folderId = folderId;
      }
      return await this.request<{ items: Contact[]; totalItems: number }>(
        "get",
        "/contacts/",
        undefined,
        params
      );
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async searchContacts(
    query: string,
    limit: number = 20
  ): Promise<{ items: Contact[]; totalItems: number }> {
    try {
      return await this.request<{ items: Contact[]; totalItems: number }>(
        "get",
        "/contacts/autocomplete",
        undefined,
        { query, limit }
      );
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async getContact(contactId: string): Promise<Contact | null> {
    // Note: Axigen REST API doesn't have a GET /contacts/{id} endpoint
    // We need to fetch all contacts and filter client-side
    try {
      // First try direct endpoint (may work on some Axigen versions)
      return await this.request<Contact>("get", `/contacts/${contactId}`);
    } catch {
      // Fallback: fetch contacts list and filter by ID
      logger.debug("getContact: Direct endpoint failed, using list+filter fallback");
      const response = await this.listContacts(undefined, { limit: 1000 });
      const contact = response.items.find((c) => c.id === contactId);
      return contact || null;
    }
  }

  async createContact(contact: {
    name?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    organization?: string;
    notes?: string;
    folderId?: string;
  }): Promise<{ id: string }> {
    try {
      const contactData: Record<string, unknown> = {};
      if (contact.name) contactData.name = contact.name;
      if (contact.firstName) contactData.firstName = contact.firstName;
      if (contact.lastName) contactData.lastName = contact.lastName;
      if (contact.email) contactData.email = contact.email;
      if (contact.phone) contactData.phone = contact.phone;
      if (contact.organization) contactData.organization = contact.organization;
      if (contact.notes) contactData.notes = contact.notes;
      if (contact.folderId) contactData.folderId = contact.folderId;

      return await this.request<{ id: string }>("post", "/contacts/", contactData);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async updateContact(
    contactId: string,
    updates: {
      name?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      organization?: string;
      notes?: string;
    }
  ): Promise<void> {
    try {
      await this.request("patch", `/contacts/${contactId}`, updates);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  async deleteContact(contactId: string): Promise<void> {
    try {
      await this.request("delete", `/contacts/${contactId}`);
    } catch (error) {
      handleAxiosError(error);
    }
  }

  // ==================== Logout ====================

  async logout(): Promise<void> {
    if (!this.isLoggedIn) return;

    try {
      await this.request("post", "/logout");
    } catch {
      // Ignore logout errors
    } finally {
      this.sessid = null;
      this.cookies = [];
      this.isLoggedIn = false;
    }
  }
}
