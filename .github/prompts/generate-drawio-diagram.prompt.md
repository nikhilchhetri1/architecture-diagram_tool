---
description: "Generate a verified, evidence-grounded current-state architecture diagram for a single named module as a fully-editable draw.io (.drawio) file with technology-accurate icons (AWS service icons plus specific product/engine logos like PostgreSQL, MySQL, Oracle, MongoDB, Redis, Kafka based on actual evidence), plus an evidence appendix. No Mermaid output."
argument-hint: "<Module Name> [repo1,repo2,...] [environment] [output-folder]"
---

Use the **Draw.io Architecture Diagram Agent** (`.github/agents/drawio-architecture-diagram.agent.md`) to
generate a current-state architecture diagram, as a draw.io file, for the module:
**${input:module=Module name, e.g. Agreement}**.

Additional context (use if provided, otherwise discover via `resolve_repo` / `fetch_issue_context`, or reuse an
existing Mermaid evidence file for this module if one is already present in the output folder):
- Repos: ${input:repos=Comma-separated repo names, or leave blank to auto-resolve}
- Environment: ${input:environment=prod}
- Output folder: ${input:output=diagrams/}

Follow the full workflow defined in the agent:
1. Resolve the frontend (`racpad_<module>`) and backend (`es_<module>...`) repos — or reuse the evidence already
   gathered in an existing `<Module> Module-architecture-evidence.md` in the output folder if one exists and is
   still current.
2. Gather evidence only via the `mcp_arch-diagram_*` tools — entry points, auth, API calls, IaC, CI/CD, data
   stores, resilience/observability, feature flags. Cite repo + path + commit SHA for every claim.
3. For every database, cache, message broker, or search index found, identify the **concrete engine/product**
   (not just "a database") from IaC resource properties (e.g. RDS `Engine: postgres`), Dockerfile/compose
   `image:` tags, package.json dependencies/drivers, or connection config — per the agent's evidence step.
   Record it as its own evidence row. If it genuinely cannot be determined, say so explicitly rather than
   guessing an engine.
4. Do not invent any node or edge that isn't backed by a file you actually read, and do not invent a
   technology/engine that isn't backed by evidence either. Explicitly note anything searched for but not found.
4. Design the diagram using the layer groupings in the agent definition (Experience & Identity, API Boundary,
   Synchronous Services, Event & Integration Pipelines, Data & Resilience State, External Integrations &
   Platform Controls) — omit layers with no evidence rather than forcing content into them.
5. Author the mxGraph `.drawio` XML directly using the agent's **3-tier icon selection priority**: Tier 1 —
   AWS-managed resource with an evidenced engine → use the matching engine-specific AWS4 icon (e.g.
   `mxgraph.aws4.rds_postgresql_instance`, `mxgraph.aws4.elasticache_for_redis`,
   `mxgraph.aws4.managed_streaming_for_kafka` — see the table in the agent definition); Tier 2 — self-hosted/
   non-AWS but a well-known product is evidenced (PostgreSQL, MySQL, MongoDB, Redis, Kafka, RabbitMQ, Docker,
   Kubernetes, etc.) → best-effort vendor logo shape from the draw.io shape panel; Tier 3 — no confident icon
   match → plain labeled shape. Every node's label must state the concrete product/version regardless of tier.
6. Apply the agent's **Layout & Anti-Overlap Rules** exactly: minimum 280px icon pitch within a row, minimum
   300px row-to-row pitch with a clear gap-lane, never a plain/default edge that skips over an intermediate
   node in the same row (use bottom-anchored dip routing or explicit `<Array as="points">` waypoints instead),
   a dedicated margin lane with explicit waypoints for any edge crossing more than one sibling container,
   short (1-4 word) edge labels, and merging near-duplicate nodes/edges where evidence allows.
7. There is no local render/screenshot tool for `.drawio` files — run the agent's mandatory PowerShell
   self-check (well-formed XML, no duplicate ids, no dangling edge refs, no node-vs-node overlaps) and fix
   everything it flags before considering the file done. Tell the user this has been structurally/geometrically
   self-checked but not visually pre-rendered the way Mermaid diagrams are.
8. Produce the two required deliverables in the output folder:
   - `<Module> Module-current-architecture.drawio`
   - `<Module> Module-architecture-evidence.md` (with a `Technology` column per the agent definition)
9. Report a one-paragraph summary, the two file paths, a **Technology & Icon Breakdown** (concrete
   engine/product identified per data store/broker/cache and which icon tier was used), and any
   open/unverified items. Ask the user to open the file in draw.io / diagrams.net / the VS Code Draw.io
   Integration extension and confirm the layout before treating it as final.
