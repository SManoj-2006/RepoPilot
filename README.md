# RepoPilot 🛰️

**Talk to your GitHub repos.** RepoPilot is a self-hosted
[MCP](https://modelcontextprotocol.io) server that lets **Alexa+** answer
questions about your GitHub repositories — and take actions on them — by
voice. It ships with a small **simulated Alexa+ web chat** so you can see the
MCP server working end-to-end without any extra hardware.

> Built for the **Amazon Developer Hackathon — Alexa+ track** (with the
> simulated-experience path the track explicitly allows), using the Model
> Context Protocol **Streamable HTTP** transport (spec 2025-11-25).

*"Alexa, what's failing in my repos?"* → RepoPilot checks CI across your
recently updated repos and answers out loud. *"Open an issue in my app:
the build is broken"* → it files the issue and confirms the number.

## Architecture

```
            voice / text
                 │
   ┌─────────────▼──────────────┐        ┌────────────────────────────┐
   │  Alexa+ (real deployment)  │        │  Simulator web UI (demo)   │
   │  or any MCP client         │        │  simulator/  (Vite+React)  │
   └─────────────┬──────────────┘        └──────────────┬─────────────┘
                 │  MCP / Streamable HTTP             │ POST /chat
                 │                                    │ (NL layer: Groq
                 ▼                                    │  tool-calling, or
   ┌──────────────────────────────────────────────┐  │  intent fallback)
   │  RepoPilot server  (server/, Express)        │◄─┘
   │  POST /mcp  — MCP endpoint (6 GitHub tools)  │
   │  POST /chat — agent endpoint (itself an      │
   │               MCP client of /mcp)            │
   └──────────────────────┬───────────────────────┘
                          │ GitHub REST API (token from env)
                          ▼
                     api.github.com
```

The `/chat` endpoint is deliberately *just another MCP client*: it connects
to `/mcp` with the official SDK client, lists the tools, and calls them —
exactly what Alexa+ does in the real deployment. Nothing in the demo bypasses
the protocol.

## MCP tools

| Tool | What it does |
| --- | --- |
| `list_repos` | The authenticated user's repos, most recently updated first |
| `list_pull_requests` | Open PRs for `owner/repo`, with CI status of each PR head |
| `get_ci_status` | Latest GitHub Actions runs (+ combined status for a branch) |
| `list_issues` | Open issues for `owner/repo` (PRs excluded) |
| `create_issue` | **Write action:** file a new issue — the "by voice" proof |
| `get_repo_summary` | One-call briefing: open PRs, open issues, latest CI, recent activity |

All inputs are validated with zod; every tool returns a clear, spoken-friendly
error instead of crashing (e.g. when `GITHUB_TOKEN` is missing).

## Setup

Prerequisites: Node.js 20+ and a GitHub account.

```bash
git clone <this repo> && cd repopilot
npm install

# Configure secrets (never commit this file)
cp server/.env.example server/.env
#   GITHUB_TOKEN  — GitHub PAT. Classic `repo` scope, or fine-grained with
#                   repo read + Issues read/write (needed for create_issue).
#   GROQ_API_KEY  — optional. Powers the /chat natural-language layer
#                   (llama-3.3-70b-versatile). Without it, /chat uses a
#                   built-in intent router and the demo still works.
```

## Run

```bash
npm run build        # compile server (tsc) + simulator (vite build)

# Terminal 1 — MCP server on http://localhost:3001
npm start

# Terminal 2 — simulator UI on http://localhost:5173
npm run dev:sim
```

Or develop with hot reload: `npm run dev:server` (tsx watch) + `npm run dev:sim`.

Endpoints: `POST /mcp` (MCP), `POST /chat` (`{"message": "..."}`),
`GET /health` (shows which integrations are configured — booleans only).

### Connect a real MCP client

Point any MCP client at `http://localhost:3001/mcp` (Streamable HTTP). To
verify by hand:

```bash
npm start          # terminal 1
npm run smoke      # terminal 2 — connects as an MCP client, lists tools,
                   # and exercises a real tool call
```

For Alexa+: register the same `/mcp` URL as a self-hosted MCP server /
Agent Skill endpoint (spec 2025-11-25+, Streamable HTTP) in the Alexa
developer console — the server in `server/src/mcpServer.ts` is the entry
point Alexa+ calls.

## Demo script (under 3 minutes)

1. **Cold open (voice):** "Alexa, what's failing in my repos?" — simulator:
   type the same. RepoPilot scans CI across your top repos and answers.
2. **Drill in:** "Summarise `owner/repo`" → open PRs, open issues, latest CI,
   recent activity in one spoken briefing.
3. **Take action:** "Open an issue in `owner/repo`: CI is red on main" →
   the issue is created live on GitHub; RepoPilot confirms its number.
   Switch to the GitHub tab and show it.
4. **Close:** "What PRs are open in `owner/repo`?" → PR list with authors
   and CI state. Point out this is a standard MCP server — the same endpoint
   Alexa+ connects to, no demo-only shortcuts.

## Project layout

```
server/      MCP server + /chat agent endpoint (TypeScript, Express, zod)
  src/
    index.ts      Express app: /mcp (Streamable HTTP), /chat, /health
    mcpServer.ts  The 6 MCP tools (the Alexa+ entry point)
    github.ts     GitHub REST client (fetch, token from env)
    chat.ts       NL layer: Groq tool-calling + intent-routing fallback
  scripts/smoke.mjs  MCP client smoke test
simulator/   Vite + React simulated Alexa+ chat UI (proxies /api → server)
```

## Notes

- Stateless Streamable HTTP (fresh server per request) keeps the demo simple
  to self-host; the protocol surface is the standard one.
- Secrets are read from the environment only — `.env` is git-ignored and no
  key is ever hardcoded.
- License: MIT (see `LICENSE`) — this repo doubles as the Open Source
  mini-challenge entry.
