import { logger } from "../utils/logger.js";
import { formatErrorResponse } from "../utils/errors.js";
import type { ToolResponse } from "../types/mcp.js";
import { createImapClient } from "../clients/factory.js";
import { getCurrentOAuthSessionId } from "../utils/request-context.js";

/**
 * Get IMAP client for the current request context
 */
function getClient() {
  const oauthSessionId = getCurrentOAuthSessionId();
  return createImapClient(oauthSessionId);
}

/**
 * List all notes
 */
export async function handleListNotes(args: {
  limit?: number;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const notes = await client.listNotes(args.limit);

    const summary = notes.map((n) => ({
      id: n.id,
      title: n.title,
      date: n.date,
      isFlagged: n.isFlagged,
    }));

    const result = {
      count: summary.length,
      notes: summary,
    };

    logger.tool("list_notes", { limit: args.limit }, Date.now() - startTime, summary.length);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("list_notes failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

/**
 * Get a single note with full content
 */
export async function handleGetNote(args: {
  note_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const note = await client.getNote(args.note_id);

    if (!note) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Note not found" }, null, 2) }],
        isError: true,
      };
    }

    logger.tool("get_note", { note_id: args.note_id }, Date.now() - startTime);

    return {
      content: [{ type: "text", text: JSON.stringify(note, null, 2) }],
    };
  } catch (error) {
    logger.error("get_note failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

/**
 * Search notes by text content
 */
export async function handleSearchNotes(args: {
  query?: string;
  limit?: number;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const notes = await client.searchNotes({
      query: args.query,
      limit: args.limit,
    });

    const summary = notes.map((n) => ({
      id: n.id,
      title: n.title,
      date: n.date,
      isFlagged: n.isFlagged,
    }));

    const result = {
      count: summary.length,
      query: args.query,
      notes: summary,
    };

    logger.tool("search_notes", { query: args.query, limit: args.limit }, Date.now() - startTime, summary.length);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("search_notes failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

/**
 * Create a new note
 */
export async function handleCreateNote(args: {
  title: string;
  content: string;
  html_content?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const result = await client.createNote(args.title, args.content, args.html_content);

    logger.tool("create_note", { title: args.title }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              noteId: result.noteId,
              message: `Note "${args.title}" created`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("create_note failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

/**
 * Update an existing note
 */
export async function handleUpdateNote(args: {
  note_id: string;
  title?: string;
  content?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const result = await client.updateNote(args.note_id, args.title, args.content);

    logger.tool("update_note", { note_id: args.note_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              noteId: result.noteId,
              message: "Note updated",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("update_note failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

/**
 * Delete a note
 */
export async function handleDeleteNote(args: {
  note_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    await client.deleteNote(args.note_id);

    logger.tool("delete_note", { note_id: args.note_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: "Note deleted",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("delete_note failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}
