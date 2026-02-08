import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Re-export the SDK's CallToolResult as ToolResponse for convenience
export type ToolResponse = CallToolResult;

// Email tool schemas
export const listEmailsSchema = z.object({
  folder: z.string().default("INBOX").describe("Folder name (default: INBOX)"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum number of emails to return (default: 20)"),
  offset: z.number().min(0).default(0).describe("Offset for pagination"),
  unread_only: z
    .boolean()
    .default(false)
    .describe("Only return unread emails"),
});

export const getEmailSchema = z.object({
  message_id: z.string().describe("The unique message ID"),
});

export const searchEmailsSchema = z.object({
  query: z.string().optional().describe("Full-text search query"),
  from: z.string().optional().describe("Filter by sender email"),
  to: z.string().optional().describe("Filter by recipient email"),
  subject: z.string().optional().describe("Filter by subject"),
  date_from: z
    .string()
    .optional()
    .describe("Filter emails from this date (ISO 8601)"),
  date_to: z
    .string()
    .optional()
    .describe("Filter emails until this date (ISO 8601)"),
  folder: z.string().default("INBOX").describe("Folder to search in"),
  limit: z.number().min(1).max(100).default(20).describe("Maximum results"),
});

export const sendEmailSchema = z.object({
  to: z.array(z.string()).min(1).describe("Recipient email addresses"),
  cc: z.array(z.string()).optional().describe("CC recipients"),
  bcc: z.array(z.string()).optional().describe("BCC recipients"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Plain text body"),
  html_body: z.string().optional().describe("HTML body (optional)"),
});

export const replyEmailSchema = z.object({
  message_id: z.string().describe("The message ID to reply to"),
  body: z.string().describe("Reply body"),
  reply_all: z.boolean().default(false).describe("Reply to all recipients"),
});

export const forwardEmailSchema = z.object({
  message_id: z.string().describe("The message ID to forward"),
  to: z.array(z.string()).min(1).describe("Recipients to forward to"),
  body: z.string().optional().describe("Additional message"),
});

export const moveEmailSchema = z.object({
  message_id: z.string().describe("The message ID to move"),
  target_folder: z.string().describe("Target folder path"),
});

export const deleteEmailSchema = z.object({
  message_id: z.string().describe("The message ID to delete"),
});

export const markReadSchema = z.object({
  message_id: z.string().describe("The message ID"),
  read: z.boolean().describe("Mark as read (true) or unread (false)"),
});

// Calendar tool schemas
export const listEventsSchema = z.object({
  calendar_id: z.string().optional().describe("Calendar ID (default: primary)"),
  date_from: z.string().describe("Start date (ISO 8601)"),
  date_to: z.string().describe("End date (ISO 8601)"),
});

export const getEventSchema = z.object({
  event_id: z.string().describe("The event ID"),
  calendar_id: z.string().optional().describe("Calendar ID"),
});

export const createEventSchema = z.object({
  title: z.string().describe("Event title"),
  start: z.string().describe("Start datetime (ISO 8601)"),
  end: z.string().describe("End datetime (ISO 8601)"),
  location: z.string().optional().describe("Event location"),
  description: z.string().optional().describe("Event description"),
  attendees: z
    .array(z.string())
    .optional()
    .describe("Attendee email addresses"),
  calendar_id: z.string().optional().describe("Calendar ID"),
});

export const updateEventSchema = z.object({
  event_id: z.string().describe("The event ID to update"),
  title: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  calendar_id: z.string().optional(),
});

export const deleteEventSchema = z.object({
  event_id: z.string().describe("The event ID to delete"),
  calendar_id: z.string().optional(),
});

export const getFreeBusySchema = z.object({
  date_from: z.string().describe("Start date (ISO 8601)"),
  date_to: z.string().describe("End date (ISO 8601)"),
});

// Contact tool schemas
export const listContactsSchema = z.object({
  addressbook_id: z.string().optional().describe("Addressbook ID"),
  limit: z.number().min(1).max(500).default(100).describe("Maximum results"),
});

export const searchContactsSchema = z.object({
  query: z.string().optional().describe("Search query"),
  name: z.string().optional().describe("Filter by name"),
  email: z.string().optional().describe("Filter by email"),
  phone: z.string().optional().describe("Filter by phone"),
  limit: z.number().min(1).max(100).default(20).describe("Maximum results"),
});

export const getContactSchema = z.object({
  contact_id: z.string().describe("The contact ID"),
});

export const createContactSchema = z.object({
  name: z.string().describe("Display name"),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().optional().describe("Primary email"),
  phone: z.string().optional().describe("Primary phone"),
  organization: z.string().optional(),
  notes: z.string().optional(),
  addressbook_id: z.string().optional(),
});

export const updateContactSchema = z.object({
  contact_id: z.string().describe("The contact ID to update"),
  name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  organization: z.string().optional(),
  notes: z.string().optional(),
});

export const deleteContactSchema = z.object({
  contact_id: z.string().describe("The contact ID to delete"),
});

// Task tool schemas
export const listTasksSchema = z.object({
  list_id: z.string().optional().describe("Task list ID"),
  completed: z
    .boolean()
    .optional()
    .describe("Filter by completion status"),
});

export const createTaskSchema = z.object({
  title: z.string().describe("Task title"),
  description: z.string().optional(),
  due_date: z.string().optional().describe("Due date (ISO 8601)"),
  priority: z.number().min(1).max(9).optional().describe("Priority 1-9"),
  list_id: z.string().optional(),
});

export const updateTaskSchema = z.object({
  task_id: z.string().describe("The task ID to update"),
  title: z.string().optional(),
  description: z.string().optional(),
  due_date: z.string().optional(),
  priority: z.number().min(1).max(9).optional(),
});

export const completeTaskSchema = z.object({
  task_id: z.string().describe("The task ID to complete"),
});

export const deleteTaskSchema = z.object({
  task_id: z.string().describe("The task ID to delete"),
});

// Export type aliases
export type ListEmailsParams = z.infer<typeof listEmailsSchema>;
export type GetEmailParams = z.infer<typeof getEmailSchema>;
export type SearchEmailsParams = z.infer<typeof searchEmailsSchema>;
export type SendEmailParams = z.infer<typeof sendEmailSchema>;
export type ReplyEmailParams = z.infer<typeof replyEmailSchema>;
export type ForwardEmailParams = z.infer<typeof forwardEmailSchema>;
export type MoveEmailParams = z.infer<typeof moveEmailSchema>;
export type DeleteEmailParams = z.infer<typeof deleteEmailSchema>;
export type MarkReadParams = z.infer<typeof markReadSchema>;
