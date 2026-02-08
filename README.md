# mcp-axigen

MCP (Model Context Protocol) server for [Axigen](https://www.axigen.com/) mail server integration.

Built by [Julien Frère](https://silbox.ch) + AI · [Silbox](https://github.com/silbox-ch)

## Overview

This project provides a bridge between LLMs (Claude, ChatGPT, Gemini) and Axigen mail server, enabling AI-powered email, calendar, contacts, and tasks management via the MCP protocol.

## Features

- **Email** (REST API + IMAP): List, search, send, reply, forward, move, delete, bulk operations
- **Calendar** (CalDAV): List, create, update, delete events with timezone support
- **Contacts** (REST + CardDAV): List, search, create, update, delete contacts
- **Tasks** (CalDAV VTODO): List, create, update, complete, delete tasks
- **Notes** (IMAP): List, search, create, update, delete notes
- **Labels, Folders, Vacation**: Full mailbox management
- **OAuth2/OIDC**: Multi-user support with any OIDC provider (Cloudron, Keycloak, Auth0, etc.)

**47 MCP tools** in total.

## Quick Start

```bash
git clone https://github.com/silbox-ch/mcp-axigen.git
cd mcp-axigen
npm install
cp .env.example .env  # Configure your Axigen credentials
npm run build
npm start
```

## Configuration

See `.env.example` for all available options. Minimal setup:

```env
AXIGEN_HOST=mail.example.com
AXIGEN_PORT=443
AXIGEN_USERNAME=user@example.com
AXIGEN_PASSWORD=your-password
MCP_MODE=stdio
```

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "axigen": {
      "command": "node",
      "args": ["/path/to/mcp-axigen/dist/index.js"],
      "env": {
        "AXIGEN_HOST": "mail.example.com",
        "AXIGEN_USERNAME": "user@example.com",
        "AXIGEN_PASSWORD": "your-password"
      }
    }
  }
}
```

## Usage with Claude.ai (Remote MCP)

Deploy the server with `MCP_MODE=sse`, then add the public URL in Claude.ai settings:

```
https://your-server.example.com/mcp
```

The server supports MCP OAuth 2.0 for secure multi-user authentication.

## Architecture

```
Client (Claude/ChatGPT) --> https://your-server.com/mcp
                                    |
                                Reverse Proxy (Caddy/nginx)
                                    |
                              Node.js:3000
                                    |
                    +---------------+---------------+
                    |               |               |
               REST API          IMAP          CalDAV
               (emails,        (search,       (calendar,
               contacts,        notes)         tasks)
               folders)
```

## Documentation

- `AXIGEN-API.md` - Axigen REST API reference
- `CHANGELOG.md` - Version history
- `.env.example` - All configuration options

## License

AGPL-3.0 - See [LICENSE](LICENSE) for details.
