# Axigen REST API Reference

Axigen Mailbox REST API documentation (available since Axigen X4 / 10.4).

**Base URL**: `https://mail.example.com/api/v1`

## Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/login/cookie` | Login with session cookie |
| POST | `/logout` | Logout |

### Login Cookie
```bash
POST /api/v1/login/cookie
Content-Type: application/json

{
  "user": "email@domain.com",
  "pass": "password"
}
```

Response: Set-Cookie header with `sessid`. Use `?_h={sessid}` for subsequent requests.

---

## Account

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/account/info` | Account info (name, domain) |
| GET | `/account/contactinfo` | User contact info |
| PUT | `/account/contactinfo` | Update contact info |
| GET | `/account/aliases` | List permanent aliases |
| GET | `/account/temporaryaliases` | List temporary aliases |
| POST | `/account/temporaryaliases` | Create temporary alias |
| DELETE | `/account/temporaryaliases/{id}` | Delete temporary alias |
| GET | `/account/signatures` | List signatures |
| POST | `/account/signatures` | Create signature |
| GET | `/account/signatures/{id}` | Signature details |
| PUT | `/account/signatures/{id}` | Update signature |
| DELETE | `/account/signatures/{id}` | Delete signature |
| GET | `/account/avatar` | Get avatar |
| PUT | `/account/avatar` | Update avatar (multipart/form-data) |
| DELETE | `/account/avatar` | Delete avatar |
| GET | `/account/vacation` | Auto-reply settings |
| POST | `/account/vacation` | Configure vacation auto-reply |
| POST | `/account/password/set` | Set initial password |
| POST | `/account/password/reset` | Change password |
| GET | `/account/indexinfo` | Search index status |

---

## Account Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/account/settings` | Get settings |
| PATCH | `/account/settings` | Update settings |
| GET | `/account/settings/ui` | WebMail UI settings |
| POST | `/account/settings/ui` | Save UI settings (max 8192 bytes) |
| DELETE | `/account/settings/ui` | Reset UI settings |
| GET | `/account/settings/client` | Custom client settings |
| POST | `/account/settings/client` | Save client settings |
| DELETE | `/account/settings/client` | Reset client settings |

---

## Folders

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/folders/` | List folders |
| GET | `/folders/delta` | Incremental folder sync |
| POST | `/folders/` | Create folder |
| PATCH | `/folders/{folderId}` | Rename folder |
| DELETE | `/folders/{folderId}` | Delete folder |
| POST | `/folders/{folderId}/move` | Move folder |

### Parameters GET /folders/

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | String | `mails`, `events`, `tasks`, `notes`, `contacts` |
| `accessMode` | String | `local`, `public`, `shared`, `all` |
| `syncTokenOnly` | Boolean | Return sync token only |

### Create folder POST /folders/

```json
{
  "name": "My Folder",
  "type": "mails",
  "parentId": "414_1879"
}
```

---

## Mails - List and Details

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/mails` | List emails (folderId required) |
| GET | `/mails/{mailId}` | Email details |
| PATCH | `/mails/{mailId}` | Update flags (read/unread, flagged) |
| DELETE | `/mails/{mailId}` | Delete email |
| POST | `/mails/{mailId}/move` | Move email |
| POST | `/mails/{mailId}/copy` | Copy email |
| GET | `/mails/delta` | Incremental email sync |

### Parameters GET /mails

| Parameter | Type | Description |
|-----------|------|-------------|
| `folderId` | String | **Required** - Folder ID |
| `sort` | String | Sort field |
| `dir` | String | `ASC` or `DESC` |
| `start` | Number | Start position (pagination) |
| `limit` | Number | Max number of items |
| `activeMailId` | String | Active email ID |
| `syncTokenOnly` | Boolean | Sync token only |

### Update flags PATCH /mails/{mailId}

```json
{
  "isUnread": false,
  "isFlagged": true
}
```

---

