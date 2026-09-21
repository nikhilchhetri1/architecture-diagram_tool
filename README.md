# Architecture Diagram MCP Server & Agent

A self-contained, read-only GitHub MCP server + Copilot agent for generating **evidence-grounded, current-state
architecture diagrams** of individual rentacenter modules (e.g. Agreement, Customer, Payment). Modeled on the
`github-mcp-server` RCA agent setup in this workspace, but scoped entirely to architecture diagram generation —
all instructions, prompts, and the MCP server live in this folder only.

## What this is

- `server.js` — a Node MCP server exposing read-only GitHub tools (search code, clone-and-grep, list commits,
  diff a commit, find feature flags/API calls/error messages, resolve module→repo, etc.). Hard server-side
  guard blocks any non-GET/HEAD GitHub request.
- `.github/agents/architecture-diagram.agent.md` — the specialist agent persona: evidence bar, anti-hallucination
  rules, layer/design conventions, rendering/validation checklist, deliverable format.
- `.github/prompts/*.prompt.md` — slash commands:
  - `/generate-architecture-diagram` — full evidence → diagram → deliverables workflow for one module.
  - `/update-architecture-diagram` — refresh an existing diagram after code changes.
  - `/list-modules` — discover the correct repo(s) for a module keyword.
  - `/render-diagram` — render an `.mmd` to SVG/PNG locally and run the visual validation checklist.
- `.github/copilot-instructions.md` — workspace-wide rules (read-only GitHub restriction, repo naming, tool guide).
- `mermaid.config.json` / `puppeteer.config.json` — local rendering config for `@mermaid-js/mermaid-cli` (no
  cloud account needed).
- `diagrams/` — default output folder for generated `.mmd` / `.svg` / `-architecture-evidence.md` deliverables.

## Setup

1. Install dependencies:
   ```powershell
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in a real GitHub token:
   ```powershell
   Copy-Item .env.example .env
   ```
   Required values in `.env`:
   - `GITHUB_TOKEN` — a PAT with `repo` + `read:org` scope, SSO-authorized for the rentacenter org.
   - `GITHUB_ORG` — defaults to `rentacenter`.
3. Open this folder in VS Code. The MCP server is auto-registered via `.vscode/mcp.json` under the name
   `arch-diagram`. Its tools appear to Copilot as `mcp_arch-diagram_*` once activated (see note below).
4. In Copilot Chat, invoke the agent directly or via a slash command, e.g.:
   ```
   /generate-architecture-diagram Agreement
   ```

## Important: deferred MCP tool activation

`mcp_arch-diagram_*` tools are deferred and inactive at the start of every conversation turn. Before the first
MCP call in a turn, the agent must call `tool_search` to activate them — this is already encoded in the agent
instructions, but if you see "Tool ... is currently disabled by the user", that's why (the server isn't actually
off).

## Read-only guarantee

This server can only issue `GET`/`HEAD`/`OPTIONS` requests to the GitHub API — a request interceptor rejects
anything else before it leaves the process. The agent is additionally instructed to never attempt commits, PRs,
branches, or issues. Writing local diagram files in this workspace is separate from GitHub and is expected.

## Rendering diagrams locally

No cloud Mermaid account is used. Render with the bundled config:

```powershell
npx -y @mermaid-js/mermaid-cli -i "diagrams/<Module> Module-current-architecture.mmd" -o "diagrams/<Module> Module-current-architecture.svg" -c "mermaid.config.json" -p "puppeteer.config.json" -b white
```

See `/render-diagram` for the full validation checklist to run before treating any diagram as final.
