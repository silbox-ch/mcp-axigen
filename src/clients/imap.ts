import Imap from "imap";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { AxigenError } from "../utils/errors.js";
import type { Email, SearchEmailParams, Note, SearchNotesParams } from "../types/axigen.js";
import type { UserCredentials } from "../types/user-context.js";

/**
 * Convert IMAP UID to REST API compatible ID
 * REST API uses base64 encoded format: storeId_folderId_uid
 * @param uid - IMAP message UID
 * @param folderId - REST API folder ID (e.g., "414_1879")
 * @returns base64 encoded ID compatible with REST API
 */
export function imapUidToRestId(uid: number, folderId: string): string {
  const combined = `${folderId}_${uid}`;
  return Buffer.from(combined).toString("base64");
}

/**
 * Convert REST API ID back to IMAP UID
 * @param restId - base64 encoded REST API ID
 * @returns object with folderId and uid, or null if invalid
 */
export function restIdToImapUid(restId: string): { folderId: string; uid: number } | null {
  try {
    const decoded = Buffer.from(restId, "base64").toString("utf8");
    const parts = decoded.split("_");
    if (parts.length >= 3) {
      const uid = parseInt(parts[parts.length - 1], 10);
      const folderId = parts.slice(0, -1).join("_");
      return { folderId, uid };
    }
  } catch {
    // Invalid base64
  }
  return null;
}

interface ImapMessage {
  uid: number;
  flags: string[];
  date: Date;
  subject: string;
  from: string;
  to: string;
  cc?: string;
}

export class ImapClient {
  // User credentials (for multi-user mode)
  private userCredentials: UserCredentials | null = null;

  /**
   * Create a new IMAP client
   * @param credentials - Optional user credentials for multi-user mode.
   *                      If not provided, uses config.axigen credentials (single-user mode)
   */
  constructor(credentials?: UserCredentials) {
    this.userCredentials = credentials || null;
  }

