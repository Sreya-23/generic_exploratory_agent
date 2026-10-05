# Generic Exploratory QA Agent

A project-agnostic exploratory testing agent with an interactive UI. Explore any web application for edge cases, chaos scenarios, API issues, and regression.

## Features

- **Interactive UI** — configure target URL, pick exploration areas
- **Generic baseline protocol** — works out of the box for any public site
- **Chaos testing** — back button mid-POST, offline recovery, double-submit on slow network
- **Live findings** — WebSocket stream with severity-tagged results
- **Export reports** — Markdown and HTML
- **Cursor skill** — run exploratory QA inside Cursor IDE

## Quick Start

```bash
# Install, build, and install Playwright
npm run setup

# Start API + Web UI
npm run dev
```

- **Web UI:** http://localhost:5173
- **API:** http://localhost:3001

## Usage

1. Open http://localhost:5173
2. Click **Start New Exploration**
3. Enter target URL (e.g. `https://example.com`)
4. Optionally add context, credentials
5. Select exploration areas and depth
6. Watch live findings stream in
7. Export report when complete

### Credentials

| Site type | What you need |
|-----------|---------------|
| Public site | URL only |
| Login required | Test username + password |
| API testing | API key or bearer token (optional) |

No API tokens are required for the agent platform itself when running locally.

## Project Structure

```
generic_exploratory_agent/
├── apps/
│   ├── api/          # Fastify backend + WebSocket
│   └── web/          # React UI
├── packages/
│   ├── shared/       # Types and constants
│   ├── agent-core/   # Planner, orchestrator, reporter
│   ├── explorer-ui/  # Playwright UI executor
│   ├── explorer-api/ # HTTP API executor
│   └── chaos-engine/ # Network chaos executor
├── .claude/skills/   # Claude Code skill
└── sessions/         # Runtime output (gitignored)
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/meta` | Exploration areas and depths |
| POST | `/api/sessions` | Create session |
| POST | `/api/sessions/:id/start` | Start exploration |
| POST | `/api/sessions/:id/pause` | Pause session |
| GET | `/api/sessions/:id` | Get session state |
| GET | `/api/sessions/:id/report?format=md\|html\|json` | Export report |
| WS | `/api/sessions/:id/ws` | Live event stream |

## Claude Code Skill

Invocable in Claude Code (`/generic-exploratory-qa`) for generic exploratory testing:

```
.claude/skills/generic-exploratory-qa/SKILL.md
```

## Environment Variables

Copy `.env.example` to `.env`:

```bash
API_PORT=3001
SESSIONS_DIR=./sessions
CURSOR_API_KEY=          # Optional, for future SDK integration
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run setup` | Install deps, build, install Playwright |
| `npm run dev` | Start API + Web UI |
| `npm run dev:api` | API only |
| `npm run dev:web` | Web UI only |
| `npm run build` | Build all packages |

## License

MIT
