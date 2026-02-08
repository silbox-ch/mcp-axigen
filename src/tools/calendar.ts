import { logger } from "../utils/logger.js";
import { formatErrorResponse } from "../utils/errors.js";
import type { ToolResponse } from "../types/mcp.js";
import { createCalDavClient, validateCredentials } from "../clients/factory.js";
import { getCurrentOAuthSessionId } from "../utils/request-context.js";

/**
 * Get a CalDAV client for the current request context
 */
function getClient() {
  const oauthSessionId = getCurrentOAuthSessionId();
  return createCalDavClient(oauthSessionId);
}

export async function handleListCalendars(): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const calendars = await client.listCalendars();

    const result = {
      count: calendars.length,
      calendars,
    };

    logger.tool("list_calendars", {}, Date.now() - startTime, calendars.length);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("list_calendars failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleListEvents(args: {
  calendar_id?: string;
  date_from: string;
  date_to: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const events = await client.listEvents(
      args.date_from,
      args.date_to,
      args.calendar_id
    );

    const result = {
      count: events.length,
      dateRange: { from: args.date_from, to: args.date_to },
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        location: e.location,
        allDay: e.allDay,
      })),
    };

    logger.tool(
      "list_events",
      { date_from: args.date_from, date_to: args.date_to },
      Date.now() - startTime,
      events.length
    );

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("list_events failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleGetEvent(args: {
  event_id: string;
  calendar_id?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const event = await client.getEvent(args.event_id, args.calendar_id);

    if (!event) {
      return {
        content: [{ type: "text", text: "Error: Event not found" }],
        isError: true,
      };
    }

    logger.tool("get_event", { event_id: args.event_id }, Date.now() - startTime);

    return {
      content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
    };
  } catch (error) {
    logger.error("get_event failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleCreateEvent(args: {
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
  calendar_id?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const result = await client.createEvent({
      title: args.title,
      start: args.start,
      end: args.end,
      location: args.location,
      description: args.description,
      attendees: args.attendees,
      calendarId: args.calendar_id,
    });

    logger.tool(
      "create_event",
      { title: args.title, start: args.start },
      Date.now() - startTime
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              eventId: result.eventId,
              message: `Event "${args.title}" created`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("create_event failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleUpdateEvent(args: {
  event_id: string;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
  attendees?: string[];
  calendar_id?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    await client.updateEvent(args.event_id, {
      title: args.title,
      start: args.start,
      end: args.end,
      location: args.location,
      description: args.description,
      attendees: args.attendees,
      calendarId: args.calendar_id,
    });

    logger.tool("update_event", { event_id: args.event_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: "Event updated",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("update_event failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleDeleteEvent(args: {
  event_id: string;
  calendar_id?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    await client.deleteEvent(args.event_id, args.calendar_id);

    logger.tool("delete_event", { event_id: args.event_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: "Event deleted",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("delete_event failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleGetFreeBusy(args: {
  date_from: string;
  date_to: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const busyPeriods = await client.getFreeBusy(args.date_from, args.date_to);

    const result = {
      dateRange: { from: args.date_from, to: args.date_to },
      busyPeriods,
    };

    logger.tool(
      "get_freebusy",
      { date_from: args.date_from, date_to: args.date_to },
      Date.now() - startTime,
      busyPeriods.length
    );

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("get_freebusy failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}
