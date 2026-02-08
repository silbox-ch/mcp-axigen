import { DAVClient, DAVCalendar, DAVObject } from "tsdav";
import { config, getCalDavUrl, getBaseUrl } from "../config.js";
import { logger } from "../utils/logger.js";
import type { Calendar, CalendarEvent, Task, TaskList } from "../types/axigen.js";
import { AxigenRestClient } from "./axigen-rest.js";
import type { UserCredentials } from "../types/user-context.js";
import { getUserCalDavUrl } from "../types/user-context.js";

// [TIMEZONE-FEATURE v1.5.5] VTIMEZONE support for CalDAV
// Based on Axigen support recommendation: include VTIMEZONE block in VCALENDAR
// Rollback: Set USE_VTIMEZONE = false to disable without removing code
const USE_VTIMEZONE = true;

export class CalDavClient {
  private client: DAVClient;
  private initialized = false;
  private authHeader: string;

  // [TIMEZONE-FEATURE v1.5.5] Cache user timezone to avoid repeated API calls
  // Rollback: Remove these 2 fields and related code in getUserTimezone()
  private cachedTimezone: string | null = null;
  private restClient: AxigenRestClient | null = null;

  // User credentials (for multi-user mode)
  private userCredentials: UserCredentials | null = null;
  private userEmail: string;