## Mails - Body and Content

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/mails/{mailId}/body` | Message body |
| GET | `/mails/{mailId}/body/full` | Full body (if truncated) |
| GET | `/mails/{mailId}/parts` | MIME structure |
| GET | `/mails/{mailId}/parts/details` | MIME part details |
| GET | `/mails/{mailId}/parts/{partId}/details/full` | Full part content |
| GET | `/mails/{mailId}/source` | Raw email source |
| GET | `/mails/{mailId}/source/download` | Download .eml |
| GET | `/mails/{mailId}/source/headers` | Headers only |

### Parameters GET /mails/{mailId}/body

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | String | `text` or `html` |
| `showExternalImages` | Boolean | Show external images |

---

## Mails - Attachments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/mails/{mailId}/attachments` | List attachments |
| GET | `/mails/{mailId}/attachments/download` | Download all (ZIP) |
| GET | `/mails/{mailId}/attachments/{id}` | Get attachment |
| GET | `/mails/{mailId}/attachments/{id}/download` | Download attachment |
| GET | `/mails/{mailId}/attachments/{id}/thumbnail` | Image thumbnail |
| GET | `/mails/{mailId}/attachments/{id}/eml` | Attached RFC822 message |

---

## Mails - Labels and Spam

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/mails/{mailId}/labels` | Add label |
| DELETE | `/mails/{mailId}/labels/{labelId}` | Remove label |
| POST | `/mails/{mailId}/spam` | Mark as spam |
| POST | `/mails/{mailId}/notspam` | Mark as not spam |

---

## Mails - Compose and Send

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/mails` | Create draft |
| PUT | `/drafts/{mailId}` | Replace draft |
| POST | `/mails/send` | Send new email |
| POST | `/drafts/{mailId}/send` | Send draft |
| POST | `/mails/send/undo` | Undo send (10 sec) |
| POST | `/mails/send/schedule` | Schedule send |
| POST | `/drafts/{mailId}/send/schedule` | Schedule draft |
| DELETE | `/mails/send/schedule/{mailId}` | Cancel scheduled send |

### Create email POST /mails

```json
{
  "to": [{"email": "dest@example.com", "name": "Recipient"}],
  "cc": [],
  "bcc": [],
  "subject": "Subject",
  "body": "Text content",
  "bodyHtml": "<p>HTML content</p>",
  "attachments": ["temporaryAttachmentId1"],
  "folderId": "414_1782"
}
```

### Send email POST /mails/send

```json
{
  "to": [{"email": "dest@example.com"}],
  "subject": "Subject",
  "body": "Content"
}
```

### Schedule send

```json
{
  "deliveryTime": 1705680000
}
```

---

## Temporary Attachments

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/temporaryAttachments` | Upload attachment |
| GET | `/temporaryAttachments/{id}` | Get attachment |
| DELETE | `/temporaryAttachments/{id}` | Delete attachment |
| POST | `/temporaryAttachments/store` | Store from existing email |

---

## Mails Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/mails/search` | Full-text search |

### Request Body

```json
{
  "folderIds": ["414_1879"],
  "query": [
    {"field": "subject", "value": "invoice"},
    {"field": "from", "value": "client@example.com"}
  ],
  "recursive": true
}
```

### Searchable Fields

| Field | Description |
|-------|-------------|
| `from` | Sender |
| `to` | Recipient |
| `cc` | Carbon copy |
| `bcc` | Blind carbon copy |
| `subject` | Subject |
| `body` | Message body |
| `anyfield` | All fields |
| `before` | Before date (dd-mm-yyyy) |
| `after` | After date (dd-mm-yyyy) |
| `hasatt` | Has attachments |
| `unread` | Unread (value: "true") |
| `flag` | Flag - values: `followup` (starred), `completed` |
| `importance` | Importance |
| `label` | Label |
| `smaller` | Size < (B, K, M) |
| `larger` | Size > (B, K, M) |

### Response

```json
{
  "folderId": "search_temp_folder_id",
  "totalItems": 42
}
```

---

## Contacts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/contacts/` | List contacts |
| GET | `/contacts/autocomplete` | Autocomplete search |
| GET | `/contacts/{contactId}` | Contact details |
| POST | `/contacts/` | Create contact |
| PATCH | `/contacts/{contactId}` | Update contact |
| DELETE | `/contacts/{contactId}` | Delete contact |
| POST | `/contacts/avatars/search` | Avatar search |
| GET | `/contacts/delta` | Incremental contact sync |

