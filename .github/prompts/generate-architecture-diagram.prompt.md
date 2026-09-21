---
description: "Generate a verified, evidence-grounded current-state architecture diagram for a single named module (frontend + backend), producing .mmd, .svg, and an evidence appendix."
argument-hint: "<Module Name> [repo1,repo2,...] [environment] [output-folder]"
---

Use the **Architecture Diagram Agent** (`.github/agents/architecture-diagram.agent.md`) to generate a current-state
architecture diagram for the module: **${input:module=Module name, e.g. Agreement}**.

Additional context (use if provided, otherwise discover via `resolve_repo` / `fetch_issue_context`):
- Repos: ${input:repos=Comma-separated repo names, or leave blank to auto-resolve}
- Environment: ${input:environment=prod}
- Output folder: ${input:output=diagrams/}

Follow the full workflow defined in the agent:
1. Resolve the frontend (`racpad_<module>`) and backend (`es_<module>...`) repos.
2. Gather evidence only via the `mcp_arch-diagram_*` tools — entry points, auth, API calls, IaC, CI/CD, data
   stores, resilience/observability, feature flags. Cite repo + path + commit SHA for every claim.
3. Do not invent any node or edge that isn't backed by a file you actually read. Explicitly note anything
   searched for but not found.
4. Design the diagram using the layer groupings in the agent definition (Experience & Identity, API Boundary,
   Synchronous Services, Event & Integration Pipelines, Data & Resilience State, External Integrations &
   Platform Controls) — omit layers with no evidence rather than forcing content into them.
5. Write the Mermaid source, render it locally with mermaid-cli using this folder's `mermaid.config.json` /
   `puppeteer.config.json`, and visually validate (no overlaps, no clipped text, legend present).
6. Produce the four required deliverables in the output folder:
   - `<Module> Module-current-architecture.mmd`
   - `<Module> Module-current-architecture.svg`
   - `<Module> Module-current-architecture.png` — high-resolution raster export (mermaid-cli with at least
     `-w 2400 -b white --scale 2`), suitable for zooming in or pasting into slides/docs without pixelation.
   - `<Module> Module-architecture-evidence.md`
7. Report a one-paragraph summary, the four file paths, and any open/unverified items. Ask for confirmation
   before treating the diagram as final.
