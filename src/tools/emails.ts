import { logger } from "../utils/logger.js";
import { formatErrorResponse } from "../utils/errors.js";
import type { ToolResponse } from "../types/mcp.js";
import { createRestClient, createImapClient, validateCredentials } from "../clients/factory.js";
import { getCurrentOAuthSessionId } from "../utils/request-context.js";

/**
 * Get an Axigen REST client for the current request context
 */
function getClient() {
  const oauthSessionId = getCurrentOAuthSessionId();
  return createRestClient(oauthSessionId);
}

/**
 * Get an IMAP client for the current request context
 */
function getImapClient() {
  const oauthSessionId = getCurrentOAuthSessionId();
  return createImapClient(oauthSessionId);
}

/**
 * Check if the current request has valid credentials
 * Returns an error response if not
 */
function checkAuth(): ToolResponse | null {
  const oauthSessionId = getCurrentOAuthSessionId();
  const error = validateCredentials(oauthSessionId);
  if (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error }) }],
      isError: true,
    };
  }
  return null;
}

export async function handleListFolders(): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const folders = await getClient().listFolders();

    const result = {
      count: folders.length,
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        role: f.role,
        totalItems: f.totalItems,
        unreadItems: f.unreadItems,
        folderType: f.folderType,
      })),
    };

    logger.tool("list_folders", {}, Date.now() - startTime, folders.length);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("list_folders failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleListEmails(args: {
  folder_id: string;
  limit?: number;
  start?: number;
}): Promise<ToolResponse> {
  const startTime = Date.now();
  const folderId = args.folder_id;
  const limit = args.limit || 20;
  const start = args.start || 0;

  try {
    const response = await getClient().listEmails(folderId, { limit, start });

    const summary = response.items.map((email) => ({
      id: email.id,
      subject: email.subject,
      from: email.from,
      date: email.date,
      isUnread: email.isUnread,
      hasAttachments: email.hasAttachments,
    }));

    const result = {
      folderId,
      totalItems: response.totalItems,
      count: summary.length,
      start,
      emails: summary,
    };

    logger.tool(
      "list_emails",
      { folderId, limit, start },
      Date.now() - startTime,
      summary.length
    );

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("list_emails failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleGetEmail(args: {
  mail_id: string;
  include_body?: boolean;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const email = await getClient().getEmail(args.mail_id);

    const result: Record<string, unknown> = {
      id: email.id,
      subject: email.subject,
      from: email.from,
      to: email.to,
      cc: email.cc,
      date: email.date,
      isUnread: email.isUnread,
      isFlagged: email.isFlagged,
      hasAttachments: email.hasAttachments,
      attachments: email.attachments?.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      })),
    };

    // Fetch body if requested
    if (args.include_body) {
      try {
        const bodyResponse = await getClient().getEmailBody(args.mail_id, "text");
        result.body = bodyResponse.body;
      } catch {
        // Body might not be available
        result.body = null;
      }
    }

    logger.tool("get_email", { mail_id: args.mail_id }, Date.now() - startTime);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("get_email failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleSearchEmails(args: {
  query?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  date_from?: string;
  date_to?: string;
  smaller_than?: string;
  larger_than?: string;
  folder_id?: string;
  limit?: number;
  is_unread?: boolean;
  is_flagged?: boolean;
  importance?: "high" | "normal" | "low";
  has_attachment?: boolean;
  label?: string;
  ids_only?: boolean;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  // Auto-limit for full results to prevent token explosion
  const AUTO_LIMIT_FULL = 50;

  try {
    // Get folder ID - default to INBOX if not specified
    let folderId = args.folder_id;
    let folderName = "INBOX";

    if (!folderId) {
      // Get INBOX folder ID from REST API
      const folders = await getClient().listFolders();
      const inboxFolder = folders.find(
        (f) => f.name.toUpperCase() === "INBOX" || f.role === "inbox"
      );
      if (inboxFolder) {
        folderId = inboxFolder.id;
        folderName = inboxFolder.name;
      } else {
        throw new Error("Could not find INBOX folder");
      }
    } else if (folderId.includes("_")) {
      // It's a REST folder ID, get the name
      const folders = await getClient().listFolders();
      const folder = folders.find((f) => f.id === folderId);
      if (folder) {
        folderName = folder.name;
      }
    } else {
      // It's a folder name, find the ID
      const folders = await getClient().listFolders();
      const folder = folders.find(
        (f) => f.name.toUpperCase() === folderId!.toUpperCase()
      );
      if (folder) {
        folderName = folder.name;
        folderId = folder.id;
      }
    }

    // Use REST API search
    const emails = await getClient().searchEmails({
      query: args.query,
      from: args.from,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      body: args.body,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      smallerThan: args.smaller_than,
      largerThan: args.larger_than,
      folder: folderId,
      limit: args.limit || AUTO_LIMIT_FULL,
      isUnread: args.is_unread,
      isFlagged: args.is_flagged,
      importance: args.importance,
      hasAttachment: args.has_attachment,
      label: args.label,
    });

    const totalCount = emails.length;

    // If ids_only mode, return only IDs (for bulk operations)
    if (args.ids_only) {
      const ids = emails.map((email) => email.id);

      // Compact format: IDs as JSON array on one line, ready to copy-paste
      const compactIds = JSON.stringify(ids);

      logger.tool("search_emails", { ...args, ids_only: true }, Date.now() - startTime, totalCount);

      return {
        content: [
          {
            type: "text",
            text: `Found ${totalCount} emails in ${folderName}.
To delete all: delete_emails_bulk with mail_ids=${compactIds}
To move all: move_emails_bulk with mail_ids=${compactIds} and destination_folder_id=<folder_id>`,
          },
        ],
      };
    }

    // Full mode: return email details
    // Auto-limit to prevent token explosion if > AUTO_LIMIT_FULL results
    const shouldLimit = totalCount > AUTO_LIMIT_FULL;
    const emailsToReturn = shouldLimit ? emails.slice(0, AUTO_LIMIT_FULL) : emails;

    const summary = emailsToReturn.map((email) => ({
      id: email.id,
      subject: email.subject,
      from: email.from,
      to: email.to,
      date: email.date,
      isUnread: email.isUnread,
      isFlagged: email.isFlagged,
    }));

    const result: Record<string, unknown> = {
      count: totalCount,
      folder: folderName,
      folderId: folderId,
      emails: summary,
    };

    // Add hint if results were truncated
    if (shouldLimit) {
      result.showing = AUTO_LIMIT_FULL;
      result.hint = `Showing first ${AUTO_LIMIT_FULL} of ${totalCount} results. Use ids_only=true to get all ${totalCount} IDs for bulk operations (delete_emails_bulk, move_emails_bulk, etc.)`;
    }

    logger.tool("search_emails", args, Date.now() - startTime, totalCount);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("search_emails failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleSendEmail(args: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html_body?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const result = await getClient().sendEmail({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      body: args.body,
      htmlBody: args.html_body,
    });

    logger.tool("send_email", { to: args.to, subject: args.subject }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              mailId: result.mailId,
              message: `Email sent successfully to ${args.to.join(", ")}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("send_email failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleReplyEmail(args: {
  mail_id: string;
  body: string;
  reply_all?: boolean;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const result = await getClient().replyEmail(
      args.mail_id,
      args.body,
      args.reply_all || false
    );

    logger.tool(
      "reply_email",
      { mail_id: args.mail_id, reply_all: args.reply_all },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              mailId: result.mailId,
              message: "Reply sent successfully",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("reply_email failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleForwardEmail(args: {
  mail_id: string;
  to: string[];
  body?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const result = await getClient().forwardEmail(args.mail_id, args.to, args.body);

    logger.tool(
      "forward_email",
      { mail_id: args.mail_id, to: args.to },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              mailId: result.mailId,
              message: `Email forwarded to ${args.to.join(", ")}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("forward_email failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleMoveEmail(args: {
  mail_id: string;
  destination_folder_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    await getClient().moveEmail(args.mail_id, args.destination_folder_id);

    logger.tool(
      "move_email",
      { mail_id: args.mail_id, destination_folder_id: args.destination_folder_id },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: `Email moved to folder ${args.destination_folder_id}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("move_email failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleDeleteEmail(args: {
  mail_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    await getClient().deleteEmail(args.mail_id);

    logger.tool("delete_email", { mail_id: args.mail_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: "Email deleted",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("delete_email failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleMarkRead(args: {
  mail_id: string;
  is_unread: boolean;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    await getClient().markRead(args.mail_id, args.is_unread);

    logger.tool(
      "mark_read",
      { mail_id: args.mail_id, is_unread: args.is_unread },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: `Email marked as ${args.is_unread ? "unread" : "read"}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("mark_read failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

// ==================== Bulk Operations ====================

// Minimum IDs required for bulk operations - prevents calling one at a time
const BULK_MIN_IDS = 2;

function validateBulkOperation(mailIds: string[], operation: string): ToolResponse | null {
  if (!mailIds || mailIds.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "NO_IDS_PROVIDED",
              message: `${operation} requires an array of mail IDs. Use search_emails with ids_only=true first to get the IDs.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (mailIds.length === 1) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "USE_SINGLE_OPERATION",
              message: `${operation} received only 1 ID. For single emails, use the non-bulk operation. For multiple emails, pass ALL IDs in ONE call - do not call this repeatedly.`,
              hint: "If you have multiple IDs from search_emails, pass them ALL at once in the mail_ids array.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return null; // Valid
}

export async function handleDeleteEmailsBulk(args: {
  mail_ids: string[];
}): Promise<ToolResponse> {
  const startTime = Date.now();

  // Validate bulk operation
  const validationError = validateBulkOperation(args.mail_ids, "delete_emails_bulk");
  if (validationError) {
    logger.warn("delete_emails_bulk called with insufficient IDs", { count: args.mail_ids?.length || 0 });
    return validationError;
  }

  try {
    const result = await getClient().deleteEmailsBulk(args.mail_ids);

    logger.tool(
      "delete_emails_bulk",
      { count: args.mail_ids.length },
      Date.now() - startTime,
      result.deleted
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: result.failed.length === 0,
              deleted: result.deleted,
              failed: result.failed.length,
              failedIds: result.failed.length > 0 ? result.failed : undefined,
              message: `Deleted ${result.deleted} of ${args.mail_ids.length} emails`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("delete_emails_bulk failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleMoveEmailsBulk(args: {
  mail_ids: string[];
  destination_folder_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  // Validate bulk operation
  const validationError = validateBulkOperation(args.mail_ids, "move_emails_bulk");
  if (validationError) {
    logger.warn("move_emails_bulk called with insufficient IDs", { count: args.mail_ids?.length || 0 });
    return validationError;
  }

  try {
    const result = await getClient().moveEmailsBulk(args.mail_ids, args.destination_folder_id);

    logger.tool(
      "move_emails_bulk",
      { count: args.mail_ids.length, destination: args.destination_folder_id },
      Date.now() - startTime,
      result.moved
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: result.failed.length === 0,
              moved: result.moved,
              failed: result.failed.length,
              failedIds: result.failed.length > 0 ? result.failed : undefined,
              message: `Moved ${result.moved} of ${args.mail_ids.length} emails to folder ${args.destination_folder_id}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("move_emails_bulk failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleMarkReadBulk(args: {
  mail_ids: string[];
  is_unread: boolean;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  // Validate bulk operation
  const validationError = validateBulkOperation(args.mail_ids, "mark_read_bulk");
  if (validationError) {
    logger.warn("mark_read_bulk called with insufficient IDs", { count: args.mail_ids?.length || 0 });
    return validationError;
  }

  try {
    const result = await getClient().updateEmailsBulk(args.mail_ids, { isUnread: args.is_unread });

    const action = args.is_unread ? "unread" : "read";
    logger.tool(
      "mark_read_bulk",
      { count: args.mail_ids.length, is_unread: args.is_unread },
      Date.now() - startTime,
      result.updated
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: result.failed.length === 0,
              updated: result.updated,
              failed: result.failed.length,
              failedIds: result.failed.length > 0 ? result.failed : undefined,
              message: `Marked ${result.updated} of ${args.mail_ids.length} emails as ${action}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("mark_read_bulk failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleMarkFlagged(args: {
  mail_id: string;
  is_flagged: boolean;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    await getClient().markFlagged(args.mail_id, args.is_flagged);

    logger.tool(
      "mark_flagged",
      { mail_id: args.mail_id, is_flagged: args.is_flagged },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: `Email ${args.is_flagged ? "flagged" : "unflagged"}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("mark_flagged failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleMarkFlaggedBulk(args: {
  mail_ids: string[];
  is_flagged: boolean;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  // Validate bulk operation
  const validationError = validateBulkOperation(args.mail_ids, "mark_flagged_bulk");
  if (validationError) {
    logger.warn("mark_flagged_bulk called with insufficient IDs", { count: args.mail_ids?.length || 0 });
    return validationError;
  }

  try {
    const result = await getClient().updateEmailsBulk(args.mail_ids, { isFlagged: args.is_flagged });

    const action = args.is_flagged ? "flagged" : "unflagged";
    logger.tool(
      "mark_flagged_bulk",
      { count: args.mail_ids.length, is_flagged: args.is_flagged },
      Date.now() - startTime,
      result.updated
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: result.failed.length === 0,
              updated: result.updated,
              failed: result.failed.length,
              failedIds: result.failed.length > 0 ? result.failed : undefined,
              message: `Marked ${result.updated} of ${args.mail_ids.length} emails as ${action}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("mark_flagged_bulk failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleMarkSpam(args: {
  mail_id: string;
  is_spam: boolean;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    if (args.is_spam) {
      await getClient().markSpam(args.mail_id);
    } else {
      await getClient().markNotSpam(args.mail_id);
    }

    logger.tool(
      "mark_spam",
      { mail_id: args.mail_id, is_spam: args.is_spam },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: `Email marked as ${args.is_spam ? "spam" : "not spam"}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("mark_spam failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

// ==================== Folder Operations ====================

export async function handleCreateFolder(args: {
  name: string;
  type?: string;
  parent_id?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const result = await getClient().createFolder(args.name, args.type || "mails", args.parent_id);

    logger.tool(
      "create_folder",
      { name: args.name, type: args.type },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              folderId: result.id,
              message: `Folder "${args.name}" created`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("create_folder failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleDeleteFolder(args: {
  folder_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    await getClient().deleteFolder(args.folder_id);

    logger.tool("delete_folder", { folder_id: args.folder_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: `Folder deleted`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("delete_folder failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleRenameFolder(args: {
  folder_id: string;
  new_name: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    await getClient().renameFolder(args.folder_id, args.new_name);

    logger.tool(
      "rename_folder",
      { folder_id: args.folder_id, new_name: args.new_name },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: `Folder renamed to "${args.new_name}"`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("rename_folder failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

// ==================== Vacation ====================

export async function handleGetVacation(): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const vacation = await getClient().getVacation();

    logger.tool("get_vacation", {}, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(vacation, null, 2),
        },
      ],
    };
  } catch (error) {
    logger.error("get_vacation failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleSetVacation(args: {
  enabled: boolean;
  subject?: string;
  body?: string;
  start_date?: string;
  end_date?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    await getClient().setVacation({
      enabled: args.enabled,
      subject: args.subject,
      body: args.body,
      startDate: args.start_date,
      endDate: args.end_date,
    });

    logger.tool("set_vacation", { enabled: args.enabled }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: args.enabled
                ? "Vacation auto-reply enabled"
                : "Vacation auto-reply disabled",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("set_vacation failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

// ==================== Copy Email ====================

export async function handleCopyEmail(args: {
  mail_id: string;
  destination_folder_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const result = await getClient().copyEmail(args.mail_id, args.destination_folder_id);

    logger.tool(
      "copy_email",
      { mail_id: args.mail_id, destination_folder_id: args.destination_folder_id },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              newMailId: result.id,
              message: `Email copied to folder ${args.destination_folder_id}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("copy_email failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

// ==================== Labels ====================

export async function handleListLabels(): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const labels = await getClient().listLabels();

    logger.tool("list_labels", {}, Date.now() - startTime, labels.items?.length || 0);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: labels.items?.length || 0,
              labels: labels.items || [],
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("list_labels failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleCreateLabel(args: {
  name: string;
  color?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const result = await getClient().createLabel(args.name, args.color);

    logger.tool("create_label", { name: args.name }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              labelId: result.id,
              message: `Label "${args.name}" created`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("create_label failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleDeleteLabel(args: {
  label_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    await getClient().deleteLabel(args.label_id);

    logger.tool("delete_label", { label_id: args.label_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: "Label deleted",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("delete_label failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

// ==================== Scheduled Email & Undo ====================

export async function handleScheduleEmail(args: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html_body?: string;
  send_at: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const result = await getClient().scheduleEmail({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      body: args.body,
      htmlBody: args.html_body,
      sendAt: args.send_at,
    });

    logger.tool(
      "schedule_email",
      { to: args.to, subject: args.subject, send_at: args.send_at },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              mailId: result.mailId,
              processingId: result.processingId,
              message: `Email scheduled to be sent at ${args.send_at}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("schedule_email failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleUndoSend(args: {
  processing_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const result = await getClient().undoSend(args.processing_id);

    logger.tool("undo_send", { processing_id: args.processing_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: result.success,
              message: result.success
                ? "Email send cancelled successfully"
                : "Failed to cancel email send (may have already been sent)",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("undo_send failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}