### Parameters GET /contacts/

| Parameter | Type | Description |
|-----------|------|-------------|
| `folderId` | String | Contacts folder ID (optional) |
| `sort` | String | `name` or `email` |
| `dir` | String | `ASC` or `DESC` |
| `start` | Number | Start position |
| `limit` | Number | Max results |
| `syncTokenOnly` | Boolean | Sync token only |

### Autocomplete GET /contacts/autocomplete

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | String | **Required** - Search term |
| `limit` | Number | 1-50 results (default: 10) |

### Create contact POST /contacts/

```json
{
  "name": "John Doe",
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "phone": "+41791234567",
  "organization": "ACME Corp",
  "notes": "Important client",
  "folderId": "414_1835"
}
```

---

## Labels

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/labels` | List labels |
| POST | `/labels` | Create label |
| GET | `/labels/{labelId}` | Label details |
| PUT | `/labels/{labelId}` | Update label |
| DELETE | `/labels/{labelId}` | Delete label |

---

## Conversations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/conversations` | List conversations |
| GET | `/conversations/{id}` | Conversation details |

---

## Batch Operations

Batch operations to process multiple emails in a single request.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/batch/mails/delete` | Delete multiple emails |
| POST | `/batch/mails/move` | Move multiple emails |
| POST | `/batch/mails/update` | Update flags (read/unread, flagged) |
| POST | `/batch/mails/copy` | Copy multiple emails |
| POST | `/batch/mails/labels/add` | Add label to multiple emails |
| POST | `/batch/mails/labels/remove` | Remove label from multiple emails |

### Request Format

```json
{
  "ids": ["mailId1", "mailId2", "mailId3"],
  "destinationFolderId": "414_1880",  // for move/copy
  "isUnread": false,                   // for update
  "isFlagged": true                    // for update
}
```

### Response Format

**Synchronous** (small batches):
```json
{
  "status": "completed",
  "progress": 100,
  "failedItems": []
}
```

**Asynchronous** (large batches):
```json
{
  "status": "inProgress",
  "progress": 45,
  "jobKey": "abc123"
}
```

---

## Not Supported by REST API

The following features are **NOT** available via the REST API and require CalDAV/CardDAV:

| Feature | Protocol | URL |
|---------|----------|-----|
| **Calendar/Events** | CalDAV | `https://mail.example.com/caldav/{user}/` |
| **Tasks** | CalDAV | `https://mail.example.com/caldav/{user}/` |
| **Notes/Journal** | Not available | - |

---

## HTTP Error Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request |
| 401 | Unauthenticated |
| 403 | Forbidden |
| 404 | Not Found |
| 409 | Conflict |
| 500 | Server Error |

### Error Format

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Error description"
  }
}
```

---

## Important Notes

1. **Encoding**: UTF-8 only, no automatic conversion
2. **Session**: Session cookie + `?_h={sessid}` for every request
3. **Pagination**: Use `start` and `limit` for large lists
4. **Sync**: Use `/delta` endpoints with `syncToken` for incremental synchronization
5. **Special folders**: inbox, drafts, sent, trash, junk are immutable

---

## Sources

- [Mailbox API REST Documentation](https://www.axigen.com/documentation/mailbox-api-rest-documentation-p666927108)
- [Mailbox API - Folders](https://www.axigen.com/documentation/mailbox-api-folders-p666829029)
- [Mailbox API - Mails](https://www.axigen.com/documentation/mailbox-api-mails-p666992807)
- [Mailbox API - Mails Search](https://www.axigen.com/documentation/mailbox-api-mails-search-p666992858)
- [Mailbox API - Contacts](https://www.axigen.com/documentation/mailbox-api-contacts-p666960100)
- [Mailbox API - Account](https://www.axigen.com/documentation/mailbox-api-account-p666828978)
- [Mailbox API - Account Settings](https://www.axigen.com/documentation/mailbox-api-account-settings-p891191397)
