# Generic Exploratory QA Agent

A project-agnostic exploratory testing agent with an interactive UI. Explore any web application for edge cases, chaos scenarios, API issues, and regression.

## Features

- **Chat-based setup** — describe the target site, login and scope in a chat; the agent plans the run
- **Generic baseline protocol** — works out of the box for any public site
- **Chaos testing** — back button mid-POST, offline recovery, double-submit on slow network
- **Live findings** — WebSocket stream with severity-tagged results
- **Readable reports** — every finding has a plain-English headline, "what's wrong", "why it matters" and repro steps, with technical details underneath; export as Markdown or HTML
- **Claude Code skill** — run exploratory QA from Claude Code

## Quick Start

```bash
# Install, build, and install Playwright
npm run setup

# Start API + Web UI (builds the packages first, so code changes are always picked up)
npm run dev
```

- **Web UI:** http://localhost:5173
- **API:** http://localhost:3001

## Usage

1. Open http://localhost:5173
2. Click **Start with Chat**
3. In the chat, give the target URL (e.g. `https://example.com`), then answer the agent's questions (login, sections to test, depth)
4. Watch live findings stream in
5. Open **View Report** when the run completes, and export it as Markdown or HTML

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
│   ├── shared/       # Types, constants, finding ordering and plain-English explanations
│   ├── chat-agent/   # Setup / live / findings chat
│   ├── agent-core/   # Planner, orchestrator, reporter
│   ├── explorer-ui/  # Playwright UI executor
│   ├── explorer-api/ # HTTP API executor
│   └── chaos-engine/ # Network chaos executor
├── knowledge-base/   # Per-site-category notes the agent builds up
├── scripts/          # Setup, CI runner, consistency checks
├── docs/             # Architecture doc and overview deck
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
GEMINI_API_KEY=          # Optional — or OPENAI_API_KEY / ANTHROPIC_API_KEY; enables AI review, classification and report summaries
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run setup` | Install deps, build, install Playwright |
| `npm run dev` | Build the packages, then start API + Web UI |
| `npm run dev:api` | API only (run `npm run build:packages` first after changing package code) |
| `npm run dev:web` | Web UI only |
| `npm run build` | Build everything, in dependency order |
| `npm run build:packages` | Build only the `packages/*` libraries |
| `npm run clean` | Delete build output (`dist/`) |
| `npm run matrix:check` | Check the exploration matrix matches the code |
| `npm run patterns:check` | Check the non-bug patterns list is in sync |
| `npm run ci:run` | Run one exploration headlessly (used by CI) |

## License

MIT
