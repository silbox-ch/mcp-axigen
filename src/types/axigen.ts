// Email types (matching Axigen API response)
export interface Email {
  id: string;
  subject: string;
  from: string; // Axigen returns string format "Name <email>"
  to?: string;
  cc?: string;
  bcc?: string;
  date: string;
  isUnread?: boolean;
  isFlagged?: boolean;
  hasAttachments?: boolean;
  attachments?: Attachment[];
  body?: string;
  htmlBody?: string;
  folderId?: string;
  size?: number;
  importance?: "normal" | "low" | "high";
}

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  isInline?: boolean;
}

// Folder types (matching Axigen API response)
export interface EmailFolder {
  id: string;
  name: string;
  parentId?: string;
  folderType: string;
  folderSize: number;
  totalItems: number;
  unreadItems: number;
  role?: "inbox" | "drafts" | "sent" | "trash" | "spam" | "junk" | string;
  accessMode?: string;
  permissions?: string[];
}

export interface SendEmailParams {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  attachments?: Array<{
    filename: string;
    content: string; // base64
    mimeType: string;
  }>;
}

export interface SearchEmailParams {
  // Text search fields
  query?: string;         // Full-text search (anyfield)
  from?: string;          // Sender contains
  to?: string;            // Recipient contains
  cc?: string;            // CC contains
  bcc?: string;           // BCC contains
  subject?: string;       // Subject contains
  body?: string;          // Body only (not headers)

  // Date filters
  dateFrom?: string;      // After date (ISO format)
  dateTo?: string;        // Before date (ISO format)

  // Size filters (in bytes, or string like "5M", "500K")
  smallerThan?: number | string;  // Size < value
  largerThan?: number | string;   // Size > value

  // Status filters
  isUnread?: boolean;     // true = unread, false = read
  isFlagged?: boolean;    // true = flag=followup, false = negate
  importance?: "high" | "normal" | "low";  // Priority filter

  // Other filters
  hasAttachment?: boolean; // Has attachment filter
  label?: string;         // Label ID filter

  // Options
  folder?: string;        // Folder ID (required for REST)
  limit?: number;         // Max results
  recursive?: boolean;    // Search subfolders
}

// Calendar types
export interface CalendarEvent {
  id: string;
  uid: string;
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees?: Attendee[];
  recurrence?: string;
  calendarId: string;
}

export interface Attendee {
  email: string;
  name?: string;
  status?: "accepted" | "declined" | "tentative" | "needs-action";
}

export interface Calendar {
  id: string;
  name: string;
  color?: string;
  description?: string;
}

// Contact types (Axigen REST API format)
export interface Contact {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  organization?: string;
  nickName?: string;
  reversedName?: string;
  folderId?: string;
  isDistributionList?: boolean;
  notes?: string;
}

export interface AddressBook {
  id: string;
  name: string;
  description?: string;
}

// Task types
export interface Task {
  id: string;
  uid: string;
  title: string;
  description?: string;
  dueDate?: string;
  startDate?: string; // [v2.1.1] DTSTART
  priority?: number;
  completed: boolean;
  completedDate?: string;
  listId: string;
  location?: string; // [v2.1.1] LOCATION
  categories?: string[]; // [v2.1.1] CATEGORIES (labels/tags)
  status?: 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED';
  percentComplete?: number;  // 0=inbox, 25=todo, 50=doing, 75=waiting, 100=done
}

export interface TaskList {
  id: string;
  name: string;
  description?: string;
}

// Note types (stored as IMAP messages in "Notes" folder)
// Axigen uses X-MAPI-Message-Class: IPM.StickyNote
export interface Note {
  id: string;           // IMAP UID encoded as base64
  title: string;        // Subject header (note title)
  body: string;         // Plain text content
  htmlBody?: string;    // HTML content (optional)
  date: string;         // Creation/modification date (ISO format)
  from?: string;        // Creator email
  isFlagged?: boolean;  // Starred/flagged note
  isUnread?: boolean;   // Read status
}

export interface SearchNotesParams {
  query?: string;       // Full-text search
  limit?: number;       // Max results (default: 20)
}
