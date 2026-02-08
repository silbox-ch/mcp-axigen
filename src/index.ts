#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";

import { config, isOAuthEnabled, getAuthMode } from "./config.js";
import { logger } from "./utils/logger.js";

// OAuth/Auth imports
import oauthRouter from "./routes/oauth.js";
import mcpOauthRouter, { validateBearerToken, getWWWAuthenticateHeader } from "./routes/mcp-oauth.js";
import { startSessionCleanup, stopSessionCleanup, getSession, findSessionByEmail } from "./auth/sessions.js";
import express from "express";
import cookieParser from "cookie-parser";

// Request context for multi-user OAuth
import {
  runWithContext,
  associateMcpWithOAuthSession,
  getOAuthSessionForMcp,
  removeMcpSessionAssociation,
} from "./utils/request-context.js";

// Email tools
import {
  handleListFolders,
  handleListEmails,
  handleGetEmail,
  handleSearchEmails,
  handleSendEmail,
  handleReplyEmail,
  handleForwardEmail,
  handleMoveEmail,
  handleDeleteEmail,
  handleMarkRead,
  handleDeleteEmailsBulk,
  handleMoveEmailsBulk,
  handleMarkReadBulk,
  handleMarkFlagged,
  handleMarkFlaggedBulk,
  handleMarkSpam,
  handleCreateFolder,
  handleDeleteFolder,
  handleRenameFolder,
  handleGetVacation,
  handleSetVacation,
  handleCopyEmail,
  handleListLabels,
  handleCreateLabel,
  handleDeleteLabel,
  handleScheduleEmail,
  handleUndoSend,
} from "./tools/emails.js";

// Calendar tools
import {
  handleListCalendars,
  handleListEvents,
  handleGetEvent,
  handleCreateEvent,
  handleUpdateEvent,
  handleDeleteEvent,
  handleGetFreeBusy,
} from "./tools/calendar.js";

// Contact tools
import {
  handleListAddressBooks,
  handleListContacts,
  handleSearchContacts,
  handleGetContact,
  handleCreateContact,
  handleUpdateContact,
  handleDeleteContact,
} from "./tools/contacts.js";

// Task tools
import {
  handleListTaskLists,
  handleListTasks,
  handleCreateTask,
  handleUpdateTask,
  handleCompleteTask,
  handleDeleteTask,
} from "./tools/tasks.js";

// Note tools
import {
  handleListNotes,
  handleGetNote,
  handleSearchNotes,
  handleCreateNote,
  handleUpdateNote,
  handleDeleteNote,
} from "./tools/notes.js";

// Server icon URL (served by Caddy at same domain)
const SERVER_ICON_URL = config.server.publicUrl
  ? `${config.server.publicUrl.replace(/\/mcp$/, "")}/icon.svg`
  : undefined;