  /**
   * Create a new CalDAV client
   * @param credentials - Optional user credentials for multi-user mode.
   *                      If not provided, uses config.axigen credentials (single-user mode)
   */
  constructor(credentials?: UserCredentials) {
    this.userCredentials = credentials || null;

    // Use user credentials if provided, otherwise fall back to config
    const username = this.userCredentials?.email || config.axigen.username;
    const password = this.userCredentials?.password || config.axigen.password;
    this.userEmail = username;

    // Build CalDAV URL for this user
    const caldavUrl = this.userCredentials
      ? getUserCalDavUrl(getBaseUrl(), this.userCredentials.email)
      : getCalDavUrl();

    this.client = new DAVClient({
      serverUrl: caldavUrl,
      credentials: {
        username,
        password,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    this.authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.client.login();
      this.initialized = true;
    }
  }

  /**
   * Create a CalDAV object using raw fetch to capture Location header
   * Axigen returns a different URL than what we PUT (e.g., Tasks_xxx_yyy_zzz.ics)
   */
  private async rawPutCalendarObject(
    collectionUrl: string,
    filename: string,
    icalData: string
  ): Promise<{ url: string; serverUrl: string | null }> {
    // collectionUrl from tsdav is already a full URL like https://HOST/Calendar/Tasks/
    const clientUrl = `${collectionUrl}${filename}`;

    logger.debug("CalDAV PUT request", { collectionUrl, filename, clientUrl });

    const response = await fetch(clientUrl, {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "text/calendar; charset=utf-8",
        "If-None-Match": "*",
      },
      body: icalData,
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error("CalDAV PUT failed", { status: response.status, body: body.substring(0, 200) });
      throw new Error(`CalDAV PUT failed: ${response.status} ${response.statusText}`);
    }

    // Get server-assigned URL from Location header
    const location = response.headers.get("location");
    let serverUrl: string | null = null;
    if (location) {
      // Location may be relative (e.g., /Calendar/Tasks/Tasks_414_1844_921.ics)
      serverUrl = location.startsWith("http") ? location : `${getBaseUrl()}${location}`;
      logger.debug("CalDAV PUT returned Location header", { clientUrl, serverUrl });
    }

    return { url: clientUrl, serverUrl };
  }

  // ==================== Calendars ====================

  async listCalendars(): Promise<Calendar[]> {
    await this.ensureInitialized();

    const calendars = await this.client.fetchCalendars();

    return calendars.map((cal: DAVCalendar) => ({
      id: cal.url,
      name: cal.displayName || "Calendar",
      color: cal.calendarColor,
      description: cal.description,
    }));
  }

  async getDefaultCalendar(): Promise<DAVCalendar | undefined> {
    await this.ensureInitialized();
    const calendars = await this.client.fetchCalendars();
    return calendars[0];
  }

  async getDefaultTaskList(): Promise<DAVCalendar | undefined> {
    await this.ensureInitialized();
    const calendars = await this.client.fetchCalendars();
    // Find the Tasks collection (usually named "Tasks" or has /Tasks/ in URL)
    const taskList = calendars.find(
      (cal) =>
        cal.url.includes("/Tasks/") ||
        cal.displayName?.toLowerCase() === "tasks"
    );
    // Fallback to first calendar if no dedicated task list found
    return taskList || calendars[0];
  }

  // ==================== Events ====================

  async listEvents(
    dateFrom: string,
    dateTo: string,
    calendarId?: string
  ): Promise<CalendarEvent[]> {
    await this.ensureInitialized();

    let calendars: DAVCalendar[];
    if (calendarId) {
      calendars = [{ url: calendarId } as DAVCalendar];
    } else {
      calendars = await this.client.fetchCalendars();
    }

    const events: CalendarEvent[] = [];

    for (const calendar of calendars) {
      const calendarObjects = await this.client.fetchCalendarObjects({
        calendar,
        timeRange: {
          start: dateFrom,
          end: dateTo,
        },
      });

      for (const obj of calendarObjects) {
        const parsed = this.parseICalEvent(obj, calendar.url);
        if (parsed) {
          events.push(parsed);
        }
      }
    }

    return events;
  }

  async getEvent(eventId: string, calendarId?: string): Promise<CalendarEvent | null> {
    await this.ensureInitialized();

    // If calendarId is provided, search only in that calendar
    // Otherwise, search across all calendars to find the event
    const calendars = calendarId
      ? [{ url: calendarId } as DAVCalendar]
      : await this.client.fetchCalendars();

    if (!calendars.length) {
      return null;
    }

    for (const calendar of calendars) {
      const objects = await this.client.fetchCalendarObjects({
        calendar: calendar as DAVCalendar,
      });

      const obj = objects.find((o: DAVObject) => o.url === eventId || o.etag === eventId);
      if (obj) {
        return this.parseICalEvent(obj, calendar.url);
      }
    }

    return null;
  }

  async createEvent(event: {
    title: string;
    start: string;
    end: string;
    location?: string;
    description?: string;
    attendees?: string[];
    calendarId?: string;
  }): Promise<{ eventId: string }> {
    await this.ensureInitialized();

    const calendarUrl = event.calendarId || `${getBaseUrl()}/Calendar/Calendar/`;
    const calendar = { url: calendarUrl };

    if (!calendar) {
      throw new Error("No calendar found");
    }

    const uid = this.generateUid();

    // [TIMEZONE-FEATURE v1.5.5] Get user timezone for VTIMEZONE block
    // Rollback: Remove timezone fetch and pass undefined to buildICalEvent
    const timezone = USE_VTIMEZONE ? await this.getUserTimezone() : undefined;
    const icalData = this.buildICalEvent(uid, event, timezone);

    // [BUG-FIX v2.2.1] Use rawPutCalendarObject instead of tsdav createCalendarObject
    // tsdav returns Response object without checking if PUT succeeded
    // rawPutCalendarObject verifies response.ok and captures Location header
    const { url: clientUrl, serverUrl } = await this.rawPutCalendarObject(
      calendarUrl,
      `${uid}.ics`,
      icalData
    );

    // Axigen may rename the file (e.g., Calendar_414_1850_xxx.ics)
    // Use server URL if available, otherwise fall back to client URL
    const eventUrl = serverUrl || clientUrl;
    logger.info(`[CalDAV] Event created: clientUrl=${clientUrl}, serverUrl=${serverUrl || "none"}`);
    return { eventId: eventUrl, uid };
  }

  async updateEvent(
    eventId: string,
    updates: {
      title?: string;
      start?: string;
      end?: string;
      location?: string;
      description?: string;
      attendees?: string[];
      calendarId?: string;
    }
  ): Promise<void> {
    await this.ensureInitialized();

    // First get the existing event
    const existingEvent = await this.getEvent(eventId, updates.calendarId);
    if (!existingEvent) {
      throw new Error("Event not found");
    }

    const calendar = updates.calendarId
      ? { url: updates.calendarId }
      : await this.getDefaultCalendar();

    if (!calendar) {
      throw new Error("No calendar found");
    }

    const mergedEvent = {
      title: updates.title || existingEvent.title,
      start: updates.start || existingEvent.start,
      end: updates.end || existingEvent.end,
      location: updates.location ?? existingEvent.location,
      description: updates.description ?? existingEvent.description,
      attendees: updates.attendees || existingEvent.attendees?.map((a) => a.email),
    };

    // [TIMEZONE-FEATURE v1.5.5] Get user timezone for VTIMEZONE block
    // Rollback: Remove timezone fetch and pass undefined to buildICalEvent
    const timezone = USE_VTIMEZONE ? await this.getUserTimezone() : undefined;
    const icalData = this.buildICalEvent(existingEvent.uid, mergedEvent, timezone);

    await this.client.updateCalendarObject({
      calendarObject: {
        url: eventId,
        data: icalData,
      },
    });
  }

  async deleteEvent(eventId: string, calendarId?: string): Promise<void> {
    await this.ensureInitialized();

    await this.client.deleteCalendarObject({
      calendarObject: {
        url: eventId,
      },
    });
  }

  async getFreeBusy(dateFrom: string, dateTo: string): Promise<Array<{ start: string; end: string }>> {
    await this.ensureInitialized();

    // Get all events in the range and return busy periods
    const events = await this.listEvents(dateFrom, dateTo);

    return events.map((event) => ({
      start: event.start,
      end: event.end,
    }));
  }

  // ==================== Tasks (VTODO) ====================

  async listTaskLists(): Promise<TaskList[]> {
    await this.ensureInitialized();

    // In CalDAV, tasks are typically in the same calendars as events
    // or in dedicated VTODO calendars
    const calendars = await this.client.fetchCalendars({
      // Some servers separate VEVENT and VTODO calendars
    });

    return calendars.map((cal: DAVCalendar) => ({
      id: cal.url,
      name: cal.displayName || "Tasks",
      description: cal.description,
    }));
  }

  async listTasks(listId?: string, completed?: boolean): Promise<Task[]> {
    await this.ensureInitialized();

    const calendars = listId
      ? [{ url: listId } as DAVCalendar]
      : await this.client.fetchCalendars();

    const tasks: Task[] = [];

    for (const calendar of calendars) {
      const objects = await this.client.fetchCalendarObjects({
        calendar,
        // Note: tsdav doesn't have a built-in filter for VTODO vs VEVENT
        // We'll filter in the parsing step
      });

      for (const obj of objects) {
        const parsed = this.parseICalTask(obj, calendar.url);
        if (parsed) {
          // Apply completed filter
          if (completed === undefined || parsed.completed === completed) {
            tasks.push(parsed);
          }
        }
      }
    }

    return tasks;
  }

  async createTask(task: {
    title: string;
    description?: string;
    dueDate?: string;
    startDate?: string; // [v2.1.1] DTSTART
    priority?: number;
    listId?: string;
    location?: string;
    categories?: string[]; // [v2.1.1] CATEGORIES (labels)
    status?: "needs-action" | "in-process" | "completed";
    percentComplete?: number;  // 0=inbox, 25=todo, 50=doing, 75=waiting, 100=done
    assignee?: string;
    isPrivate?: boolean;
    reminder?: string; // ISO 8601 datetime for reminder
  }): Promise<{ taskId: string }> {
    await this.ensureInitialized();

    const calendar = task.listId
      ? { url: task.listId }
      : await this.getDefaultTaskList();

    if (!calendar) {
      throw new Error("No task list found");
    }

    const uid = this.generateUid();

    // [TIMEZONE-FEATURE v1.5.5] Get user timezone for VTIMEZONE block
    // Rollback: Remove timezone fetch and pass undefined to buildICalTask
    const timezone = USE_VTIMEZONE ? await this.getUserTimezone() : undefined;
    const icalData = this.buildICalTask(uid, task, false, timezone);

    // Use tsdav createCalendarObject
    const result = await this.client.createCalendarObject({
      calendar: calendar as DAVCalendar,
      filename: `${uid}.ics`,
      iCalString: icalData,
    });

    const taskUrl = result?.url || `${calendar.url}${uid}.ics`;
    return { taskId: taskUrl, uid };
  }

  async updateTask(
    taskId: string,
    updates: {
      title?: string;
      description?: string;
      dueDate?: string;
      startDate?: string; // [v2.1.1]
      priority?: number;
      listId?: string;
      location?: string; // [v2.1.1]
      categories?: string[]; // [v2.1.1]
      reminder?: number; // [v2.1.1] minutes before due
      percentComplete?: number;  // 0=inbox, 25=todo, 50=doing, 75=waiting, 100=done
      completed?: boolean;
    }
  ): Promise<void> {
    await this.ensureInitialized();

    // Get existing task - search in specified list or all lists
    const tasks = await this.listTasks(updates.listId);
    let existingTask = tasks.find((t) => t.uid === taskId || t.id === taskId);

    // If not found and no listId specified, search in all task lists
    if (!existingTask && !updates.listId) {
      const allTasks = await this.listTasks();
      existingTask = allTasks.find((t) => t.uid === taskId || t.id === taskId);
    }

    if (!existingTask) {
      throw new Error("Task not found");
    }

    // Determine status and percentComplete
    // Priority: explicit updates.percentComplete > explicit updates.completed > existing values
    let percentComplete: number;
    let status: 'needs-action' | 'in-process' | 'completed';

    // If percentComplete is explicitly provided, use it
    if (updates.percentComplete !== undefined) {
      percentComplete = updates.percentComplete;
    } else if (updates.completed === true) {
      percentComplete = 100;
    } else if (updates.completed === false && existingTask.percentComplete === 100) {
      // Uncompleting a task that was 100% -> move to 50%
      percentComplete = 50;
    } else {
      percentComplete = existingTask.percentComplete ?? 0;
    }

    // Determine status from percentComplete
    if (percentComplete === 100) {
      status = 'completed';
    } else if (percentComplete > 0) {
      status = 'in-process';
    } else {
      status = 'needs-action';
    }

    logger.debug(`[CalDAV] updateTask: percentComplete=${percentComplete}, status=${status}`);

    // [v2.1.1] Calculate reminder datetime if minutes provided
    let reminderDatetime: string | undefined;
    if (updates.reminder !== undefined && updates.dueDate) {
      const dueDate = new Date(updates.dueDate);
      dueDate.setMinutes(dueDate.getMinutes() - updates.reminder);
      reminderDatetime = dueDate.toISOString();
    }

    const mergedTask = {
      title: updates.title || existingTask.title,
      description: updates.description ?? existingTask.description,
      dueDate: updates.dueDate ?? existingTask.dueDate,
      startDate: updates.startDate ?? (existingTask as any).startDate, // [v2.1.1]
      priority: updates.priority ?? existingTask.priority,
      location: updates.location ?? (existingTask as any).location, // [v2.1.1]
      categories: updates.categories ?? (existingTask as any).categories, // [v2.1.1]
      reminder: reminderDatetime, // [v2.1.1]
      percentComplete,
      status,
    };

    const isCompleted = status === 'completed';

    // [TIMEZONE-FEATURE v1.5.5] Get user timezone for VTIMEZONE block
    // Rollback: Remove timezone fetch and pass undefined to buildICalTask
    const timezone = USE_VTIMEZONE ? await this.getUserTimezone() : undefined;
    const icalData = this.buildICalTask(existingTask.uid, mergedTask, isCompleted, timezone);

    await this.client.updateCalendarObject({
      calendarObject: {
        url: taskId,
        data: icalData,
      },
    });
  }

  async completeTask(taskId: string, listId?: string): Promise<void> {
    await this.ensureInitialized();

    // Search in specified list first, then in all lists if not found
    const tasks = await this.listTasks(listId);
    let task = tasks.find((t) => t.uid === taskId || t.id === taskId);

    // If not found and no listId specified, search in all task lists
    if (!task && !listId) {
      const allTasks = await this.listTasks();
      task = allTasks.find((t) => t.uid === taskId || t.id === taskId);
    }

    if (!task) {
      throw new Error("Task not found");
    }

    // [TIMEZONE-FEATURE v1.5.5] Get user timezone for VTIMEZONE block
    // Rollback: Remove timezone fetch and pass undefined to buildICalTask
    const timezone = USE_VTIMEZONE ? await this.getUserTimezone() : undefined;
    const icalData = this.buildICalTask(
      task.uid,
      {
        title: task.title,
        description: task.description,
        dueDate: task.dueDate,
        priority: task.priority,
      },
      true,
      timezone
    );

    await this.client.updateCalendarObject({
      calendarObject: {
        url: taskId,
        data: icalData,
      },
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.ensureInitialized();

    await this.client.deleteCalendarObject({
      calendarObject: {
        url: taskId,
      },
    });
  }

  // ==================== Helpers ====================

  private generateUid(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}@mcp-axigen`;
  }

  // ==================== TIMEZONE SUPPORT ====================
  // [TIMEZONE-FEATURE v1.5.5] Methods for VTIMEZONE generation
  // Based on Axigen support example: VTIMEZONE with STANDARD/DAYLIGHT subcomponents
  // Rollback: Set USE_VTIMEZONE = false at top of file

  /**
   * Get user timezone from Axigen account settings (cached)
   * Falls back to Europe/Zurich if not available
   */
  private async getUserTimezone(): Promise<string> {
    if (this.cachedTimezone) {
      return this.cachedTimezone;
    }

    try {
      if (!this.restClient) {
        // Pass user credentials to REST client if available
        this.restClient = new AxigenRestClient(this.userCredentials || undefined);
      }
      const settings = await this.restClient.getAccountSettings();
      this.cachedTimezone = settings.timezone || "Europe/Zurich";
      logger.debug(`[TIMEZONE] User timezone: ${this.cachedTimezone}`);
    } catch (error) {
      logger.warn(`[TIMEZONE] Failed to get user timezone, using default: ${error}`);
      this.cachedTimezone = "Europe/Zurich";
    }

    return this.cachedTimezone;
  }

  /**
   * Generate VTIMEZONE block for common European timezones
   * Format based on Axigen support example
   *
   * [TIMEZONE-FEATURE v1.5.5] Supported timezones:
   * - Europe/Zurich, Europe/Paris, Europe/Berlin (CET/CEST)
   * - Europe/London (GMT/BST)
   * - Europe/Bucharest (EET/EEST) - from Axigen example
   * - UTC (no DST)
   *
   * For unsupported timezones, falls back to UTC
   */
  private getVTimezoneBlock(tzid: string): string {
    // [TIMEZONE-FEATURE v1.5.5] VTIMEZONE definitions
    // Rollback: Return empty string here to disable VTIMEZONE

    const timezones: Record<string, { standard: string; daylight: string; stdName: string; dstName: string; stdOffset: string; dstOffset: string }> = {
      // Central European Time (CET/CEST) - Switzerland, France, Germany, etc.
      "Europe/Zurich": {
        standard: "DTSTART:19701025T030000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10;WKST=SU",
        daylight: "DTSTART:19700329T020000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3;WKST=SU",
        stdName: "CET", dstName: "CEST", stdOffset: "+0100", dstOffset: "+0200"
      },
      "Europe/Paris": {
        standard: "DTSTART:19701025T030000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10;WKST=SU",
        daylight: "DTSTART:19700329T020000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3;WKST=SU",
        stdName: "CET", dstName: "CEST", stdOffset: "+0100", dstOffset: "+0200"
      },
      "Europe/Berlin": {
        standard: "DTSTART:19701025T030000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10;WKST=SU",
        daylight: "DTSTART:19700329T020000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3;WKST=SU",
        stdName: "CET", dstName: "CEST", stdOffset: "+0100", dstOffset: "+0200"
      },
      // British Time (GMT/BST)
      "Europe/London": {
        standard: "DTSTART:19701025T020000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10;WKST=SU",
        daylight: "DTSTART:19700329T010000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3;WKST=SU",
        stdName: "GMT", dstName: "BST", stdOffset: "+0000", dstOffset: "+0100"
      },
      // Eastern European Time (EET/EEST) - from Axigen example
      "Europe/Bucharest": {
        standard: "DTSTART:19701025T040000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10;WKST=SU",
        daylight: "DTSTART:19700329T030000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3;WKST=SU",
        stdName: "EET", dstName: "EEST", stdOffset: "+0200", dstOffset: "+0300"
      },
    };

    const tz = timezones[tzid];
    if (!tz) {
      // Unsupported timezone - use UTC (no VTIMEZONE needed, dates use Z suffix)
      logger.debug(`[TIMEZONE] Unsupported timezone ${tzid}, using UTC`);
      return "";
    }

    // Build VTIMEZONE block matching Axigen support example format
    const lines = [
      "BEGIN:VTIMEZONE",
      `TZID:${tzid}`,
      `X-LIC-LOCATION:${tzid}`,
      "BEGIN:STANDARD",
      tz.standard,
      `TZNAME:${tz.stdName}`,
      `TZOFFSETFROM:${tz.dstOffset}`,
      `TZOFFSETTO:${tz.stdOffset}`,
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      tz.daylight,
      `TZNAME:${tz.dstName}`,
      `TZOFFSETFROM:${tz.stdOffset}`,
      `TZOFFSETTO:${tz.dstOffset}`,
      "END:DAYLIGHT",
      "END:VTIMEZONE",
    ];

    return lines.join("\r\n");
  }

  private parseICalEvent(obj: DAVObject, calendarId: string): CalendarEvent | null {
    const data = obj.data;
    if (!data || !data.includes("VEVENT")) {
      return null;
    }

    // Extract VEVENT block
    const veventMatch = data.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/i);
    if (!veventMatch) {
      return null;
    }
    const vevent = veventMatch[1];

    // Parse field with support for parameters (e.g., DTSTART;TZID=xxx:value)
    const getField = (field: string): string | undefined => {
      // Match field name followed by optional parameters, then : and value
      const regex = new RegExp(`^${field}(?:;[^:]*)?:(.+)$`, "im");
      const match = vevent.match(regex);
      return match?.[1]?.trim();
    };

    // Parse field including any parameters before the value
    const getFieldWithParams = (field: string): string | undefined => {
      const regex = new RegExp(`^${field}(;[^:]*)?:(.+)$`, "im");
      const match = vevent.match(regex);
      if (match) {
        // Return params + value for date parsing
        const params = match[1] || "";
        const value = match[2]?.trim() || "";
        return params ? `${params.slice(1)}:${value}` : value;
      }
      return undefined;
    };

    const uid = getField("UID") || obj.url;
    const title = getField("SUMMARY") || "Untitled";
    const startRaw = getFieldWithParams("DTSTART") || "";
    const endRaw = getFieldWithParams("DTEND") || startRaw;
    const location = getField("LOCATION");
    const description = getField("DESCRIPTION");

    const start = this.parseICalDate(startRaw);
    const end = this.parseICalDate(endRaw);

    // Detect all-day event: no T in the date value (after removing params)
    const dateValueOnly = startRaw.includes(":") ? startRaw.split(":").pop() : startRaw;
    const allDay = dateValueOnly ? !dateValueOnly.includes("T") : false;

    return {
      id: obj.url,
      uid,
      title,
      description,
      location,
      start,
      end,
      allDay,
      calendarId,
    };
  }

  private parseICalTask(obj: DAVObject, listId: string): Task | null {
    const rawData = obj.data;
    if (!rawData || !rawData.includes("VTODO")) {
      return null;
    }

    // [v2.1.2] Normalize line endings to \n and extract VTODO block
    // iCal uses CRLF (\r\n) which breaks multiline regex anchors
    const data = rawData.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Extract just the VTODO block to avoid matching fields from VCALENDAR or other components
    const vtodoMatch = data.match(/BEGIN:VTODO([\s\S]*?)END:VTODO/i);
    const vtodo = vtodoMatch ? vtodoMatch[1] : data;

    // [v2.1.2] Fixed regex to match at start of line (multiline mode)
    // This prevents matching field names that appear in the middle of other values
    const getField = (field: string): string | undefined => {
      // The regex must:
      // 1. Start at beginning of line (^)
      // 2. Match the exact field name
      // 3. Optionally have parameters (;PARAM=value)
      // 4. Have a colon before the value
      // 5. Capture the value until end of line
      const regex = new RegExp(`^${field}(?:;[^:\\n]*)?:([^\\n]+)`, "im");
      const match = vtodo.match(regex);
      return match?.[1]?.trim();
    };

    const uid = getField("UID") || obj.url;
    const title = getField("SUMMARY") || "Untitled";
    const description = getField("DESCRIPTION");
    const dueDate = getField("DUE");
    const startDate = getField("DTSTART"); // [v2.1.1]
    const priority = getField("PRIORITY");
    const status = getField("STATUS") as 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | undefined;
    const completedDate = getField("COMPLETED");
    const location = getField("LOCATION"); // [v2.1.1]
    const categoriesStr = getField("CATEGORIES"); // [v2.1.1]
    const categories = categoriesStr ? categoriesStr.split(",").map(c => c.trim()) : undefined;
    // Extract PERCENT-COMPLETE
    const percentCompleteStr = getField("PERCENT-COMPLETE");
    const percentComplete = percentCompleteStr ? parseInt(percentCompleteStr, 10) : 0;

    // [v2.1.2] Debug logging for date parsing issues
    if (startDate || dueDate) {
      logger.info(`[CalDAV] Task "${title}" raw dates - startDate: "${startDate}", dueDate: "${dueDate}"`);
    }

    // [v2.1.2] Helper to parse date and return undefined if empty/invalid
    // Also validates that the raw string looks like a date (starts with digits or TZID=)
    const parseDate = (raw: string | undefined, fieldName: string): string | undefined => {
      if (!raw) return undefined;
      // Quick check: iCal dates start with digits (20240117) or TZID= or VALUE=
      if (!/^(\d|TZID=|VALUE=)/i.test(raw)) {
        logger.warn(`[CalDAV] Task "${title}" - ${fieldName} rejected (invalid format): "${raw}"`);
        return undefined;
      }
      const parsed = this.parseICalDate(raw);
      // Verify the result is a valid ISO date format and year is reasonable (1990-2100)
      if (!parsed || !/^\d{4}-\d{2}-\d{2}/.test(parsed)) {
        logger.warn(`[CalDAV] Task "${title}" - ${fieldName} parse failed: "${raw}" -> "${parsed}"`);
        return undefined;
      }
      // Additional check: reject dates before 1990 or after 2100 (clearly invalid)
      const year = parseInt(parsed.slice(0, 4), 10);
      if (year < 1990 || year > 2100) {
        logger.warn(`[CalDAV] Task "${title}" - ${fieldName} invalid year ${year}: "${raw}" -> "${parsed}"`);
        return undefined;
      }
      logger.info(`[CalDAV] Task "${title}" - ${fieldName} parsed OK: "${raw}" -> "${parsed}"`);
      return parsed;
    };

    return {
      id: obj.url,
      uid,
      title,
      description,
      dueDate: parseDate(dueDate, "DUE"),
      startDate: parseDate(startDate, "DTSTART"), // [v2.1.1]
      priority: priority ? parseInt(priority, 10) : undefined,
      completed: status === "COMPLETED",
      completedDate: parseDate(completedDate, "COMPLETED"),
      listId,
      location, // [v2.1.1]
      categories, // [v2.1.1]
      status,
      percentComplete,
    };
  }

  private parseICalDate(icalDate: string): string {
    // Handle various iCal date formats:
    // - 20240117T103000Z (UTC)
    // - 20240117T103000 (local)
    // - 20240117 (date only)
    // - TZID=Europe/Zurich:20240117T103000 (with timezone)
    // - VALUE=DATE:20240117 (explicit date)
    if (!icalDate) return "";

    // Extract the actual date part (after any parameters)
    let dateStr = icalDate;

    // Handle TZID=xxx: prefix
    if (dateStr.includes(":")) {
      dateStr = dateStr.split(":").pop() || dateStr;
    }

    // Remove VALUE=DATE prefix if still present
    dateStr = dateStr.replace(/^VALUE=DATE/i, "").trim();

    // Try to match date-only format: YYYYMMDD
    if (/^\d{8}$/.test(dateStr)) {
      return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    }

    // Try to match datetime format: YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
    const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (match) {
      const [, year, month, day, hour, min, sec, utc] = match;
      return `${year}-${month}-${day}T${hour}:${min}:${sec}${utc || ""}`;
    }

    // If already in ISO format, return as-is
    if (icalDate.match(/^\d{4}-\d{2}-\d{2}/)) {
      return icalDate;
    }

    logger.warn(`Could not parse iCal date: ${icalDate}`);
    return icalDate;
  }

  private formatICalDate(isoDate: string): string {
    // Convert ISO date to iCal format (e.g., 2026-01-19T19:16:16.191Z -> 20260119T191616)
    // Axigen doesn't accept the trailing 'Z' - it causes parsing errors
    const withoutZ = isoDate.replace(/Z$/, "");
    const withoutMs = withoutZ.split(".")[0];
    const formatted = withoutMs.replace(/[-:]/g, "");
    return formatted;
  }

  private formatICalDateOnly(isoDate: string): string {
    // Convert ISO date to iCal DATE format (e.g., 2026-01-20T14:00:00 -> 20260120)
    // Used for DUE property in VTODO which requires VALUE=DATE format
    const dateOnly = isoDate.split("T")[0].replace(/-/g, "");
    return dateOnly;
  }

  private formatICalDateUtc(isoDate: string): string {
    // Convert ISO date to iCal UTC format with Z suffix (e.g., 2026-01-29T07:00:00 -> 20260129T070000Z)
    // Used for VALARM TRIGGER which requires UTC datetime
    const date = new Date(isoDate);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");
    return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
  }

  private formatICalDueDateUtc(isoDate: string): string {
    // Convert date to iCal DUE format: YYYYMMDDTHHMMSSZ at midnight UTC
    // Axigen expects DUE:20260120T000000Z (not VALUE=DATE format)
    const date = new Date(isoDate);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}${month}${day}T000000Z`;
  }

  // [TIMEZONE-FEATURE v1.5.5] Added timezone parameter for VTIMEZONE support
  // Rollback: Remove timezone parameter and vtimezoneBlock logic, revert to original
  private buildICalEvent(
    uid: string,
    event: {
      title: string;
      start: string;
      end: string;
      location?: string;
      description?: string;
      attendees?: string[];
    },
    timezone?: string // [TIMEZONE-FEATURE v1.5.5] Optional timezone for VTIMEZONE
  ): string {
    // [TIMEZONE-FEATURE v1.5.5] Include VTIMEZONE block if enabled and timezone provided
    const vtimezoneBlock = USE_VTIMEZONE && timezone ? this.getVTimezoneBlock(timezone) : "";
    const hasVTimezone = vtimezoneBlock.length > 0;

    // [TIMEZONE-FEATURE v1.5.5] Use TZID parameter for dates if VTIMEZONE is included
    // Otherwise use floating time (original behavior)
    const formatDateWithTz = (isoDate: string): string => {
      if (hasVTimezone) {
        // Format: DTSTART;TZID=Europe/Zurich:20260120T140000
        return `${this.formatICalDate(isoDate)}`;
      }
      return this.formatICalDate(isoDate);
    };

    const lines = [
      "BEGIN:VCALENDAR",
      "CALSCALE:GREGORIAN", // [TIMEZONE-FEATURE v1.5.5] Added per Axigen example
      "METHOD:PUBLISH",     // [TIMEZONE-FEATURE v1.5.5] Added per Axigen example
      "PRODID:AXIGEN",      // [TIMEZONE-FEATURE v1.5.5] Changed to match Axigen format
      "VERSION:2.0",
    ];

    // [TIMEZONE-FEATURE v1.5.5] Insert VTIMEZONE block after VCALENDAR header
    if (hasVTimezone) {
      lines.push(vtimezoneBlock);
    }

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${this.formatICalDateUtc(new Date().toISOString())}`);

    // [TIMEZONE-FEATURE v1.5.5] Use TZID parameter if VTIMEZONE is included
    if (hasVTimezone) {
      lines.push(`DTSTART;TZID=${timezone}:${formatDateWithTz(event.start)}`);
      lines.push(`DTEND;TZID=${timezone}:${formatDateWithTz(event.end)}`);
    } else {
      // Original behavior: floating time without TZID
      lines.push(`DTSTART:${this.formatICalDate(event.start)}`);
      lines.push(`DTEND:${this.formatICalDate(event.end)}`);
    }

    lines.push(`SUMMARY:${event.title}`);

    if (event.location) {
      lines.push(`LOCATION:${event.location}`);
    }
    if (event.description) {
      lines.push(`DESCRIPTION:${event.description}`);
    }
    if (event.attendees) {
      for (const attendee of event.attendees) {
        lines.push(`ATTENDEE:mailto:${attendee}`);
      }
    }

    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n");
  }

  // [TIMEZONE-FEATURE v1.5.5] Added timezone parameter for VTIMEZONE support
  // Rollback: Remove timezone parameter and vtimezoneBlock logic
  private buildICalTask(
    uid: string,
    task: {
      title: string;
      description?: string;
      dueDate?: string;
      startDate?: string; // [v2.1.1] DTSTART
      priority?: number;
      location?: string;
      categories?: string[]; // [v2.1.1] CATEGORIES (labels)
      status?: "needs-action" | "in-process" | "completed";
      percentComplete?: number;  // 0=inbox, 25=todo, 50=doing, 75=waiting, 100=done
      assignee?: string;
      isPrivate?: boolean;
      reminder?: string;
    },
    completed: boolean = false,
    timezone?: string // [TIMEZONE-FEATURE v1.5.5] Optional timezone for VTIMEZONE
  ): string {
    const now = this.formatICalDateUtc(new Date().toISOString());
    const userEmail = this.userEmail;

    // [TIMEZONE-FEATURE v1.5.5] Include VTIMEZONE block if enabled and timezone provided
    const vtimezoneBlock = USE_VTIMEZONE && timezone ? this.getVTimezoneBlock(timezone) : "";

    // Format based on Axigen support recommendation
    // Key differences from RFC: METHOD:PUBLISH, DUE as datetime with Z, ORGANIZER, SEQUENCE
    const lines = [
      "BEGIN:VCALENDAR",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "PRODID:AXIGEN",
      "VERSION:2.0",
    ];

    // [TIMEZONE-FEATURE v1.5.5] Insert VTIMEZONE block after VCALENDAR header (per Axigen example)
    if (vtimezoneBlock) {
      lines.push(vtimezoneBlock);
    }

    lines.push("BEGIN:VTODO");

    // PERCENT-COMPLETE first (like Axigen example)
    lines.push(`PERCENT-COMPLETE:${task.percentComplete ?? 0}`);

    // Priority (default 5 = normal)
    lines.push(`PRIORITY:${task.priority ?? 5}`);

    // Status
    if (completed || task.status === "completed") {
      lines.push("STATUS:COMPLETED");
    } else if (task.status === "in-process") {
      lines.push("STATUS:IN-PROCESS");
    } else {
      lines.push("STATUS:NEEDS-ACTION");
    }

    lines.push(`SUMMARY:${task.title}`);

    if (task.description) {
      lines.push(`DESCRIPTION:${task.description}`);
    }
    if (task.location) {
      lines.push(`LOCATION:${task.location}`);
    }

    // [v2.1.1] CATEGORIES for task labels
    if (task.categories && task.categories.length > 0) {
      lines.push(`CATEGORIES:${task.categories.join(",")}`);
    }

    // [v2.1.1] DTSTART for start date
    if (task.startDate) {
      const startDateTime = this.formatICalDueDateUtc(task.startDate);
      lines.push(`DTSTART:${startDateTime}`);
    }

    // DUE as datetime with Z suffix (Axigen format: DUE:20260120T000000Z)
    // [TIMEZONE-FEATURE v1.5.5] Keep UTC format for DUE - Axigen example uses Z suffix
    if (task.dueDate) {
      const dueDateTime = this.formatICalDueDateUtc(task.dueDate);
      lines.push(`DUE:${dueDateTime}`);
    }

    // ORGANIZER with user email
    lines.push(`ORGANIZER;CN="":mailto:${userEmail}`);

    // UID, DTSTAMP, LAST-MODIFIED, SEQUENCE
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`LAST-MODIFIED:${now}`);
    lines.push("SEQUENCE:0");

    if (completed || task.status === "completed") {
      lines.push(`COMPLETED:${now}`);
    }

    if (task.isPrivate) {
      lines.push("CLASS:PRIVATE");
    }

    // Reminder (VALARM) at the end
    if (task.reminder) {
      const reminderDate = this.formatICalDateUtc(task.reminder);
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push("DESCRIPTION:Reminder");
      lines.push(`TRIGGER;VALUE=DATE-TIME:${reminderDate}`);
      lines.push("END:VALARM");
    }

    lines.push("END:VTODO", "END:VCALENDAR");
    return lines.join("\r\n");
  }
}
