import { logger } from "../utils/logger.js";
import { formatErrorResponse } from "../utils/errors.js";
import type { ToolResponse } from "../types/mcp.js";
import { createCalDavClient, validateCredentials } from "../clients/factory.js";
import { getCurrentOAuthSessionId } from "../utils/request-context.js";

/**
 * Get CalDAV client for the current request context
 */
function getClient() {
  const oauthSessionId = getCurrentOAuthSessionId();
  return createCalDavClient(oauthSessionId);
}

export async function handleListTaskLists(): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const taskLists = await client.listTaskLists();

    const result = {
      count: taskLists.length,
      taskLists,
    };

    logger.tool("list_task_lists", {}, Date.now() - startTime, taskLists.length);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("list_task_lists failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleListTasks(args: {
  list_id?: string;
  completed?: boolean;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const tasks = await client.listTasks(args.list_id, args.completed);

    const summary = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate,
      priority: t.priority,
      completed: t.completed,
    }));

    const result = {
      count: summary.length,
      tasks: summary,
    };

    logger.tool(
      "list_tasks",
      { list_id: args.list_id, completed: args.completed },
      Date.now() - startTime,
      summary.length
    );

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("list_tasks failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleCreateTask(args: {
  title: string;
  description?: string;
  due_date?: string;
  priority?: number;
  list_id?: string;
  location?: string;
  category?: string;
  status?: "needs-action" | "in-process" | "completed";
  percent_complete?: number;
  assignee?: string;
  is_private?: boolean;
  reminder?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    const result = await client.createTask({
      title: args.title,
      description: args.description,
      dueDate: args.due_date,
      priority: args.priority,
      listId: args.list_id,
      location: args.location,
      category: args.category,
      status: args.status,
      percentComplete: args.percent_complete,
      assignee: args.assignee,
      isPrivate: args.is_private,
      reminder: args.reminder,
    });

    logger.tool("create_task", { title: args.title }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              taskId: result.taskId,
              message: `Task "${args.title}" created`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("create_task failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleUpdateTask(args: {
  task_id: string;
  title?: string;
  description?: string;
  due_date?: string;
  priority?: number;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    await client.updateTask(args.task_id, {
      title: args.title,
      description: args.description,
      dueDate: args.due_date,
      priority: args.priority,
    });

    logger.tool("update_task", { task_id: args.task_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: "Task updated",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("update_task failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleCompleteTask(args: {
  task_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    await client.completeTask(args.task_id);

    logger.tool("complete_task", { task_id: args.task_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: "Task marked as completed",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("complete_task failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleDeleteTask(args: {
  task_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const client = getClient();
    await client.deleteTask(args.task_id);

    logger.tool("delete_task", { task_id: args.task_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: "Task deleted",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("delete_task failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}
