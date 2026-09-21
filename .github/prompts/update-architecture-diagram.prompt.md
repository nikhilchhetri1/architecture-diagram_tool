---
description: "Refresh an existing module architecture diagram after code/infra changes, re-verifying evidence rather than assuming it is still accurate."
argument-hint: "<Module Name> [path-to-existing .mmd] [days-to-check-commits=30]"
---

Use the **Architecture Diagram Agent** to refresh the current-state architecture diagram for
**${input:module=Module name, e.g. Agreement}**.

Existing deliverable to refresh: ${input:existing=diagrams/<Module> Module-current-architecture.mmd}

Steps:
1. Read the existing `.mmd` and `-architecture-evidence.md` files to understand what was previously verified.
2. Call `get_recent_commits` (last ${input:days=30} days) on every repo cited in the existing evidence file,
   scoped to the paths that were previously cited.
3. For any commit that touches a previously-cited path, call `get_commit_diff` and determine whether the
   architectural claim (node, edge, config) is still accurate.
4. Do NOT remove or alter a previously "Confirmed" evidence row unless you have new evidence showing it changed.
5. Add new rows for anything new that evidence now supports; mark superseded rows clearly rather than deleting
   history silently.
6. Re-render the `.svg` only if the `.mmd` changed. Re-validate visually.
7. Summarize exactly what changed since the last version (diagram diff in plain English) and what stayed the
   same, then ask for confirmation before finalizing.
