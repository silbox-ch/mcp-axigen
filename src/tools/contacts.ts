import { logger } from "../utils/logger.js";
import { formatErrorResponse } from "../utils/errors.js";
import type { ToolResponse } from "../types/mcp.js";
import { createRestClient, createCardDavClient, validateCredentials } from "../clients/factory.js";
import { getCurrentOAuthSessionId } from "../utils/request-context.js";

/**
 * Get REST client for the current request context
 */
function getRestClient() {
  const oauthSessionId = getCurrentOAuthSessionId();
  return createRestClient(oauthSessionId);
}

/**
 * Get CardDAV client for the current request context
 */
function getCardDavClient() {
  const oauthSessionId = getCurrentOAuthSessionId();
  return createCardDavClient(oauthSessionId);
}

export async function handleListAddressBooks(): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const restClient = getRestClient();
    const folders = await restClient.listContactFolders();

    const result = {
      count: folders.length,
      addressBooks: folders.map((f) => ({
        id: f.id,
        name: f.name,
        totalItems: f.totalItems,
      })),
    };

    logger.tool("list_addressbooks", {}, Date.now() - startTime, folders.length);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("list_addressbooks failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleListContacts(args: {
  addressbook_id?: string;
  limit?: number;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const restClient = getRestClient();
    const response = await restClient.listContacts(args.addressbook_id, {
      limit: args.limit || 100,
    });

    const result = {
      count: response.items.length,
      totalItems: response.totalItems,
      contacts: response.items.map((c) => ({
        id: c.id,
        name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        organization: c.organization,
      })),
    };

    logger.tool(
      "list_contacts",
      { addressbook_id: args.addressbook_id, limit: args.limit },
      Date.now() - startTime,
      response.items.length
    );

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("list_contacts failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleSearchContacts(args: {
  query?: string;
  name?: string;
  email?: string;
  phone?: string;
  limit?: number;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    // At least one search parameter is required
    if (!args.query && !args.name && !args.email && !args.phone) {
      return {
        content: [{ type: "text", text: "Error: At least one search parameter is required (query, name, email, or phone)" }],
        isError: true,
      };
    }

    // Use query or combine other params
    const searchQuery = args.query || args.name || args.email || args.phone || "";
    const restClient = getRestClient();
    const response = await restClient.searchContacts(searchQuery, args.limit || 20);

    const result = {
      count: response.items.length,
      contacts: response.items.map((c) => ({
        id: c.id,
        name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        organization: c.organization,
      })),
    };

    logger.tool("search_contacts", args, Date.now() - startTime, response.items.length);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error("search_contacts failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleGetContact(args: {
  contact_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const restClient = getRestClient();
    const cardDavClient = getCardDavClient();

    // Try REST client first (faster if it works)
    let contact = await restClient.getContact(args.contact_id);

    // Fallback to CardDAV if REST returns null
    if (!contact) {
      logger.debug("get_contact: REST returned null, trying CardDAV");
      const cardDavContact = await cardDavClient.getContact(args.contact_id);
      if (cardDavContact) {
        // Map CardDAV contact format to REST format for consistency
        contact = {
          id: cardDavContact.id,
          name: cardDavContact.displayName,
          firstName: cardDavContact.firstName,
          lastName: cardDavContact.lastName,
          email: cardDavContact.emails[0]?.value,
          phone: cardDavContact.phones[0]?.value,
          organization: cardDavContact.organization,
        };
      }
    }

    if (!contact) {
      return {
        content: [{ type: "text", text: "Error: Contact not found" }],
        isError: true,
      };
    }

    logger.tool("get_contact", { contact_id: args.contact_id }, Date.now() - startTime);

    return {
      content: [{ type: "text", text: JSON.stringify(contact, null, 2) }],
    };
  } catch (error) {
    logger.error("get_contact failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleCreateContact(args: {
  name: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  organization?: string;
  notes?: string;
  addressbook_id?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const cardDavClient = getCardDavClient();
    // Use CardDAV for contact creation (REST API doesn't support it)
    const result = await cardDavClient.createContact({
      name: args.name,
      firstName: args.first_name,
      lastName: args.last_name,
      email: args.email,
      phone: args.phone,
      organization: args.organization,
      notes: args.notes,
      addressbookId: args.addressbook_id,
    });

    logger.tool("create_contact", { name: args.name }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              contactId: result.contactId,
              message: `Contact "${args.name}" created`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("create_contact failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleUpdateContact(args: {
  contact_id: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  organization?: string;
  notes?: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const cardDavClient = getCardDavClient();
    // Use CardDAV for contact updates (REST API doesn't support it)
    await cardDavClient.updateContact(args.contact_id, {
      name: args.name,
      firstName: args.first_name,
      lastName: args.last_name,
      email: args.email,
      phone: args.phone,
      organization: args.organization,
      notes: args.notes,
    });

    logger.tool("update_contact", { contact_id: args.contact_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: "Contact updated",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("update_contact failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}

export async function handleDeleteContact(args: {
  contact_id: string;
}): Promise<ToolResponse> {
  const startTime = Date.now();

  try {
    const cardDavClient = getCardDavClient();
    // Use CardDAV for contact deletion (REST API doesn't support it)
    await cardDavClient.deleteContact(args.contact_id);

    logger.tool("delete_contact", { contact_id: args.contact_id }, Date.now() - startTime);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              message: "Contact deleted",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    logger.error("delete_contact failed", { error: String(error) });
    return formatErrorResponse(error);
  }
}