  private getConnection(): Promise<Imap> {
    // Use user credentials if provided, otherwise fall back to config
    const username = this.userCredentials?.email || config.axigen.username;
    const password = this.userCredentials?.password || config.axigen.password;

    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: username,
        password: password,
        host: config.axigen.host,
        port: config.axigen.imapPort,
        tls: config.axigen.imapUseSsl,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
        connTimeout: 10000,
      });

      imap.once("ready", () => {
        resolve(imap);
      });

      imap.once("error", (err: Error) => {
        logger.error("IMAP connection error", { error: err.message });
        reject(new AxigenError(`IMAP connection failed: ${err.message}`, undefined, "IMAP_ERROR"));
      });

      imap.once("end", () => {
        logger.debug("IMAP connection ended");
      });

      imap.connect();
    });
  }

  /**
   * Search emails using IMAP SEARCH command
   * Supports: query (full-text), from, to, subject, dateFrom, dateTo, folder
   * @param params - Search parameters
   * @param restFolderId - Optional REST API folder ID (e.g., "414_1879") for ID conversion
   */
  async searchEmails(params: SearchEmailParams, restFolderId?: string): Promise<Email[]> {
    const imap = await this.getConnection();

    try {
      // Open the mailbox (folder)
      const mailbox = params.folder || "INBOX";
      await this.openBox(imap, mailbox);

      // Build IMAP search criteria
      const criteria = this.buildSearchCriteria(params);
      logger.debug("IMAP search criteria", { criteria });

      // Execute search
      const uids = await this.search(imap, criteria);
      logger.debug("IMAP search results", { count: uids.length });

      if (uids.length === 0) {
        imap.end();
        return [];
      }

      // Limit results
      const limit = params.limit || 20;
      const limitedUids = uids.slice(-limit).reverse(); // Most recent first

      // Fetch email headers
      const emails = await this.fetchHeaders(imap, limitedUids, restFolderId);

      imap.end();
      return emails;
    } catch (error) {
      imap.end();
      throw error;
    }
  }

  private openBox(imap: Imap, mailbox: string): Promise<Imap.Box> {
    return new Promise((resolve, reject) => {
      imap.openBox(mailbox, true, (err, box) => {
        if (err) {
          reject(new AxigenError(`Failed to open mailbox ${mailbox}: ${err.message}`, undefined, "IMAP_ERROR"));
        } else {
          resolve(box);
        }
      });
    });
  }

  private buildSearchCriteria(params: SearchEmailParams): (string | string[])[] {
    const criteria: (string | string[])[] = [];

    // Full-text search (searches subject, from, to, and body)
    if (params.query) {
      // IMAP TEXT searches both header and body
      criteria.push(["TEXT", params.query]);
    }

    // From filter
    if (params.from) {
      criteria.push(["FROM", params.from]);
    }

    // To filter
    if (params.to) {
      criteria.push(["TO", params.to]);
    }

    // Subject filter
    if (params.subject) {
      criteria.push(["SUBJECT", params.subject]);
    }

    // Date range filters
    if (params.dateFrom) {
      // IMAP expects date in format "DD-Mon-YYYY" e.g., "01-Jan-2024"
      const date = this.formatImapDate(params.dateFrom);
      criteria.push(["SINCE", date]);
    }

    if (params.dateTo) {
      const date = this.formatImapDate(params.dateTo);
      criteria.push(["BEFORE", date]);
    }

    // Read/Unread filter
    if (params.isUnread !== undefined) {
      if (params.isUnread) {
        criteria.push("UNSEEN");
      } else {
        criteria.push("SEEN");
      }
    }

    // Flagged filter
    if (params.isFlagged !== undefined) {
      if (params.isFlagged) {
        criteria.push("FLAGGED");
      } else {
        criteria.push("UNFLAGGED");
      }
    }

    // If no criteria specified, search ALL
    if (criteria.length === 0) {
      criteria.push("ALL");
    }

    return criteria;
  }

  private formatImapDate(isoDate: string): string {
    const date = new Date(isoDate);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  }

  private search(imap: Imap, criteria: (string | string[])[]): Promise<number[]> {
    return new Promise((resolve, reject) => {
      imap.search(criteria, (err, uids) => {
        if (err) {
          reject(new AxigenError(`IMAP search failed: ${err.message}`, undefined, "IMAP_ERROR"));
        } else {
          resolve(uids || []);
        }
      });
    });
  }

  private fetchHeaders(imap: Imap, uids: number[], restFolderId?: string): Promise<Email[]> {
    return new Promise((resolve, reject) => {
      const emails: Email[] = [];

      const fetch = imap.fetch(uids, {
        bodies: ["HEADER.FIELDS (FROM TO CC SUBJECT DATE)"],
        struct: true,
      });

      fetch.on("message", (msg, seqno) => {
        const email: Partial<ImapMessage> = { uid: seqno };
        let headerBuffer = "";

        msg.on("body", (stream) => {
          stream.on("data", (chunk) => {
            headerBuffer += chunk.toString("utf8");
          });
        });

        msg.once("attributes", (attrs) => {
          email.uid = attrs.uid;
          email.flags = attrs.flags || [];
          email.date = attrs.date;
        });

        msg.once("end", () => {
          const headers = this.parseHeaders(headerBuffer);
          // Convert IMAP UID to REST API compatible ID if folder ID is provided
          const emailId = restFolderId && email.uid
            ? imapUidToRestId(email.uid, restFolderId)
            : String(email.uid);

          emails.push({
            id: emailId,
            subject: headers.subject || "(No Subject)",
            from: headers.from || "",
            to: headers.to,
            cc: headers.cc,
            date: headers.date || (email.date ? email.date.toISOString() : ""),
            isUnread: !email.flags?.includes("\\Seen"),
            isFlagged: email.flags?.includes("\\Flagged"),
            folderId: restFolderId,
          });
        });
      });

      fetch.once("error", (err) => {
        reject(new AxigenError(`IMAP fetch failed: ${err.message}`, undefined, "IMAP_ERROR"));
      });

      fetch.once("end", () => {
        resolve(emails);
      });
    });
  }

  private parseHeaders(headerStr: string): Record<string, string> {
    const headers: Record<string, string> = {};
    const lines = headerStr.split(/\r?\n/);
    let currentKey = "";
    let currentValue = "";

    for (const line of lines) {
      if (line.startsWith(" ") || line.startsWith("\t")) {
        // Continuation of previous header
        currentValue += " " + line.trim();
      } else {
        // Save previous header
        if (currentKey) {
          headers[currentKey.toLowerCase()] = this.decodeHeader(currentValue);
        }
        // Parse new header
        const colonIndex = line.indexOf(":");
        if (colonIndex > 0) {
          currentKey = line.slice(0, colonIndex).trim();
          currentValue = line.slice(colonIndex + 1).trim();
        } else {
          currentKey = "";
          currentValue = "";
        }
      }
    }

    // Save last header
    if (currentKey) {
      headers[currentKey.toLowerCase()] = this.decodeHeader(currentValue);
    }

    return headers;
  }

  private decodeHeader(value: string): string {
    // Decode RFC 2047 encoded words (=?charset?encoding?text?=)
    return value.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (match, _charset, encoding, text) => {
      try {
        if (encoding.toUpperCase() === "B") {
          // Base64
          return Buffer.from(text, "base64").toString("utf8");
        } else if (encoding.toUpperCase() === "Q") {
          // Quoted-printable
          return text
            .replace(/_/g, " ")
            .replace(/=([0-9A-F]{2})/gi, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        }
      } catch {
        // If decoding fails, return original
      }
      return match;
    });
  }

  /**
   * List available mailboxes (folders)
   */
  async listMailboxes(): Promise<string[]> {
    const imap = await this.getConnection();

    return new Promise((resolve, reject) => {
      imap.getBoxes((err, boxes) => {
        imap.end();
        if (err) {
          reject(new AxigenError(`Failed to list mailboxes: ${err.message}`, undefined, "IMAP_ERROR"));
        } else {
          const mailboxNames = this.flattenBoxes(boxes);
          resolve(mailboxNames);
        }
      });
    });
  }

  private flattenBoxes(boxes: Imap.MailBoxes, prefix = ""): string[] {
    const names: string[] = [];
    for (const [name, box] of Object.entries(boxes)) {
      const fullName = prefix ? `${prefix}${box.delimiter}${name}` : name;
      names.push(fullName);
      if (box.children) {
        names.push(...this.flattenBoxes(box.children, fullName));
      }
    }
    return names;
  }

  // ==================== Notes Methods ====================

  /**
   * Notes folder name in IMAP (not visible in LIST but accessible via SELECT)
   */
  private readonly NOTES_FOLDER = "Notes";

  /**
   * Convert IMAP UID to Note ID (base64 encoded)
   */
  private noteUidToId(uid: number): string {
    return Buffer.from(`notes_${uid}`).toString("base64");
  }

  /**
   * Convert Note ID back to IMAP UID
   */
  private noteIdToUid(noteId: string): number | null {
    try {
      const decoded = Buffer.from(noteId, "base64").toString("utf8");
      if (decoded.startsWith("notes_")) {
        return parseInt(decoded.slice(6), 10);
      }
    } catch {
      // Invalid base64
    }
    return null;
  }

  /**
   * List all notes from the Notes folder
   * @param limit - Maximum number of notes to return (default: 50)
   */
  async listNotes(limit?: number): Promise<Note[]> {
    const imap = await this.getConnection();

    try {
      await this.openBox(imap, this.NOTES_FOLDER);

      const uids = await this.search(imap, ["ALL"]);
      logger.debug("IMAP listNotes", { count: uids.length });

      if (uids.length === 0) {
        imap.end();
        return [];
      }

      // Limit and reverse (most recent first)
      const maxNotes = limit || 50;
      const limitedUids = uids.slice(-maxNotes).reverse();

      const notes = await this.fetchNotes(imap, limitedUids, false);

      imap.end();
      return notes;
    } catch (error) {
      imap.end();
      throw error;
    }
  }

  /**
   * Get a single note by ID with full content
   * @param noteId - Note ID (base64 encoded)
   */
  async getNote(noteId: string): Promise<Note | null> {
    const uid = this.noteIdToUid(noteId);
    if (uid === null) {
      throw new AxigenError(`Invalid note ID: ${noteId}`, undefined, "INVALID_ID");
    }

    const imap = await this.getConnection();

    try {
      await this.openBox(imap, this.NOTES_FOLDER);

      const notes = await this.fetchNotes(imap, [uid], true);

      imap.end();
      return notes.length > 0 ? notes[0] : null;
    } catch (error) {
      imap.end();
      throw error;
    }
  }

  /**
   * Search notes by text content
   * @param params - Search parameters
   */
  async searchNotes(params: SearchNotesParams): Promise<Note[]> {
    const imap = await this.getConnection();

    try {
      await this.openBox(imap, this.NOTES_FOLDER);

      // Build search criteria
      const criteria: (string | string[])[] = [];
      if (params.query) {
        criteria.push(["TEXT", params.query]);
      } else {
        criteria.push("ALL");
      }

      const uids = await this.search(imap, criteria);
      logger.debug("IMAP searchNotes", { query: params.query, count: uids.length });

      if (uids.length === 0) {
        imap.end();
        return [];
      }

      const maxNotes = params.limit || 20;
      const limitedUids = uids.slice(-maxNotes).reverse();

      const notes = await this.fetchNotes(imap, limitedUids, false);

      imap.end();
      return notes;
    } catch (error) {
      imap.end();
      throw error;
    }
  }

  /**
   * Create a new note using IMAP APPEND
   * Axigen notes use specific headers:
   * - X-MAPI-Message-Class: IPM.StickyNote
   * - X-Uniform-Type-Identifier: com.apple.mail-note
   * @param title - Note title (becomes Subject header)
   * @param content - Note content (plain text)
   * @param htmlContent - Optional HTML content
   */
  async createNote(title: string, content: string, htmlContent?: string): Promise<{ noteId: string }> {
    const imap = await this.getConnection();

    try {
      // Open Notes folder in read-write mode
      await this.openBoxReadWrite(imap, this.NOTES_FOLDER);

      // Get user email for From header
      const userEmail = this.userCredentials?.email || config.axigen.username;

      // Generate unique Message-ID to find the note after creation
      const messageId = `${Date.now()}.${Math.random().toString(36).slice(2)}@mcp-axigen`;

      // Build RFC 822 message with Axigen note headers
      const message = this.buildNoteMessage(title, content, htmlContent, userEmail, messageId);

      // Append to Notes folder
      await this.appendMessage(imap, this.NOTES_FOLDER, message);

      // Search for the created note by Message-ID to get the real UID
      const uids = await this.searchByHeader(imap, "Message-ID", `<${messageId}>`);

      imap.end();

      if (uids.length === 0) {
        // Fallback: search by subject (less reliable but should work)
        const fallbackImap = await this.getConnection();
        await this.openBox(fallbackImap, this.NOTES_FOLDER);
        const allUids = await this.search(fallbackImap, ["ALL"]);
        fallbackImap.end();

        if (allUids.length > 0) {
          // Use the last UID (most recently added)
          const noteId = this.noteUidToId(allUids[allUids.length - 1]);
          logger.info("Note created (fallback)", { noteId, title });
          return { noteId };
        }
        throw new AxigenError("Failed to find created note", undefined, "CREATE_FAILED");
      }

      const noteId = this.noteUidToId(uids[0]);
      logger.info("Note created", { noteId, title });

      return { noteId };
    } catch (error) {
      imap.end();
      throw error;
    }
  }

  /**
   * Search messages by header value
   */
  private searchByHeader(imap: Imap, header: string, value: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
      imap.search([["HEADER", header, value]], (err, uids) => {
        if (err) {
          reject(new AxigenError(`IMAP search failed: ${err.message}`, undefined, "IMAP_ERROR"));
        } else {
          resolve(uids || []);
        }
      });
    });
  }

  /**
   * Update an existing note (delete old + create new)
   * IMAP doesn't support direct message editing, so we:
   * 1. Fetch the existing note to preserve any data we don't modify
   * 2. Create a new note with updated content
   * 3. Delete the old note
   * @param noteId - Note ID to update
   * @param title - New title (optional, keeps existing if not provided)
   * @param content - New content (optional, keeps existing if not provided)
   */
  async updateNote(noteId: string, title?: string, content?: string): Promise<{ noteId: string }> {
    // First get the existing note
    const existingNote = await this.getNote(noteId);
    if (!existingNote) {
      throw new AxigenError(`Note not found: ${noteId}`, 404, "NOT_FOUND");
    }

    // Create new note with updated values
    const newTitle = title ?? existingNote.title;
    const newContent = content ?? existingNote.body;

    const result = await this.createNote(newTitle, newContent);

    // Delete the old note
    await this.deleteNote(noteId);

    logger.info("Note updated", { oldNoteId: noteId, newNoteId: result.noteId });

    return result;
  }

  /**
   * Delete a note using IMAP STORE \Deleted + EXPUNGE
   * @param noteId - Note ID to delete
   */
  async deleteNote(noteId: string): Promise<void> {
    const uid = this.noteIdToUid(noteId);
    if (uid === null) {
      throw new AxigenError(`Invalid note ID: ${noteId}`, undefined, "INVALID_ID");
    }

    const imap = await this.getConnection();

    try {
      await this.openBoxReadWrite(imap, this.NOTES_FOLDER);

      // Mark as deleted
      await this.storeFlags(imap, [uid], ["\\Deleted"], true);

      // Expunge to permanently delete
      await this.expunge(imap);

      imap.end();
      logger.info("Note deleted", { noteId });
    } catch (error) {
      imap.end();
      throw error;
    }
  }

  // ==================== Notes Helper Methods ====================

  /**
   * Open mailbox in read-write mode (for APPEND, STORE, EXPUNGE)
   */
  private openBoxReadWrite(imap: Imap, mailbox: string): Promise<Imap.Box> {
    return new Promise((resolve, reject) => {
      imap.openBox(mailbox, false, (err, box) => {
        if (err) {
          reject(new AxigenError(`Failed to open mailbox ${mailbox}: ${err.message}`, undefined, "IMAP_ERROR"));
        } else {
          resolve(box);
        }
      });
    });
  }

  /**
   * Fetch notes from IMAP
   * @param imap - IMAP connection
   * @param uids - UIDs to fetch
   * @param includeBody - Whether to fetch full body content
   */
  private fetchNotes(imap: Imap, uids: number[], includeBody: boolean): Promise<Note[]> {
    return new Promise((resolve, reject) => {
      const notes: Note[] = [];

      // When including body, fetch the entire message to properly parse MIME
      const fetchOptions: Imap.FetchOptions = {
        bodies: includeBody ? [""] : ["HEADER.FIELDS (FROM SUBJECT DATE)"],
        struct: true,
      };

      const fetch = imap.fetch(uids, fetchOptions);

      fetch.on("message", (msg) => {
        const note: Partial<Note> & { uid?: number; flags?: string[] } = {};
        let messageBuffer = "";

        msg.on("body", (stream) => {
          stream.on("data", (chunk) => {
            messageBuffer += chunk.toString("utf8");
          });
        });

        msg.once("attributes", (attrs) => {
          note.uid = attrs.uid;
          note.flags = attrs.flags || [];
          note.date = attrs.date ? attrs.date.toISOString() : new Date().toISOString();
        });

        msg.once("end", () => {
          if (includeBody) {
            // Parse full message (headers + body)
            const parsed = this.parseFullMessage(messageBuffer);
            note.id = this.noteUidToId(note.uid!);
            note.title = this.cleanTitle(parsed.headers.subject || "(No Title)");
            note.from = parsed.headers.from;
            note.body = parsed.body.text;
            note.htmlBody = parsed.body.html;
          } else {
            // Just headers
            const headers = this.parseHeaders(messageBuffer);
            note.id = this.noteUidToId(note.uid!);
            note.title = this.cleanTitle(headers.subject || "(No Title)");
            note.from = headers.from;
            note.body = "";
          }

          note.isUnread = !note.flags?.includes("\\Seen");
          note.isFlagged = note.flags?.includes("\\Flagged");

          notes.push(note as Note);
        });
      });

      fetch.once("error", (err) => {
        reject(new AxigenError(`IMAP fetch failed: ${err.message}`, undefined, "IMAP_ERROR"));
      });

      fetch.once("end", () => {
        resolve(notes);
      });
    });
  }

  /**
   * Clean note title (remove invisible characters like ZWSP)
   */
  private cleanTitle(title: string): string {
    // Remove Zero Width Space (U+200B) and other invisible characters
    // Also handle UTF-8 mis-encoded ZWSP (bytes 0xE2 0x80 0x8B)
    return title
      .replace(/[\u200B-\u200D\uFEFF]/g, "") // Unicode ZWSP
      .replace(/\u00E2\u0080[\u008B-\u008D]/g, "") // UTF-8 mis-encoded ZWSP
      .replace(/\xE2\x80\x8B/g, "") // Raw mis-encoded ZWSP bytes
      .trim();
  }

  /**
   * Parse a full RFC 822 message (headers + body)
   */
  private parseFullMessage(message: string): { headers: Record<string, string>; body: { text: string; html?: string } } {
    // Split headers and body (separated by double CRLF)
    const headerBodySplit = message.indexOf("\r\n\r\n");
    if (headerBodySplit === -1) {
      // Try with just \n\n
      const altSplit = message.indexOf("\n\n");
      if (altSplit === -1) {
        return { headers: this.parseHeaders(message), body: { text: "" } };
      }
      const headers = this.parseHeaders(message.slice(0, altSplit));
      const bodyPart = message.slice(altSplit + 2);
      return { headers, body: this.parseNoteBody(bodyPart, headers["content-type"]) };
    }

    const headers = this.parseHeaders(message.slice(0, headerBodySplit));
    const bodyPart = message.slice(headerBodySplit + 4);

    return { headers, body: this.parseNoteBody(bodyPart, headers["content-type"]) };
  }

  /**
   * Parse note body content (handles MIME multipart)
   * @param bodyStr - The body content
   * @param contentType - Optional Content-Type header value
   */
  private parseNoteBody(bodyStr: string, contentType?: string): { text: string; html?: string } {
    // Check if it's multipart from Content-Type header or body content
    let boundary: string | null = null;

    if (contentType) {
      const boundaryMatch = contentType.match(/boundary="?([^";\r\n]+)"?/i);
      if (boundaryMatch) {
        boundary = boundaryMatch[1];
      }
    }

    if (!boundary) {
      // Try to find boundary in body itself
      const bodyBoundaryMatch = bodyStr.match(/boundary="?([^";\r\n]+)"?/i);
      if (bodyBoundaryMatch) {
        boundary = bodyBoundaryMatch[1];
      }
    }

    if (boundary) {
      const parts = bodyStr.split(`--${boundary}`);

      let textContent = "";
      let htmlContent = "";

      for (const part of parts) {
        // Skip boundary markers and empty parts
        if (part.trim() === "" || part.trim() === "--") continue;

        const partLower = part.toLowerCase();

        if (partLower.includes("content-type: text/plain") || partLower.includes("content-type:text/plain")) {
          // Extract text content
          const contentStart = part.search(/\r?\n\r?\n/);
          if (contentStart !== -1) {
            const rawContent = part.slice(contentStart).replace(/^\r?\n\r?\n/, "");
            // Remove trailing boundary marker if present
            const cleanContent = rawContent.replace(/--$/, "").trim();
            textContent = this.decodeQuotedPrintable(cleanContent);
          }
        } else if (partLower.includes("content-type: text/html") || partLower.includes("content-type:text/html")) {
          // Extract HTML content
          const contentStart = part.search(/\r?\n\r?\n/);
          if (contentStart !== -1) {
            const rawContent = part.slice(contentStart).replace(/^\r?\n\r?\n/, "");
            const cleanContent = rawContent.replace(/--$/, "").trim();
            htmlContent = this.decodeQuotedPrintable(cleanContent);
          }
        }
      }

      return { text: textContent, html: htmlContent || undefined };
    }

    // Not multipart, check if it's quoted-printable
    if (bodyStr.includes("=E2") || bodyStr.includes("=0A")) {
      return { text: this.decodeQuotedPrintable(bodyStr.trim()) };
    }

    // Plain text
    return { text: bodyStr.trim() };
  }

  /**
   * Decode quoted-printable encoding
   */
  private decodeQuotedPrintable(str: string): string {
    return str
      .replace(/=\r?\n/g, "") // Remove soft line breaks
      .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  /**
   * Build RFC 822 message for a note with Axigen-specific headers
   */
  private buildNoteMessage(title: string, content: string, htmlContent: string | undefined, userEmail: string, messageId?: string): string {
    const date = new Date().toUTCString();
    const msgId = messageId ? `<${messageId}>` : `<${Date.now()}.${Math.random().toString(36).slice(2)}@mcp-axigen>`;
    const boundary = `===mcp-axigen=${Date.now()}===`;

    // Encode title for RFC 2047 if needed
    const encodedTitle = this.encodeHeaderValue(title);

    // Build headers
    let message = [
      `From: ${userEmail}`,
      `Date: ${date}`,
      `Message-ID: ${msgId}`,
      `X-MAPI-Message-Class: IPM.StickyNote`,
      `X-Uniform-Type-Identifier: com.apple.mail-note`,
      `X-Mailer: MCP-Axigen`,
      `Subject: ${encodedTitle}`,
      `MIME-Version: 1.0`,
    ].join("\r\n");

    if (htmlContent) {
      // Multipart message with text and HTML
      message += `\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
      message += `--${boundary}\r\n`;
      message += `Content-Type: text/plain; charset="utf-8"\r\n`;
      message += `Content-Transfer-Encoding: quoted-printable\r\n\r\n`;
      message += this.encodeQuotedPrintable(content);
      message += `\r\n--${boundary}\r\n`;
      message += `Content-Type: text/html; charset="utf-8"\r\n`;
      message += `Content-Transfer-Encoding: quoted-printable\r\n\r\n`;
      message += this.encodeQuotedPrintable(htmlContent);
      message += `\r\n--${boundary}--\r\n`;
    } else {
      // Simple text message
      message += `\r\nContent-Type: text/plain; charset="utf-8"\r\n`;
      message += `Content-Transfer-Encoding: quoted-printable\r\n\r\n`;
      message += this.encodeQuotedPrintable(content);
    }

    return message;
  }

  /**
   * Encode header value using RFC 2047 if it contains non-ASCII
   */
  private encodeHeaderValue(value: string): string {
    // Check if encoding is needed
    if (/^[\x20-\x7E]*$/.test(value)) {
      return value; // ASCII only, no encoding needed
    }
    // Use Base64 encoding for non-ASCII
    const encoded = Buffer.from(value, "utf8").toString("base64");
    return `=?utf-8?B?${encoded}?=`;
  }

  /**
   * Encode content as quoted-printable
   */
  private encodeQuotedPrintable(str: string): string {
    return str
      .split("")
      .map((char) => {
        const code = char.charCodeAt(0);
        if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126 && code !== 61)) {
          return char;
        }
        // Encode as =XX
        return "=" + code.toString(16).toUpperCase().padStart(2, "0");
      })
      .join("")
      // Add soft line breaks for long lines
      .replace(/(.{73})/g, "$1=\r\n");
  }

  /**
   * Append a message to a mailbox using IMAP APPEND
   * @returns The UID of the appended message
   */
  private appendMessage(imap: Imap, mailbox: string, message: string): Promise<number> {
    return new Promise((resolve, reject) => {
      imap.append(message, { mailbox }, (err: Error | null) => {
        if (err) {
          reject(new AxigenError(`IMAP append failed: ${err.message}`, undefined, "IMAP_ERROR"));
        } else {
          // IMAP append doesn't return UID directly, use timestamp as fallback
          resolve(Date.now());
        }
      });
    });
  }

  /**
   * Store flags on messages
   */
  private storeFlags(imap: Imap, uids: number[], flags: string[], add: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const method = add ? "addFlags" : "delFlags";
      (imap as any)[method](uids, flags, (err: Error | null) => {
        if (err) {
          reject(new AxigenError(`IMAP ${method} failed: ${err.message}`, undefined, "IMAP_ERROR"));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Expunge deleted messages
   */
  private expunge(imap: Imap): Promise<void> {
    return new Promise((resolve, reject) => {
      imap.expunge((err) => {
        if (err) {
          reject(new AxigenError(`IMAP expunge failed: ${err.message}`, undefined, "IMAP_ERROR"));
        } else {
          resolve();
        }
      });
    });
  }
}
