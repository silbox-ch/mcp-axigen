# Changelog

All notable changes to MCP Axigen are documented here.

## [2.2.0] - 2026-01-22

### Added
- **Persistent OAuth Tokens**: Tokens survive server restarts (AES-256-GCM encrypted storage)
- Automatic hourly cleanup of expired tokens

### Changed
- Access token lifetime: 1 hour → **7 days**
- Refresh token lifetime: 1 hour → **30 days**
- Claude.ai can use `refresh_token` grant to extend sessions automatically

## [1.9.1] - 2026-01-21

### Added
- **get_server_info tool**: Returns server version, mode, capabilities, tool count

## [1.9.0] - 2026-01-21

### Added
- **Notes CRUD via IMAP**: Full support for Axigen Notes stored in the hidden "Notes" folder
  - `list_notes`, `get_note`, `search_notes`, `create_note`, `update_note`, `delete_note`
  - Notes stored as IMAP messages with `X-MAPI-Message-Class: IPM.StickyNote`

## [1.8.0] - 2026-01-20

### Added
- **MCP OAuth 2.0**: Native OAuth support for Claude.ai per MCP spec (2025-11-25)
  - RFC 9728 Protected Resource Metadata
  - RFC 8414 Authorization Server Metadata
  - RFC 7591 Dynamic Client Registration (required by Claude.ai)
  - PKCE (S256) authorization flow
  - 401 challenge with `WWW-Authenticate: Bearer` header

## [1.7.0] - 2026-01-20

### Added
- **Multi-user MCP**: OAuth sessions linked to MCP tool calls
  - Per-user credentials via AsyncLocalStorage
  - Client factories for REST, IMAP, CalDAV, CardDAV

### Changed
- Replaced `openid-client` with `oauth4webapi` for better OIDC compatibility

## [1.6.0] - 2026-01-20

### Added
- **OAuth2/OIDC Multi-user Support**
  - Generic OIDC client (Cloudron, Keycloak, Auth0, Okta, Azure AD, etc.)
  - Encrypted credential storage (AES-256-GCM)
  - Session management with 24h expiry
  - Account linking flow

## [1.5.5] - 2026-01-20

### Added
- **VTIMEZONE support**: Events include proper timezone blocks (STANDARD/DAYLIGHT DST rules)
  - Supported: Europe/Zurich, Paris, Berlin, London, Bucharest

## [1.5.4] - 2026-01-20

### Fixed
- CalDAV task/event creation migrated to `tsdav.createCalendarObject()`
- Fixed 403 Forbidden on task creation with `due_date`

## [1.5.0] - 2026-01-19

### Fixed
- Tasks now created in correct `/Calendar/Tasks/` collection
- Event IDs now return real server ID (captures `Location` header)
- Contacts CRUD migrated to CardDAV for mutations

## [1.4.3] - 2026-01-19

### Added
- Advanced search filters: `cc`, `bcc`, `body`, `smaller_than`, `larger_than`, `importance`, `label`

## [1.4.2] - 2026-01-19

### Changed
- `search_emails` migrated from IMAP to REST API (`POST /mails/search`)

## [1.4.0] - 2026-01-19

### Added
- `copy_email`, `list_labels`, `create_label`, `delete_label`
- `schedule_email`, `undo_send`

## [1.3.0] - 2026-01-19

### Added
- `mark_flagged`, `mark_flagged_bulk`, `mark_spam`
- `create_folder`, `delete_folder`, `rename_folder`
- `get_vacation`, `set_vacation`

## [1.2.0] - 2026-01-19

### Added
- Bulk operations: `delete_emails_bulk`, `move_emails_bulk`, `mark_read_bulk`

## [1.1.0] - 2026-01-18

### Added
- IMAP full-text search with FROM, TO, SUBJECT, date filters
- RFC 2047 header decoding

### Fixed
- Contacts migrated from CardDAV to REST API
- Calendar event ID resolution
- iCal date parsing with TZID support
- Email body base64 decoding

## [1.0.0] - 2026-01-17

### Added
- Initial MCP server for Axigen
- 47 MCP tools: email, contacts, calendar, tasks, notes, labels, folders, vacation
- Protocols: REST API, IMAP, CalDAV, CardDAV
- Single-user and multi-user (OAuth/OIDC) modes
- SSE transport for web deployment (Claude.ai, ChatGPT, Gemini)
