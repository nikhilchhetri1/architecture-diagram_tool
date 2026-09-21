---
description: "Discover candidate GitHub repos for a module before running the full architecture diagram workflow — useful when the exact repo name isn't known."
argument-hint: "<keyword>, e.g. 'customer', 'payment', 'delivery'"
---

Help identify the correct repo(s) for the module keyword: **${input:keyword=Module keyword}**.

1. Try `resolve_repo` with `module: "${input:keyword}"` for each relevant prefix: `racpad` (frontend), `es`
   (backend service), and `ess` (shared service) if applicable.
2. If none resolve directly, call `list_org_repos` and/or `search_code` with the keyword to find likely
   candidates, then present a short shortlist with repo name, description, language, and last-updated date.
3. Do not guess a repo name is correct without at least one of: a successful `resolve_repo` lookup, or a
   `search_code`/`fetch_issue_context` result showing the keyword actually appears in that repo.
4. Present the shortlist to the user and ask them to confirm which repo(s) to use before starting
   `/generate-architecture-diagram`.