// Create MCP server with icon
const server = new Server(
  {
    name: config.server.name,
    version: config.server.version,
    ...(SERVER_ICON_URL && {
      icons: [
        {
          src: SERVER_ICON_URL,
          mimeType: "image/svg+xml",
          sizes: ["any"],
        },
      ],
    }),
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define all available tools
const tools = [
  // ==================== Server Info Tool ====================
  {
    name: "get_server_info",
    description: "Get MCP server information including version, name, and capabilities. Use this to check which version of the server is running.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // ==================== Email Tools ====================
  {
    name: "list_folders",
    description: "List all email folders/mailboxes",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_emails",
    description:
      "List emails from a folder. Returns subject, from, date, and read status. Use list_folders first to get folder IDs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        folder_id: {
          type: "string",
          description: "Folder ID (use list_folders to get IDs). Example: 414_1879 for Inbox",
        },
        limit: {
          type: "number",
          description: "Maximum number of emails to return (default: 20)",
          default: 20,
        },
        start: {
          type: "number",
          description: "Start index for pagination (default: 0)",
          default: 0,
        },
      },
      required: ["folder_id"],
    },
  },
  {
    name: "get_email",
    description: "Get full email content including body and attachments info",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_id: {
          type: "string",
          description: "The unique mail ID",
        },
        include_body: {
          type: "boolean",
          description: "Include email body content (default: false)",
          default: false,
        },
      },
      required: ["mail_id"],
    },
  },
  {
    name: "search_emails",
    description:
      "Search emails with advanced filters. For bulk delete/move, use ids_only=true. Supports size filters (larger_than/smaller_than) for finding large emails to clean up.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Full-text search (searches all fields)",
        },
        from: {
          type: "string",
          description: "Filter by sender",
        },
        to: {
          type: "string",
          description: "Filter by recipient",
        },
        cc: {
          type: "string",
          description: "Filter by CC recipient",
        },
        bcc: {
          type: "string",
          description: "Filter by BCC recipient",
        },
        subject: {
          type: "string",
          description: "Filter by subject",
        },
        body: {
          type: "string",
          description: "Search in body only (not headers)",
        },
        date_from: {
          type: "string",
          description: "Emails after this date (ISO 8601)",
        },
        date_to: {
          type: "string",
          description: "Emails before this date (ISO 8601)",
        },
        smaller_than: {
          type: "string",
          description: "Size filter: emails smaller than value. Use '5M', '500K', or bytes",
        },
        larger_than: {
          type: "string",
          description: "Size filter: emails larger than value. Use '5M', '500K', or bytes. Great for finding large emails to clean up!",
        },
        folder_id: {
          type: "string",
          description: "Folder ID to search in (default: INBOX)",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 50)",
          default: 50,
        },
        is_unread: {
          type: "boolean",
          description: "true = unread only, false = read only, omit = all",
        },
        is_flagged: {
          type: "boolean",
          description: "true = starred/flagged only, false = not flagged, omit = all",
        },
        importance: {
          type: "string",
          enum: ["high", "normal", "low"],
          description: "Filter by priority/importance level",
        },
        has_attachment: {
          type: "boolean",
          description: "true = has attachments only",
        },
        label: {
          type: "string",
          description: "Filter by label ID (use list_labels to get IDs)",
        },
        ids_only: {
          type: "boolean",
          description:
            "Returns only IDs for bulk operations (delete_emails_bulk, move_emails_bulk)",
          default: false,
        },
      },
    },
  },
  {
    name: "send_email",
    description: "Send a new email",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "Recipient email addresses",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "CC recipients",
        },
        bcc: {
          type: "array",
          items: { type: "string" },
          description: "BCC recipients",
        },
        subject: {
          type: "string",
          description: "Email subject",
        },
        body: {
          type: "string",
          description: "Plain text body",
        },
        html_body: {
          type: "string",
          description: "HTML body (optional)",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "reply_email",
    description: "Reply to an email",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_id: {
          type: "string",
          description: "The mail ID to reply to",
        },
        body: {
          type: "string",
          description: "Reply body",
        },
        reply_all: {
          type: "boolean",
          description: "Reply to all recipients",
          default: false,
        },
      },
      required: ["mail_id", "body"],
    },
  },
  {
    name: "forward_email",
    description: "Forward an email",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_id: {
          type: "string",
          description: "The mail ID to forward",
        },
        to: {
          type: "array",
          items: { type: "string" },
          description: "Recipients to forward to",
        },
        body: {
          type: "string",
          description: "Additional message",
        },
      },
      required: ["mail_id", "to"],
    },
  },
  {
    name: "move_email",
    description: "Move an email to another folder",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_id: {
          type: "string",
          description: "The mail ID to move",
        },
        destination_folder_id: {
          type: "string",
          description: "Target folder ID",
        },
      },
      required: ["mail_id", "destination_folder_id"],
    },
  },
  {
    name: "delete_email",
    description: "Delete an email",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_id: {
          type: "string",
          description: "The mail ID to delete",
        },
      },
      required: ["mail_id"],
    },
  },
  {
    name: "mark_read",
    description: "Mark an email as read or unread",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_id: {
          type: "string",
          description: "The mail ID",
        },
        is_unread: {
          type: "boolean",
          description: "Mark as unread (true) or read (false)",
        },
      },
      required: ["mail_id", "is_unread"],
    },
  },

  // ==================== Bulk Email Operations ====================
  {
    name: "delete_emails_bulk",
    description:
      "Delete multiple emails. FIRST call search_emails with ids_only=true, THEN pass the returned mail_ids array directly here. Never build the array manually.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_ids: {
          type: "array",
          items: { type: "string" },
          description: "The mail_ids array from search_emails ids_only=true response. Copy it directly, don't rebuild it.",
        },
      },
      required: ["mail_ids"],
    },
  },
  {
    name: "move_emails_bulk",
    description:
      "Move multiple emails. FIRST call search_emails with ids_only=true, THEN pass the returned mail_ids array directly here. Never build the array manually.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_ids: {
          type: "array",
          items: { type: "string" },
          description: "The mail_ids array from search_emails ids_only=true response. Copy it directly, don't rebuild it.",
        },
        destination_folder_id: {
          type: "string",
          description: "Target folder ID",
        },
      },
      required: ["mail_ids", "destination_folder_id"],
    },
  },
  {
    name: "mark_read_bulk",
    description:
      "Mark multiple emails read/unread. FIRST call search_emails with ids_only=true, THEN pass the returned mail_ids array directly here.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_ids: {
          type: "array",
          items: { type: "string" },
          description: "The mail_ids array from search_emails ids_only=true response.",
        },
        is_unread: {
          type: "boolean",
          description: "Mark as unread (true) or read (false)",
        },
      },
      required: ["mail_ids", "is_unread"],
    },
  },
  {
    name: "mark_flagged",
    description: "Mark an email as flagged/starred or unflagged",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_id: {
          type: "string",
          description: "The mail ID",
        },
        is_flagged: {
          type: "boolean",
          description: "Mark as flagged (true) or unflagged (false)",
        },
      },
      required: ["mail_id", "is_flagged"],
    },
  },
  {
    name: "mark_flagged_bulk",
    description:
      "Mark multiple emails flagged/unflagged. FIRST call search_emails with ids_only=true, THEN pass the returned mail_ids array directly here.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_ids: {
          type: "array",
          items: { type: "string" },
          description: "The mail_ids array from search_emails ids_only=true response.",
        },
        is_flagged: {
          type: "boolean",
          description: "Mark as flagged (true) or unflagged (false)",
        },
      },
      required: ["mail_ids", "is_flagged"],
    },
  },
  {
    name: "mark_spam",
    description: "Mark an email as spam or not spam. Spam emails are moved to Junk folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_id: {
          type: "string",
          description: "The mail ID",
        },
        is_spam: {
          type: "boolean",
          description: "Mark as spam (true) or not spam (false)",
        },
      },
      required: ["mail_id", "is_spam"],
    },
  },

  // ==================== Folder Management ====================
  {
    name: "create_folder",
    description: "Create a new email folder",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Folder name",
        },
        type: {
          type: "string",
          description: "Folder type: mails, contacts, events, tasks, notes (default: mails)",
          default: "mails",
        },
        parent_id: {
          type: "string",
          description: "Parent folder ID for nested folders (optional)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_folder",
    description: "Delete an email folder. Cannot delete system folders (inbox, sent, trash, etc.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        folder_id: {
          type: "string",
          description: "The folder ID to delete",
        },
      },
      required: ["folder_id"],
    },
  },
  {
    name: "rename_folder",
    description: "Rename an email folder",
    inputSchema: {
      type: "object" as const,
      properties: {
        folder_id: {
          type: "string",
          description: "The folder ID to rename",
        },
        new_name: {
          type: "string",
          description: "New folder name",
        },
      },
      required: ["folder_id", "new_name"],
    },
  },

  // ==================== Vacation Auto-Reply ====================
  {
    name: "get_vacation",
    description: "Get current vacation auto-reply settings",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "set_vacation",
    description: "Configure vacation auto-reply (out of office message)",
    inputSchema: {
      type: "object" as const,
      properties: {
        enabled: {
          type: "boolean",
          description: "Enable or disable vacation auto-reply",
        },
        subject: {
          type: "string",
          description: "Auto-reply email subject",
        },
        body: {
          type: "string",
          description: "Auto-reply message body",
        },
        start_date: {
          type: "string",
          description: "Start date (ISO 8601, optional)",
        },
        end_date: {
          type: "string",
          description: "End date (ISO 8601, optional)",
        },
      },
      required: ["enabled"],
    },
  },

  // ==================== Copy Email ====================
  {
    name: "copy_email",
    description: "Copy an email to another folder (keeps original)",
    inputSchema: {
      type: "object" as const,
      properties: {
        mail_id: {
          type: "string",
          description: "The mail ID to copy",
        },
        destination_folder_id: {
          type: "string",
          description: "Target folder ID",
        },
      },
      required: ["mail_id", "destination_folder_id"],
    },
  },

  // ==================== Labels ====================
  {
    name: "list_labels",
    description: "List all email labels/tags",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "create_label",
    description: "Create a new email label/tag",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Label name",
        },
        color: {
          type: "string",
          description: "Label color (hex code, optional)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_label",
    description: "Delete an email label/tag",
    inputSchema: {
      type: "object" as const,
      properties: {
        label_id: {
          type: "string",
          description: "The label ID to delete",
        },
      },
      required: ["label_id"],
    },
  },

  // ==================== Scheduled Email & Undo ====================
  {
    name: "schedule_email",
    description: "Schedule an email to be sent at a specific time",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "Recipient email addresses",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "CC recipients",
        },
        bcc: {
          type: "array",
          items: { type: "string" },
          description: "BCC recipients",
        },
        subject: {
          type: "string",
          description: "Email subject",
        },
        body: {
          type: "string",
          description: "Plain text body",
        },
        html_body: {
          type: "string",
          description: "HTML body (optional)",
        },
        send_at: {
          type: "string",
          description: "When to send the email (ISO 8601 datetime)",
        },
      },
      required: ["to", "subject", "body", "send_at"],
    },
  },
  {
    name: "undo_send",
    description: "Cancel a recently sent email (within ~10 seconds of sending). Requires the processingId from send_email or schedule_email response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        processing_id: {
          type: "string",
          description: "The processingId returned from send_email or schedule_email",
        },
      },
      required: ["processing_id"],
    },
  },

  // ==================== Calendar Tools ====================
  {
    name: "list_calendars",
    description: "List all calendars",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_events",
    description: "List calendar events within a date range",
    inputSchema: {
      type: "object" as const,
      properties: {
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: primary)",
        },
        date_from: {
          type: "string",
          description: "Start date (ISO 8601)",
        },
        date_to: {
          type: "string",
          description: "End date (ISO 8601)",
        },
      },
      required: ["date_from", "date_to"],
    },
  },
  {
    name: "get_event",
    description: "Get full details of a calendar event",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_id: {
          type: "string",
          description: "The event ID",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID",
        },
      },
      required: ["event_id"],
    },
  },
  {
    name: "create_event",
    description: "Create a new calendar event",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Event title",
        },
        start: {
          type: "string",
          description: "Start datetime (ISO 8601)",
        },
        end: {
          type: "string",
          description: "End datetime (ISO 8601)",
        },
        location: {
          type: "string",
          description: "Event location",
        },
        description: {
          type: "string",
          description: "Event description",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Attendee email addresses",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID",
        },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "update_event",
    description: "Update an existing calendar event",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_id: {
          type: "string",
          description: "The event ID to update",
        },
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        location: { type: "string" },
        description: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
        calendar_id: { type: "string" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "delete_event",
    description: "Delete a calendar event",
    inputSchema: {
      type: "object" as const,
      properties: {
        event_id: {
          type: "string",
          description: "The event ID to delete",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID",
        },
      },
      required: ["event_id"],
    },
  },
  {
    name: "get_freebusy",
    description: "Get free/busy information for scheduling",
    inputSchema: {
      type: "object" as const,
      properties: {
        date_from: {
          type: "string",
          description: "Start date (ISO 8601)",
        },
        date_to: {
          type: "string",
          description: "End date (ISO 8601)",
        },
      },
      required: ["date_from", "date_to"],
    },
  },

  // ==================== Contact Tools ====================
  {
    name: "list_addressbooks",
    description: "List all address books",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_contacts",
    description: "List contacts from an address book",
    inputSchema: {
      type: "object" as const,
      properties: {
        addressbook_id: {
          type: "string",
          description: "Addressbook ID",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 100)",
          default: 100,
        },
      },
    },
  },
  {
    name: "search_contacts",
    description: "Search for contacts by name, email, or phone",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        name: {
          type: "string",
          description: "Filter by name",
        },
        email: {
          type: "string",
          description: "Filter by email",
        },
        phone: {
          type: "string",
          description: "Filter by phone",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 20)",
          default: 20,
        },
      },
    },
  },
  {
    name: "get_contact",
    description: "Get full contact details",
    inputSchema: {
      type: "object" as const,
      properties: {
        contact_id: {
          type: "string",
          description: "The contact ID",
        },
      },
      required: ["contact_id"],
    },
  },
  {
    name: "create_contact",
    description: "Create a new contact",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Display name",
        },
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: {
          type: "string",
          description: "Primary email",
        },
        phone: {
          type: "string",
          description: "Primary phone",
        },
        organization: { type: "string" },
        notes: { type: "string" },
        addressbook_id: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_contact",
    description: "Update an existing contact",
    inputSchema: {
      type: "object" as const,
      properties: {
        contact_id: {
          type: "string",
          description: "The contact ID to update",
        },
        name: { type: "string" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        organization: { type: "string" },
        notes: { type: "string" },
      },
      required: ["contact_id"],
    },
  },
  {
    name: "delete_contact",
    description: "Delete a contact",
    inputSchema: {
      type: "object" as const,
      properties: {
        contact_id: {
          type: "string",
          description: "The contact ID to delete",
        },
      },
      required: ["contact_id"],
    },
  },

  // ==================== Task Tools ====================
  {
    name: "list_task_lists",
    description: "List all task lists",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_tasks",
    description: "List tasks from a task list",
    inputSchema: {
      type: "object" as const,
      properties: {
        list_id: {
          type: "string",
          description: "Task list ID",
        },
        completed: {
          type: "boolean",
          description: "Filter by completion status",
        },
      },
    },
  },
  {
    name: "create_task",
    description: "Create a new task with optional location, category, status, progress and assignee",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Task title",
        },
        description: { type: "string", description: "Task description/notes" },
        due_date: {
          type: "string",
          description: "Due date (YYYY-MM-DD format)",
        },
        priority: {
          type: "number",
          description: "Priority 0-9 (1=highest, 0=undefined)",
        },
        list_id: { type: "string", description: "Task list ID (optional, defaults to Tasks)" },
        location: { type: "string", description: "Location/address" },
        category: { type: "string", description: "Category/tag (e.g., 'Phone Call', 'Business', 'Personal')" },
        status: {
          type: "string",
          enum: ["needs-action", "in-process", "completed"],
          description: "Task status",
        },
        percent_complete: {
          type: "number",
          description: "Completion percentage (0-100)",
        },
        assignee: {
          type: "string",
          description: "Email of person assigned to the task",
        },
        is_private: {
          type: "boolean",
          description: "Mark task as private (only visible to you)",
        },
        reminder: {
          type: "string",
          description: "Reminder datetime (ISO 8601, e.g., 2026-01-29T08:00:00)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description: "Update an existing task",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "The task ID to update",
        },
        title: { type: "string" },
        description: { type: "string" },
        due_date: { type: "string" },
        priority: { type: "number" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "The task ID to complete",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "delete_task",
    description: "Delete a task",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "The task ID to delete",
        },
      },
      required: ["task_id"],
    },
  },

  // ==================== Note Tools ====================
  {
    name: "list_notes",
    description: "List all notes",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of notes to return (default: 50)",
        },
      },
    },
  },
  {
    name: "get_note",
    description: "Get a note with full content",
    inputSchema: {
      type: "object" as const,
      properties: {
        note_id: {
          type: "string",
          description: "The note ID",
        },
      },
      required: ["note_id"],
    },
  },
  {
    name: "search_notes",
    description: "Search notes by text content",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (searches title and content)",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 20)",
        },
      },
    },
  },
  {
    name: "create_note",
    description: "Create a new note",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Note title",
        },
        content: {
          type: "string",
          description: "Note content (plain text)",
        },
        html_content: {
          type: "string",
          description: "Optional HTML content",
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "update_note",
    description: "Update an existing note",
    inputSchema: {
      type: "object" as const,
      properties: {
        note_id: {
          type: "string",
          description: "The note ID to update",
        },
        title: {
          type: "string",
          description: "New title (optional)",
        },
        content: {
          type: "string",
          description: "New content (optional)",
        },
      },
      required: ["note_id"],
    },
  },
  {
    name: "delete_note",
    description: "Delete a note",
    inputSchema: {
      type: "object" as const,
      properties: {
        note_id: {
          type: "string",
          description: "The note ID to delete",
        },
      },
      required: ["note_id"],
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.debug(`Tool call: ${name}`, { args });

  switch (name) {
    // Server info tool
    case "get_server_info":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                name: config.server.name,
                version: config.server.version,
                mode: config.server.mode,
                authMode: getAuthMode(),
                publicUrl: config.server.publicUrl,
                iconUrl: SERVER_ICON_URL,
                toolCount: tools.length,
                protocolVersion: "2025-11-25",
              },
              null,
              2
            ),
          },
        ],
      };

    // Email tools
    case "list_folders":
      return await handleListFolders();
    case "list_emails":
      return await handleListEmails(args as Parameters<typeof handleListEmails>[0]);
    case "get_email":
      return await handleGetEmail(args as Parameters<typeof handleGetEmail>[0]);
    case "search_emails":
      return await handleSearchEmails(args as Parameters<typeof handleSearchEmails>[0]);
    case "send_email":
      return await handleSendEmail(args as Parameters<typeof handleSendEmail>[0]);
    case "reply_email":
      return await handleReplyEmail(args as Parameters<typeof handleReplyEmail>[0]);
    case "forward_email":
      return await handleForwardEmail(args as Parameters<typeof handleForwardEmail>[0]);
    case "move_email":
      return await handleMoveEmail(args as Parameters<typeof handleMoveEmail>[0]);
    case "delete_email":
      return await handleDeleteEmail(args as Parameters<typeof handleDeleteEmail>[0]);
    case "mark_read":
      return await handleMarkRead(args as Parameters<typeof handleMarkRead>[0]);

    // Bulk email operations
    case "delete_emails_bulk":
      return await handleDeleteEmailsBulk(args as Parameters<typeof handleDeleteEmailsBulk>[0]);
    case "move_emails_bulk":
      return await handleMoveEmailsBulk(args as Parameters<typeof handleMoveEmailsBulk>[0]);
    case "mark_read_bulk":
      return await handleMarkReadBulk(args as Parameters<typeof handleMarkReadBulk>[0]);
    case "mark_flagged":
      return await handleMarkFlagged(args as Parameters<typeof handleMarkFlagged>[0]);
    case "mark_flagged_bulk":
      return await handleMarkFlaggedBulk(args as Parameters<typeof handleMarkFlaggedBulk>[0]);
    case "mark_spam":
      return await handleMarkSpam(args as Parameters<typeof handleMarkSpam>[0]);

    // Folder management
    case "create_folder":
      return await handleCreateFolder(args as Parameters<typeof handleCreateFolder>[0]);
    case "delete_folder":
      return await handleDeleteFolder(args as Parameters<typeof handleDeleteFolder>[0]);
    case "rename_folder":
      return await handleRenameFolder(args as Parameters<typeof handleRenameFolder>[0]);

    // Vacation
    case "get_vacation":
      return await handleGetVacation();
    case "set_vacation":
      return await handleSetVacation(args as Parameters<typeof handleSetVacation>[0]);

    // Copy email
    case "copy_email":
      return await handleCopyEmail(args as Parameters<typeof handleCopyEmail>[0]);

    // Labels
    case "list_labels":
      return await handleListLabels();
    case "create_label":
      return await handleCreateLabel(args as Parameters<typeof handleCreateLabel>[0]);
    case "delete_label":
      return await handleDeleteLabel(args as Parameters<typeof handleDeleteLabel>[0]);

    // Scheduled email & undo
    case "schedule_email":
      return await handleScheduleEmail(args as Parameters<typeof handleScheduleEmail>[0]);
    case "undo_send":
      return await handleUndoSend(args as Parameters<typeof handleUndoSend>[0]);

    // Calendar tools
    case "list_calendars":
      return await handleListCalendars();
    case "list_events":
      return await handleListEvents(args as Parameters<typeof handleListEvents>[0]);
    case "get_event":
      return await handleGetEvent(args as Parameters<typeof handleGetEvent>[0]);
    case "create_event":
      return await handleCreateEvent(args as Parameters<typeof handleCreateEvent>[0]);
    case "update_event":
      return await handleUpdateEvent(args as Parameters<typeof handleUpdateEvent>[0]);
    case "delete_event":
      return await handleDeleteEvent(args as Parameters<typeof handleDeleteEvent>[0]);
    case "get_freebusy":
      return await handleGetFreeBusy(args as Parameters<typeof handleGetFreeBusy>[0]);

    // Contact tools
    case "list_addressbooks":
      return await handleListAddressBooks();
    case "list_contacts":
      return await handleListContacts(args as Parameters<typeof handleListContacts>[0]);
    case "search_contacts":
      return await handleSearchContacts(args as Parameters<typeof handleSearchContacts>[0]);
    case "get_contact":
      return await handleGetContact(args as Parameters<typeof handleGetContact>[0]);
    case "create_contact":
      return await handleCreateContact(args as Parameters<typeof handleCreateContact>[0]);
    case "update_contact":
      return await handleUpdateContact(args as Parameters<typeof handleUpdateContact>[0]);
    case "delete_contact":
      return await handleDeleteContact(args as Parameters<typeof handleDeleteContact>[0]);

    // Task tools
    case "list_task_lists":
      return await handleListTaskLists();
    case "list_tasks":
      return await handleListTasks(args as Parameters<typeof handleListTasks>[0]);
    case "create_task":
      return await handleCreateTask(args as Parameters<typeof handleCreateTask>[0]);
    case "update_task":
      return await handleUpdateTask(args as Parameters<typeof handleUpdateTask>[0]);
    case "complete_task":
      return await handleCompleteTask(args as Parameters<typeof handleCompleteTask>[0]);
    case "delete_task":
      return await handleDeleteTask(args as Parameters<typeof handleDeleteTask>[0]);

    // Note tools
    case "list_notes":
      return await handleListNotes(args as Parameters<typeof handleListNotes>[0]);
    case "get_note":
      return await handleGetNote(args as Parameters<typeof handleGetNote>[0]);
    case "search_notes":
      return await handleSearchNotes(args as Parameters<typeof handleSearchNotes>[0]);
    case "create_note":
      return await handleCreateNote(args as Parameters<typeof handleCreateNote>[0]);
    case "update_note":
      return await handleUpdateNote(args as Parameters<typeof handleUpdateNote>[0]);
    case "delete_note":
      return await handleDeleteNote(args as Parameters<typeof handleDeleteNote>[0]);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start server
