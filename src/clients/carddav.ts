import { DAVClient, DAVAddressBook, DAVObject } from "tsdav";
import { config, getCardDavUrl, getBaseUrl } from "../config.js";
import { logger } from "../utils/logger.js";
import type { AddressBook, Contact } from "../types/axigen.js";
import type { UserCredentials } from "../types/user-context.js";
import { getUserCardDavUrl } from "../types/user-context.js";

export class CardDavClient {
  private client: DAVClient;
  private initialized = false;
  private userCredentials: UserCredentials | null = null;
  private userEmail: string;

  /**
   * Create a new CardDAV client
   * @param credentials - Optional user credentials for multi-user mode.
   *                      If not provided, uses config.axigen credentials (single-user mode)
   */
  constructor(credentials?: UserCredentials) {
    this.userCredentials = credentials || null;

    // Use user credentials if provided, otherwise fall back to config
    const username = this.userCredentials?.email || config.axigen.username;
    const password = this.userCredentials?.password || config.axigen.password;
    this.userEmail = username;

    // Build CardDAV URL based on user
    const cardDavUrl = this.userCredentials
      ? getUserCardDavUrl(getBaseUrl(), this.userCredentials.email)
      : getCardDavUrl();

    this.client = new DAVClient({
      serverUrl: cardDavUrl,
      credentials: {
        username,
        password,
      },
      authMethod: "Basic",
      defaultAccountType: "carddav",
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.client.login();
      this.initialized = true;
      logger.debug("CardDAV client initialized");
    }
  }

  // ==================== Address Books ====================

  async listAddressBooks(): Promise<AddressBook[]> {
    await this.ensureInitialized();

    try {
      const addressBooks = await this.client.fetchAddressBooks();

      // Handle case where fetchAddressBooks returns undefined or non-array
      if (!addressBooks || !Array.isArray(addressBooks)) {
        logger.debug("fetchAddressBooks returned non-array", { result: typeof addressBooks });
        return [];
      }

      return addressBooks.map((ab: DAVAddressBook) => ({
        id: ab.url,
        name: ab.displayName || "Contacts",
        description: ab.description,
      }));
    } catch (error) {
      logger.error("CardDAV fetchAddressBooks error", {
        error: String(error),
        serverUrl: getCardDavUrl()
      });
      throw error;
    }
  }

  async getDefaultAddressBook(): Promise<DAVAddressBook | undefined> {
    await this.ensureInitialized();
    try {
      const addressBooks = await this.client.fetchAddressBooks();
      if (addressBooks && Array.isArray(addressBooks) && addressBooks.length > 0) {
        return addressBooks[0];
      }
    } catch (error) {
      logger.debug("fetchAddressBooks failed, using default Axigen path", { error: String(error) });
    }
    // Fallback: Use default Axigen CardDAV path
    // Axigen uses /Contacts/Contacts/ as the default contacts collection
    return { url: `${getBaseUrl()}/Contacts/Contacts/` } as DAVAddressBook;
  }

  // ==================== Contacts ====================

  async listContacts(addressbookId?: string, limit?: number): Promise<Contact[]> {
    await this.ensureInitialized();

    let addressBooks: DAVAddressBook[];
    if (addressbookId) {
      addressBooks = [{ url: addressbookId } as DAVAddressBook];
    } else {
      const fetched = await this.client.fetchAddressBooks();
      addressBooks = Array.isArray(fetched) ? fetched : [];
    }

    const contacts: Contact[] = [];

    for (const addressBook of addressBooks) {
      const vcards = await this.client.fetchVCards({
        addressBook,
      });

      for (const vcard of vcards) {
        const parsed = this.parseVCard(vcard, addressBook.url);
        if (parsed) {
          contacts.push(parsed);
        }
        if (limit && contacts.length >= limit) {
          return contacts;
        }
      }
    }

    return contacts;
  }

  async searchContacts(params: {
    query?: string;
    name?: string;
    email?: string;
    phone?: string;
    limit?: number;
  }): Promise<Contact[]> {
    await this.ensureInitialized();

    // Get all contacts and filter locally
    // (CardDAV REPORT searches are complex to implement properly)
    const allContacts = await this.listContacts(undefined, 500);
    const { query, name, email, phone, limit = 20 } = params;

    const filtered = allContacts.filter((contact) => {
      const searchText = [
        contact.displayName,
        contact.firstName,
        contact.lastName,
        ...contact.emails.map((e) => e.value),
        ...contact.phones.map((p) => p.value),
        contact.organization,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (query && !searchText.includes(query.toLowerCase())) {
        return false;
      }
      if (name) {
        const nameText = [contact.displayName, contact.firstName, contact.lastName]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!nameText.includes(name.toLowerCase())) {
          return false;
        }
      }
      if (email) {
        const hasEmail = contact.emails.some((e) =>
          e.value.toLowerCase().includes(email.toLowerCase())
        );
        if (!hasEmail) {
          return false;
        }
      }
      if (phone) {
        const hasPhone = contact.phones.some((p) =>
          p.value.replace(/\D/g, "").includes(phone.replace(/\D/g, ""))
        );
        if (!hasPhone) {
          return false;
        }
      }

      return true;
    });

    return filtered.slice(0, limit);
  }

  async getContact(contactId: string): Promise<Contact | null> {
    await this.ensureInitialized();

    // Use getDefaultAddressBook which has fallback for Axigen
    const addressBook = await this.getDefaultAddressBook();
    if (!addressBook) {
      return null;
    }

    try {
      const vcards = await this.client.fetchVCards({
        addressBook: addressBook as DAVAddressBook,
      });

      const vcard = vcards.find(
        (v: DAVObject) => v.url === contactId || v.etag === contactId || v.url?.includes(contactId)
      );
      if (vcard) {
        return this.parseVCard(vcard, addressBook.url);
      }
    } catch (error) {
      logger.debug("CardDAV getContact failed", { error: String(error) });
    }

    return null;
  }

  async createContact(contact: {
    name: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    organization?: string;
    notes?: string;
    addressbookId?: string;
  }): Promise<{ contactId: string }> {
    await this.ensureInitialized();

    const addressBook = contact.addressbookId
      ? { url: contact.addressbookId }
      : await this.getDefaultAddressBook();

    if (!addressBook) {
      throw new Error("No address book found");
    }

    const uid = this.generateUid();
    const vcardData = this.buildVCard(uid, contact);
    const filename = `${uid}.vcf`;

    await this.client.createVCard({
      addressBook: addressBook as DAVAddressBook,
      filename,
      vCardString: vcardData,
    });

    // Return the full URL path for the contact (used by update/delete)
    const contactUrl = `${addressBook.url}${filename}`;
    logger.debug("Contact created", { uid, contactUrl });

    return { contactId: contactUrl };
  }

  async updateContact(
    contactId: string,
    updates: {
      name?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      organization?: string;
      notes?: string;
    }
  ): Promise<void> {
    await this.ensureInitialized();

    const existingContact = await this.getContact(contactId);
    if (!existingContact) {
      throw new Error("Contact not found");
    }

    const mergedContact = {
      name: updates.name || existingContact.displayName,
      firstName: updates.firstName ?? existingContact.firstName,
      lastName: updates.lastName ?? existingContact.lastName,
      email: updates.email ?? existingContact.emails[0]?.value,
      phone: updates.phone ?? existingContact.phones[0]?.value,
      organization: updates.organization ?? existingContact.organization,
      notes: updates.notes ?? existingContact.notes,
    };

    const vcardData = this.buildVCard(existingContact.uid, mergedContact);

    // Use the full URL from the existing contact (id field is the URL)
    const contactUrl = existingContact.id;
    logger.debug("Updating contact", { contactId, contactUrl });

    await this.client.updateVCard({
      vCard: {
        url: contactUrl,
        data: vcardData,
      },
    });
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.ensureInitialized();

    // If contactId is not a full URL, try to find the contact first to get its URL
    let contactUrl = contactId;
    if (!contactId.startsWith("http")) {
      const existingContact = await this.getContact(contactId);
      if (!existingContact) {
        throw new Error("Contact not found");
      }
      contactUrl = existingContact.id;
    }

    logger.debug("Deleting contact", { contactId, contactUrl });

    await this.client.deleteVCard({
      vCard: {
        url: contactUrl,
      },
    });
  }

  // ==================== Helpers ====================

  private generateUid(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}@mcp-axigen`;
  }

  private parseVCard(obj: DAVObject, addressbookId: string): Contact | null {
    const data = obj.data;
    if (!data || !data.includes("VCARD")) {
      return null;
    }

    const getField = (field: string): string | undefined => {
      const regex = new RegExp(`${field}[^:]*:(.+)`, "im");
      const match = data.match(regex);
      return match?.[1]?.trim();
    };

    const getAllFields = (field: string): Array<{ type?: string; value: string }> => {
      const regex = new RegExp(`${field}(?:;TYPE=([^:;]+))?[^:]*:(.+)`, "gim");
      const results: Array<{ type?: string; value: string }> = [];
      let match;
      while ((match = regex.exec(data)) !== null) {
        results.push({
          type: match[1]?.toLowerCase(),
          value: match[2].trim(),
        });
      }
      return results;
    };

    const uid = getField("UID") || obj.url;
    const fn = getField("FN") || "Unknown";
    const n = getField("N");
    const org = getField("ORG");
    const title = getField("TITLE");
    const note = getField("NOTE");

    let firstName: string | undefined;
    let lastName: string | undefined;
    if (n) {
      const parts = n.split(";");
      lastName = parts[0] || undefined;
      firstName = parts[1] || undefined;
    }

    const emails = getAllFields("EMAIL");
    const phones = getAllFields("TEL");

    return {
      id: obj.url,
      uid,
      displayName: fn,
      firstName,
      lastName,
      emails,
      phones,
      addresses: [], // TODO: Parse ADR fields
      organization: org,
      title,
      notes: note,
      addressbookId,
    };
  }

  private buildVCard(
    uid: string,
    contact: {
      name: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      organization?: string;
      notes?: string;
    }
  ): string {
    const lines = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `UID:${uid}`,
      `FN:${contact.name}`,
    ];

    if (contact.firstName || contact.lastName) {
      lines.push(`N:${contact.lastName || ""};${contact.firstName || ""};;;`);
    }

    if (contact.email) {
      lines.push(`EMAIL;TYPE=INTERNET:${contact.email}`);
    }

    if (contact.phone) {
      lines.push(`TEL;TYPE=CELL:${contact.phone}`);
    }

    if (contact.organization) {
      lines.push(`ORG:${contact.organization}`);
    }

    if (contact.notes) {
      lines.push(`NOTE:${contact.notes}`);
    }

    lines.push(`REV:${new Date().toISOString()}`);
    lines.push("END:VCARD");

    return lines.join("\r\n");
  }
}
