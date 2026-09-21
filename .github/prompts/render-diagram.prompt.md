---
description: "Render a finished .mmd architecture diagram to SVG/PNG locally with mermaid-cli using this folder's config, then run the visual validation checklist."
argument-hint: "<path-to .mmd file>"
---

Render and validate: **${input:file=diagrams/<Module> Module-current-architecture.mmd}**

1. Validate Mermaid syntax first (no parse errors) before rendering.
2. Render locally using mermaid-cli with this folder's bundled config — no cloud account/service needed:
   ```powershell
   npx -y @mermaid-js/mermaid-cli -i "<path-to.mmd>" -o "<path-to.svg>" -c "mermaid.config.json" -p "puppeteer.config.json" -b white
   ```
3. Also render a PNG for quick visual inspection if useful:
   ```powershell
   npx -y @mermaid-js/mermaid-cli -i "<path-to.mmd>" -o "<path-to.png>" -c "mermaid.config.json" -p "puppeteer.config.json" -b white
   ```
4. Visually inspect the rendered image and confirm the checklist:
   - No overlapping nodes or edges crossing through labels.
   - No clipped/truncated text.
   - Legend is present and complete if the diagram uses color/shape coding.
   - Every node corresponds to a row in the module's `-architecture-evidence.md`.
   - No secrets, tokens, internal hostnames, or account IDs appear anywhere in the rendered output.
5. If any check fails, fix the `.mmd` and re-render — do not deliver a diagram with unresolved visual defects.
6. Once approved by the user, delete any `_*-probe.mmd/.png/.svg` scratch files created during iteration via
   `cleanup_analysis_files` with `confirm: true`.