async function main() {
  const mode = config.server.mode;

  logger.info(`Starting ${config.server.name} v${config.server.version} in ${mode} mode`);

  if (mode === "sse") {
    // ═══════════════════════════════════════════════
    // MODE SSE - Pour claude.ai / ChatGPT / Gemini web
    // Uses new Streamable HTTP transport (MCP 2025-06-18)
    // Based on official SDK example: simpleStreamableHttp.ts
    // ═══════════════════════════════════════════════
    const app = createMcpExpressApp({ host: "0.0.0.0" });
    const port = config.server.port;

    // Store active transports by session ID
    const transports: Record<string, StreamableHTTPServerTransport> = {};

    // Add body parser for OAuth routes (urlencoded for form posts)
    app.use(express.urlencoded({ extended: true }));

    // Add cookie parser for OAuth session cookies
    app.use(cookieParser());

    // MCP OAuth 2.0 routes (for Claude.ai integration)
    // These are mounted at the root level as per MCP spec
    app.use(mcpOauthRouter);
    logger.info("MCP OAuth 2.0 endpoints enabled at /authorize, /token, /.well-known/oauth-authorization-server");

    // Legacy OAuth routes (for direct web-based login)
    if (isOAuthEnabled()) {
      app.use("/oauth", oauthRouter);
      logger.info("Legacy OAuth/OIDC routes enabled at /oauth/*");
    }

    // Start session cleanup
    startSessionCleanup();

    // Health check endpoint
    app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        mode: "sse",
        authMode: getAuthMode(),
        oauthEnabled: isOAuthEnabled(),
        server: config.server.name,
        version: config.server.version,
      });
    });

    // MCP POST endpoint - handles JSON-RPC requests
    app.post("/mcp", async (req: Request, res: Response) => {
      const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;

      // Extract OAuth session ID from multiple sources (in priority order):
      // 1. Bearer token (MCP OAuth 2.0 spec - from /authorize /token flow)
      // 2. x-oauth-session-id header (legacy)
      // 3. oauth_session cookie (legacy web-based login)
      let oauthSessionId: string | undefined;

      // Check for Bearer token first (MCP OAuth 2.0)
      const bearerToken = validateBearerToken(req.headers.authorization as string);
      if (bearerToken) {
        // Find or create session for this user
        const existingSession = findSessionByEmail(bearerToken.email);
        oauthSessionId = existingSession?.id;
        logger.debug(`Bearer token valid for user ${bearerToken.email}, session: ${oauthSessionId || "will create"}`);
      }

      // Fallback to legacy methods
      if (!oauthSessionId) {
        oauthSessionId = (req.headers["x-oauth-session-id"] as string | undefined) ||
          (req.cookies?.["oauth_session"] as string | undefined);
      }

      // MCP Nov 2025 spec: Return 401 with WWW-Authenticate if no valid auth
      // Single-user credentials in .env provide a fallback but we still
      // send the 401 challenge on initialize requests to allow OAuth flow
      const hasSingleUserCredentials = config.axigen.username && config.axigen.password;
      const hasOAuthAuth = bearerToken || oauthSessionId;

      // For initialize requests without OAuth auth, send 401 challenge
      // This allows Claude.ai to discover OAuth is available
      // Single-user mode will still work after the MCP session is established
      if (!hasOAuthAuth && isInitializeRequest(req.body) && !mcpSessionId) {
        logger.info("MCP initialize request without OAuth auth, returning 401 challenge");
        res.setHeader("WWW-Authenticate", getWWWAuthenticateHeader());
        res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Unauthorized: Authentication required. Use OAuth flow or provide Bearer token.",
          },
          id: (req.body as { id?: unknown })?.id || null,
        });
        return;
      }

      logger.debug(`POST /mcp - mcpSessionId: ${mcpSessionId || "none"}, oauthSessionId: ${oauthSessionId || "none"}, bearer: ${bearerToken ? "valid" : "none"}, singleUser: ${hasSingleUserCredentials}, body: ${JSON.stringify(req.body)}`);

      try {
        let transport: StreamableHTTPServerTransport;

        if (mcpSessionId && transports[mcpSessionId]) {
          // Reuse existing transport
          transport = transports[mcpSessionId];
        } else if (!mcpSessionId && isInitializeRequest(req.body)) {
          // New initialization request
          const eventStore = new InMemoryEventStore();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore, // Enable resumability
            onsessioninitialized: (sid: string) => {
              // Store the transport when session is initialized
              logger.info(`Session initialized: ${sid}`);
              transports[sid] = transport;

              // Associate OAuth session with MCP session (if OAuth is enabled and session provided)
              if (isOAuthEnabled() && oauthSessionId) {
                const session = getSession(oauthSessionId);
                if (session) {
                  associateMcpWithOAuthSession(sid, oauthSessionId);
                  logger.info(`Associated MCP session ${sid} with OAuth session ${oauthSessionId} (user: ${session.email})`);
                } else {
                  logger.warn(`OAuth session ${oauthSessionId} not found, MCP session will use single-user mode`);
                }
              }
            },
          });

          // Set up onclose handler for cleanup
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              logger.info(`Session closed: ${sid}`);
              removeMcpSessionAssociation(sid);
              delete transports[sid];
            }
          };

          // Connect transport to MCP server BEFORE handling request
          await server.connect(transport);
          // Run with OAuth context for initialization
          await runWithContext({ oauthSessionId, mcpSessionId: transport.sessionId }, async () => {
            await transport.handleRequest(req, res, req.body);
          });
          return; // Already handled
        } else {
          // Invalid request - no session ID or not initialization request
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided",
            },
            id: null,
          });
          return;
        }

        // Get OAuth session associated with this MCP session
        const associatedOAuthSession = getOAuthSessionForMcp(mcpSessionId) || oauthSessionId;

        // Handle request with existing transport, wrapped in OAuth context
        await runWithContext({ oauthSessionId: associatedOAuthSession, mcpSessionId }, async () => {
          await transport.handleRequest(req, res, req.body);
        });
      } catch (error) {
        logger.error("Error handling MCP POST request", { error: String(error) });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    });

    // MCP GET endpoint - handles SSE streams
    app.get("/mcp", async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      const lastEventId = req.headers["last-event-id"];
      if (lastEventId) {
        logger.info(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
      } else {
        logger.info(`SSE stream established for session ${sessionId}`);
      }

      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    });

    // MCP DELETE endpoint - handles session termination
    app.delete("/mcp", async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      logger.info(`Session termination requested: ${sessionId}`);

      try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
      } catch (error) {
        logger.error("Error handling session termination", { error: String(error) });
        if (!res.headersSent) {
          res.status(500).send("Error processing session termination");
        }
      }
    });

    app.listen(port, () => {
      logger.info(`MCP Server (Streamable HTTP) listening on port ${port}`);
      if (config.server.publicUrl) {
        logger.info(`Public URL for claude.ai: ${config.server.publicUrl}/mcp`);
      }
    });

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      logger.info("Shutting down server...");

      // Stop OAuth session cleanup
      if (isOAuthEnabled()) {
        stopSessionCleanup();
      }

      for (const sessionId in transports) {
        try {
          logger.info(`Closing session ${sessionId}`);
          await transports[sessionId].close();
          delete transports[sessionId];
        } catch (error) {
          logger.error(`Error closing session ${sessionId}`, { error: String(error) });
        }
      }
      process.exit(0);
    });
  } else {
    // ═══════════════════════════════════════════════
    // MODE STDIO - Pour Claude Desktop / local
    // ═══════════════════════════════════════════════
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("MCP server connected and ready (stdio mode)");
  }
}

main().catch((error) => {
  logger.error("Failed to start server", { error: String(error) });
  process.exit(1);
});
