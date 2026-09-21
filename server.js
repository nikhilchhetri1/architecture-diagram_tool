import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import dotenv from "dotenv";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

// Resolve .env relative to this file so it works regardless of CWD
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), ".env"), quiet: true });

if (!process.env.GITHUB_TOKEN) {
  console.error("❌ Missing GITHUB_TOKEN in .env");
  process.exit(1);
}

const DEFAULT_ORG = process.env.GITHUB_ORG || "rentacenter";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const server = new McpServer({
  name: "architecture-diagram-analysis-server",
  version: "1.0.0",
});

const github = axios.create({
  baseURL: "https://api.github.com",
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
  },
});

// ─── Secret Redaction ──────────────────────────────────────────────────────────
//
// getOrCloneRepo() embeds GITHUB_TOKEN directly in the clone URL so `git`/execSync
// can authenticate. When execSync throws (bad repo name, network blip, auth
// failure, timeout), Node's thrown Error.message includes the FULL failed command
// line — e.g. "Command failed: git clone --depth=1 --quiet https://<TOKEN>@github.com/...".
// Every tool below returns err.message straight back to the model/chat transcript,
// so without this guard the PAT would leak into chat history/logs on any clone
// failure. redact() must be applied to every error string before it is returned.
function redact(text) {
  if (text === undefined || text === null) return text;
  let out = String(text);
  if (GITHUB_TOKEN) out = out.split(GITHUB_TOKEN).join("***REDACTED***");
  // Belt-and-suspenders: strip any embedded-credential GitHub URL even if the
  // token itself was already partially transformed (e.g. URL-encoded).
  out = out.replace(/https:\/\/[^@\s"']+@github\.com/g, "https://***REDACTED***@github.com");
  return out;
}

// ─── Read-Only Enforcement ─────────────────────────────────────────────────────
//
// Intercept every outgoing request and abort if it is a write operation.
// This is a hard server-side guard — the agent cannot bypass it even if instructed to.
github.interceptors.request.use((config) => {
  const method = (config.method || "get").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const err = new Error(
      `[READ-ONLY GUARD] GitHub write operation blocked: ${method} ${config.url}. ` +
      `This MCP server is strictly read-only. No commits, pushes, PRs, or issues may be created.`
    );
    err.code = "EREADONLY";
    return Promise.reject(err);
  }
  return config;
});

// ─── SHA-Pinned Repo Cache ─────────────────────────────────────────────────────
//
// Repos are cached in-process for the lifetime of the MCP server.
// On every cache hit we verify the live HEAD SHA via `git ls-remote` —
// a single tiny git-protocol call with zero blob transfer and zero REST rate
// limit consumption. If the SHA differs (deployment happened) we evict and
// re-clone automatically. This gives fresh code on every deployment while
// eliminating redundant clones when nothing has changed.
//
// Structure: "org/repo" → { dir: string, clonedAt: number, commitSha: string }
const repoCache = new Map();
const CACHE_MAX_REPOS = 5; // LRU eviction by clonedAt

async function getOrCloneRepo(org, repo) {
  const cacheKey = `${org}/${repo}`;
  const cloneUrl = `https://${GITHUB_TOKEN}@github.com/${org}/${repo}.git`;

  const cached = repoCache.get(cacheKey);
  if (cached) {
    // SHA check — no blob download, not counted against REST rate limit
    try {
      const lsOut = execSync(`git ls-remote "${cloneUrl}" HEAD`, { timeout: 15000, stdio: "pipe" });
      const liveSha = lsOut.toString().split("\t")[0].trim();
      if (liveSha === cached.commitSha) {
        // Code unchanged — return cached dir immediately
        return { dir: cached.dir, cacheHit: true, commitSha: cached.commitSha };
      }
      // SHA mismatch → deployment happened; evict stale clone
      try { rmSync(cached.dir, { recursive: true, force: true }); } catch { /**/ }
      repoCache.delete(cacheKey);
    } catch {
      // ls-remote failed (network hiccup) — evict and re-clone to be safe
      try { rmSync(cached.dir, { recursive: true, force: true }); } catch { /**/ }
      repoCache.delete(cacheKey);
    }
  }

  // Evict oldest entry if at capacity (LRU by clonedAt)
  if (repoCache.size >= CACHE_MAX_REPOS) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of repoCache.entries()) {
      if (v.clonedAt < oldestTime) { oldestTime = v.clonedAt; oldestKey = k; }
    }
    if (oldestKey) {
      try { rmSync(repoCache.get(oldestKey).dir, { recursive: true, force: true }); } catch { /**/ }
      repoCache.delete(oldestKey);
    }
  }

  // Fresh clone — full shallow, no sparse checkout
  // One clone covers all subdirectory searches; no re-clone needed for different path_filters.
  const tmpDir = mkdtempSync(join(tmpdir(), "arch-diagram-clone-"));
  execSync(`git clone --depth=1 --quiet "${cloneUrl}" "${tmpDir}"`, { timeout: 90000, stdio: "pipe" });
  const commitSha = execSync(`git -C "${tmpDir}" rev-parse HEAD`, { timeout: 10000, stdio: "pipe" }).toString().trim();

  repoCache.set(cacheKey, { dir: tmpDir, clonedAt: Date.now(), commitSha });
  return { dir: tmpDir, cacheHit: false, commitSha };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns up to maxLines lines centred around the first line containing
 * keyword. Adds omission comments when the file is truncated.
 */
function truncateToRelevantSection(content, keyword, maxLines = 150) {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;

  const lower = keyword.toLowerCase();
  let match = lines.findIndex((l) => l.toLowerCase().includes(lower));
  if (match === -1) match = 0;

  const start = Math.max(0, match - Math.floor(maxLines / 2));
  const end = Math.min(lines.length, start + maxLines);

  return (
    (start > 0 ? `// ... lines 1–${start} omitted ...\n` : "") +
    lines.slice(start, end).join("\n") +
    (end < lines.length ? `\n// ... lines ${end + 1}–${lines.length} omitted ...` : "")
  );
}

/**
 * Extracts up to maxKeywords meaningful words from a natural-language string.
 */
// Short technical acronyms that are highly meaningful for code/IaC search but
// would otherwise be dropped by the length filter below (e.g. "SQS", "IAM",
// "S3", "ARN" are only 2-3 characters). Without this allowlist, a question
// like "does this use SQS or S3?" silently degrades to searching only on
// generic stopword-filtered leftovers, increasing the odds fetch_issue_context
// returns "no matches" and the agent falls back to an unverified inference
// instead of confirmed evidence.
const ALWAYS_KEEP_KEYWORDS = new Set([
  "s3", "ec2", "db", "ui", "iam", "arn", "sqs", "sns", "ecs", "api", "sdk",
  "jwt", "sso", "waf", "acl", "vpc", "kms", "rds", "msk", "idp", "mfa", "cdn",
]);

function extractKeywords(text, maxKeywords = 6) {
  const stop = new Set([
    "the","a","an","is","in","on","at","to","for","of","and","or","not",
    "it","this","that","when","how","why","what","where","with","from",
    "are","was","were","been","have","has","had","will","would","could",
    "should","does","did","do","my","we","our","their","its","which","then",
    "also","after","before","about","because","since","while","into","onto",
  ]);
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => (w.length > 2 || ALWAYS_KEEP_KEYWORDS.has(w)) && !stop.has(w))
    ),
  ].slice(0, maxKeywords);
}


// ─── Tool 1: List repo files ──────────────────────────────────────────────────
server.tool(
  "get_repo_files",
  "List files and directories in a GitHub repository at a given path",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string().optional(),
  },
  async ({ owner, repo, path = "" }) => {
    try {
      const res = await github.get(`/repos/${owner}/${repo}/contents/${path}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            res.data.map((f) => ({ name: f.name, path: f.path, type: f.type })),
            null, 2
          ),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 2: Get file content ─────────────────────────────────────────────────
server.tool(
  "get_file_content",
  "Fetch the raw text content of a specific file from a GitHub repository",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
  },
  async ({ owner, repo, path }) => {
    try {
      const res = await github.get(`/repos/${owner}/${repo}/contents/${path}`);
      const content = Buffer.from(res.data.content, "base64").toString();
      return { content: [{ type: "text", text: content }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 3: Analyze code snippet ─────────────────────────────────────────────
server.tool(
  "analyze_code",
  "Analyze a code snippet for issues such as debug logs, large file size, or outdated syntax",
  { code: z.string() },
  async ({ code }) => {
    const issues = [];
    const suggestions = [];
    if (code.includes("console.log"))  { issues.push("Contains console.log statements"); suggestions.push("Remove debug logs for production"); }
    if (code.length > 3000)            { issues.push("File too large"); suggestions.push("Break into smaller modules"); }
    if (code.includes("var "))         { issues.push("Uses 'var' instead of let/const"); suggestions.push("Use modern JS syntax"); }
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "Analysis complete", issues, suggestions }, null, 2) }],
    };
  }
);

// ─── Tool 4: Analyze repo summary ─────────────────────────────────────────────
server.tool(
  "analyze_repo",
  "Analyze a GitHub repository structure and summarize its files and JavaScript content",
  { owner: z.string(), repo: z.string() },
  async ({ owner, repo }) => {
    try {
      const res = await github.get(`/repos/${owner}/${repo}/contents`);
      const jsFiles = res.data.filter((f) => f.name.endsWith(".js"));
      return {
        content: [{ type: "text", text: JSON.stringify({ totalFiles: res.data.length, jsFiles: jsFiles.map((f) => f.name) }, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 5: List org repos ────────────────────────────────────────────────────
server.tool(
  "list_org_repos",
  "List all repositories in a GitHub organization with metadata such as language and last updated date",
  {
    org: z.string(),
    per_page: z.number().optional(),
  },
  async ({ org, per_page = 100 }) => {
    try {
      let repos = [];
      let page = 1;
      while (true) {
        const res = await github.get(`/orgs/${org}/repos`, { params: { per_page, page, type: "all" } });
        repos = repos.concat(res.data);
        if (res.data.length < per_page) break;
        page++;
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: repos.length,
            repos: repos.map((r) => ({
              name: r.name,
              private: r.private,
              description: r.description,
              url: r.html_url,
              language: r.language,
              updated_at: r.updated_at,
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 6: Resolve module → repo name ───────────────────────────────────────
//
// Prefix guide (rentacenter org):
//   racpad   – frontend / store-management UI (React/Angular)
//   es       – backend enterprise services (Node/Java lambdas)
//   ess      – enterprise shared services
//   sims     – SIMS store inventory management system
//   mariner  – Mariner customer portal
//   van      – VAN engagement services
//   rac-ecom – eCommerce / SSO
//   security – Akamai / security configs
server.tool(
  "resolve_repo",
  "Resolve a module or feature name to its GitHub repository name using rentacenter naming conventions",
  {
    module: z.string().describe("Module or feature name, e.g. 'agreement', 'payment', 'customer'"),
    prefix: z
      .enum(["racpad", "es", "ess", "sims", "mariner", "van", "rac-devops", "rac-ecom", "security"])
      .optional()
      .describe("Repo prefix. 'racpad' = frontend/UI, 'es' = backend services. Defaults to 'racpad'."),
    org: z.string().optional().describe("GitHub org. Defaults to rentacenter."),
  },
  async ({ module, prefix = "racpad", org = DEFAULT_ORG }) => {
    const moduleName = module.toLowerCase().replace(/\s+/g, "-");
    const repoName = `${prefix}_${moduleName}`;
    try {
      const res = await github.get(`/repos/${org}/${repoName}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            repo: repoName,
            full_name: res.data.full_name,
            exists: true,
            description: res.data.description,
            language: res.data.language,
            default_branch: res.data.default_branch,
            url: res.data.html_url,
          }, null, 2),
        }],
      };
    } catch {
      try {
        const searchRes = await github.get("/search/repositories", {
          params: { q: `${moduleName} org:${org}`, per_page: 5 },
        });
        const suggestions = searchRes.data.items.map((r) => r.name);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              repo: repoName,
              exists: false,
              suggestions,
              message: `'${repoName}' not found. Similar repos: ${suggestions.join(", ")}`,
            }, null, 2),
          }],
        };
      } catch (err2) {
        return { content: [{ type: "text", text: `Error: ${redact(err2.message)}` }], isError: true };
      }
    }
  }
);

// ─── Tool 7: Search code ───────────────────────────────────────────────────────
//
// Uses GitHub Code Search to find files matching a query.
// Returns file paths + inline snippets — no full file fetch, very token-efficient.
// Use this to locate where a function/component/variable/IaC resource lives before fetching it.
server.tool(
  "search_code",
  "Search for code across GitHub repositories using keywords, returning file paths and matching snippets",
  {
    query: z.string().describe("Keywords to search, e.g. 'createAgreement', 'AWS::Lambda::Function', 'CustomerService'"),
    repo: z.string().optional().describe("Repo name, e.g. 'racpad_agreement'. Searches full org when omitted."),
    org: z.string().optional().describe("GitHub org. Defaults to rentacenter."),
    language: z.string().optional().describe("Language filter, e.g. 'typescript', 'yaml'"),
    max_results: z.number().optional().describe("Max results (default 5, max 10)"),
  },
  async ({ query, repo, org = DEFAULT_ORG, language, max_results = 5 }) => {
    try {
      let q = query;
      if (repo) q += ` repo:${org}/${repo}`;
      else q += ` org:${org}`;
      if (language) q += ` language:${language}`;

      const res = await github.get("/search/code", {
        params: { q, per_page: Math.min(max_results, 10) },
        headers: { Accept: "application/vnd.github.v3.text-match+json" },
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_found: res.data.total_count,
            results: res.data.items.map((item) => ({
              repo: item.repository.name,
              path: item.path,
              url: item.html_url,
              snippets: (item.text_matches || []).map((m) => m.fragment.trim()),
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 8: Fetch issue/feature context (PRIMARY discovery tool) ─────────────
//
// Given a natural-language question ("what handles X", "current architecture of Y"),
// this tool:
//   1. Resolves the target repo from the module name (racpad_<module> by default)
//   2. Extracts keywords from the question
//   3. Searches for matching code via GitHub Code Search
//   4. Fetches top N files, each truncated to the ~150 most relevant lines
//   5. Returns structured context ready for AI analysis
//
// Token-efficiency:
//   • Only fetches files that match the search — no full repo clone
//   • Truncates each file to 150 lines around the keyword match
//   • Deduplicates so the same file is never fetched twice
//   • Falls back to a single-keyword retry if combined query returns nothing
server.tool(
  "fetch_issue_context",
  "Resolve a natural-language question about a module's implementation to relevant source code by searching and fetching matching files from GitHub",
  {
    issue: z.string().describe(
      "Plain-English question, e.g. 'How does the Agreement module authenticate users and call downstream services'"
    ),
    module: z.string().optional().describe(
      "Module name if known, e.g. 'agreement', 'payment', 'customer'. " +
      "For racpad frontend repos the resolved repo will be racpad_<module>."
    ),
    repo: z.string().optional().describe(
      "Exact repo name if already known, e.g. 'racpad_agreement'. Skips repo resolution when provided."
    ),
    org: z.string().optional().describe("GitHub org. Defaults to rentacenter."),
    max_files: z.number().optional().describe("Max files to retrieve content for (default 3)."),
  },
  async ({ issue, module, repo, org = DEFAULT_ORG, max_files = 3 }) => {
    try {
      // ── Step 1: Resolve repo ──────────────────────────────────────────────
      let targetRepo = repo;
      if (!targetRepo && module) {
        const moduleName = module.toLowerCase().replace(/\s+/g, "-");
        const candidate = `racpad_${moduleName}`;
        try {
          await github.get(`/repos/${org}/${candidate}`);
          targetRepo = candidate;
        } catch {
          // repo doesn't exist — fall back to org-wide search
        }
      }

      // ── Step 2: Extract keywords ──────────────────────────────────────────
      const keywords = extractKeywords(issue);
      if (keywords.length === 0) {
        return {
          content: [{ type: "text", text: "Could not extract meaningful keywords. Please describe the request with more specific terms." }],
          isError: true,
        };
      }

      // ── Step 3: Search code ───────────────────────────────────────────────
      const buildQ = (kws) =>
        kws.join(" ") + (targetRepo ? ` repo:${org}/${targetRepo}` : ` org:${org}`);

      let searchRes = await github.get("/search/code", {
        params: { q: buildQ(keywords.slice(0, 4)), per_page: max_files * 2 },
        headers: { Accept: "application/vnd.github.v3.text-match+json" },
      });

      // Retry with single keyword if nothing matched
      if (searchRes.data.total_count === 0 && keywords.length > 1) {
        searchRes = await github.get("/search/code", {
          params: { q: buildQ([keywords[0]]), per_page: max_files },
          headers: { Accept: "application/vnd.github.v3.text-match+json" },
        });
      }

      if (searchRes.data.total_count === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "No matching code found. Try providing the exact function/component name or the repo name.",
              repo: targetRepo ?? `org: ${org}`,
              keywords_tried: keywords,
            }, null, 2),
          }],
        };
      }

      // ── Step 4: Deduplicate & fetch top files ─────────────────────────────
      const seen = new Set();
      const topFiles = searchRes.data.items
        .filter((item) => {
          const key = `${item.repository.name}/${item.path}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, max_files);

      const settled = await Promise.allSettled(
        topFiles.map(async (item) => {
          const fileRes = await github.get(
            `/repos/${item.repository.full_name}/contents/${item.path}`
          );
          const raw = Buffer.from(fileRes.data.content, "base64").toString();
          return {
            repo: item.repository.name,
            path: item.path,
            url: item.html_url,
            snippets: (item.text_matches || []).map((m) => m.fragment.trim()),
            content: truncateToRelevantSection(raw, keywords[0], 150),
          };
        })
      );

      const files = settled.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : {
              repo: topFiles[i].repository.name,
              path: topFiles[i].path,
              url: topFiles[i].html_url,
              error: r.reason?.message ?? "Failed to fetch",
            }
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            issue,
            repo: targetRepo ?? `org-wide (${org})`,
            keywords_used: keywords,
            total_matches: searchRes.data.total_count,
            files,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 9: Clone & search (fast local grep) ────────────────────────────────
//
// Fastest approach for broad evidence gathering (IaC templates, CI/CD workflows,
// handler wiring, auth config, etc.):
//   1. git clone --depth=1 (single round-trip, full file tree)
//   2. Recursive local regex search across all matching files (near-instant)
//   3. Return file paths + line numbers + surrounding context
//   4. Delete the clone
//
// ~10-30x faster than individual GitHub API file fetches for multi-file searches.
// Requires git to be installed on the machine running the MCP server.

function walkAndSearch(dir, pattern, extensions, maxResults, contextLines) {
  const results = [];
  const re = new RegExp(pattern, "gi");

  function walk(current) {
    if (results.length >= maxResults) return;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build") continue;

      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.length === 0 || extensions.some((ext) => entry.name.endsWith(ext))) {
        let content;
        try { content = readFileSync(full, "utf8"); } catch { continue; }
        const lines = content.split("\n");
        const matches = [];
        lines.forEach((line, i) => {
          re.lastIndex = 0;
          if (re.test(line)) {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length - 1, i + contextLines);
            matches.push({
              line: i + 1,
              match: line.trim(),
              context: lines.slice(start, end + 1).map((l, idx) => `${start + idx + 1}: ${l}`).join("\n"),
            });
          }
        });
        if (matches.length > 0) {
          results.push({ path: full.replace(dir, "").replace(/\\/g, "/"), matches });
        }
      }
    }
  }

  walk(dir);
  return results;
}

server.tool(
  "clone_and_search",
  "Clone a GitHub repository and perform a fast local regex search across all files, returning matches with line numbers and context",
  {
    repo: z.string().describe("Repo name, e.g. 'racpad_agreement'"),
    pattern: z.string().describe("Regex or text to search for, e.g. 'AWS::Lambda::Function', 'AWS::SQS::Queue', 'apiVersion'"),
    path_filter: z.string().optional().describe("Subdirectory to limit the search to, e.g. 'server/infra/cf-templates'. Omit to search entire repo."),
    extensions: z.array(z.string()).optional().describe("File extensions to include, e.g. ['.yaml','.yml','.ts']. Omit for all files."),
    org: z.string().optional().describe("GitHub org. Defaults to rentacenter."),
    max_results: z.number().optional().describe("Max matching files to return (default 10)."),
    context_lines: z.number().optional().describe("Lines of context around each match (default 5)."),
  },
  async ({ repo, pattern, path_filter, extensions = [".tsx", ".ts", ".js", ".jsx"], org = DEFAULT_ORG, max_results = 10, context_lines = 5 }) => {
    const startMs = Date.now();

    try {
      // Use SHA-pinned cache — zero clone cost on cache hit, auto-refresh on deployment
      const { dir: repoDir, cacheHit, commitSha } = await getOrCloneRepo(org, repo);
      // path_filter is a local filesystem filter only (no sparse checkout)
      const searchRoot = path_filter ? join(repoDir, path_filter) : repoDir;
      const results = walkAndSearch(searchRoot, pattern, extensions, max_results, context_lines);
      const elapsed = Date.now() - startMs;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            repo,
            pattern,
            path_filter: path_filter ?? "entire repo",
            cache_hit: cacheHit,
            commit_sha: commitSha,
            elapsed_ms: elapsed,
            files_matched: results.length,
            results,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 10: Recent commits (what changed & when) ───────────────────────────
//
// Use case: "Has the infrastructure or wiring for this module changed recently?"
// Returns the last N commits with author, date, message, and files touched.
server.tool(
  "get_recent_commits",
  "Retrieve recent commits from a GitHub repository with author, date, message, and optional file path filter",
  {
    repo: z.string().describe("Repo name, e.g. 'racpad_agreement'"),
    branch: z.string().optional().describe("Branch name. Defaults to the repo's default branch."),
    path: z.string().optional().describe("Limit to commits that touched a specific file/folder, e.g. 'server/infra/cf-templates'"),
    org: z.string().optional(),
    limit: z.number().optional().describe("Number of commits to return (default 10, max 30)"),
  },
  async ({ repo, branch, path, org = DEFAULT_ORG, limit = 10 }) => {
    try {
      const params = { per_page: Math.min(limit, 30) };
      if (branch) params.sha = branch;
      if (path)   params.path = path;

      const res = await github.get(`/repos/${org}/${repo}/commits`, { params });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            repo,
            branch: branch ?? "default",
            path_filter: path ?? "all files",
            commits: res.data.map((c) => ({
              sha: c.sha.slice(0, 8),
              author: c.commit.author.name,
              date: c.commit.author.date,
              message: c.commit.message.split("\n")[0],
              url: c.html_url,
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 11: Get commit diff (what exactly changed in a commit) ──────────────
//
// Use case: "Show me what changed in commit abc1234 in racpad_payment"
server.tool(
  "get_commit_diff",
  "Fetch the full diff and changed files for a specific commit SHA in a GitHub repository",
  {
    repo: z.string().describe("Repo name, e.g. 'racpad_payment'"),
    sha: z.string().describe("Commit SHA (full or short, e.g. 'abc1234')"),
    org: z.string().optional(),
  },
  async ({ repo, sha, org = DEFAULT_ORG }) => {
    try {
      const res = await github.get(`/repos/${org}/${repo}/commits/${sha}`, {
        headers: { Accept: "application/vnd.github.v3+json" },
      });
      const c = res.data;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sha: c.sha.slice(0, 8),
            author: c.commit.author.name,
            date: c.commit.author.date,
            message: c.commit.message,
            files_changed: c.files?.map((f) => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              patch: f.patch ? f.patch.slice(0, 2000) + (f.patch.length > 2000 ? "\n... patch truncated ..." : "") : null,
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 12: Find feature flags ──────────────────────────────────────────────
//
// Use case: "What feature flags gate this module's UI behavior?"
// Clones the repo and greps for all featureFlagDetails / feature flag references.
server.tool(
  "find_feature_flags",
  "Clone a repository and extract all feature flag references from featureFlagDetails usage across the codebase",
  {
    repo: z.string().describe("Repo name, e.g. 'racpad_agreement'"),
    org: z.string().optional(),
  },
  async ({ repo, org = DEFAULT_ORG }) => {
    try {
      const { dir: tmpDir } = await getOrCloneRepo(org, repo);

      // Walk and collect all unique feature flag key names
      const flagPattern = /featureFlagDetails\?\.\s*(\w+)|featureFlagDetails\[['"](\w+)['"]\]/g;
      const flagSet = new Map(); // flagName -> [file:line, ...]
      const extensions = [".tsx", ".ts", ".js", ".jsx"];

      function walk(dir) {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          if (!extensions.some((e) => entry.name.endsWith(e))) continue;
          let content;
          try { content = readFileSync(full, "utf8"); } catch { continue; }
          const lines = content.split("\n");
          lines.forEach((line, i) => {
            let m;
            flagPattern.lastIndex = 0;
            while ((m = flagPattern.exec(line)) !== null) {
              const flag = m[1] || m[2];
              const ref = `${full.replace(tmpDir, "").replace(/\\/g, "/")}:${i + 1}`;
              if (!flagSet.has(flag)) flagSet.set(flag, []);
              flagSet.get(flag).push(ref);
            }
          });
        }
      }

      walk(tmpDir);

      const flags = Array.from(flagSet.entries()).map(([flag, usages]) => ({ flag, used_in: usages }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ repo, total_flags: flags.length, flags }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 13: Find all error / popup messages in a repo ───────────────────────
//
// Use case: "What user-facing messages does this module surface?" (useful context
// when a diagram needs to annotate error/resilience paths).
server.tool(
  "find_error_messages",
  "Clone a repository and extract all user-facing error messages, alerts, and popup strings from source code",
  {
    repo: z.string().describe("Repo name, e.g. 'racpad_payment'"),
    component: z.string().optional().describe("Narrow to a subfolder, e.g. 'Payment' or 'AgreementTransfer'"),
    org: z.string().optional(),
  },
  async ({ repo, component, org = DEFAULT_ORG }) => {
    try {
      const { dir: tmpDir } = await getOrCloneRepo(org, repo);

      // Patterns that indicate user-facing messages
      const msgPatterns = [
        /setmanageAgrErrMessage\(['"`]([^'"`]+)['"`]\)/,
        /\bt\(['"`]([^'"`]{10,})['"`]\)/,                    // i18n t("...") calls
        /(?:message|error|alert|toast|popup).*?['"`]([A-Z][^'"`]{10,})['"`]/i,
        /<Typography[^>]*>\s*\{t\(['"`]([^'"`]{10,})['"`]\)\}/,
      ];

      const messages = new Map(); // message -> files
      const extensions = [".tsx", ".ts", ".jsx"];

      function walk(dir) {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          if (!extensions.some((e) => entry.name.endsWith(e))) continue;
          let content;
          try { content = readFileSync(full, "utf8"); } catch { continue; }
          const relPath = full.replace(tmpDir, "").replace(/\\/g, "/");
          content.split("\n").forEach((line) => {
            for (const p of msgPatterns) {
              const m = p.exec(line);
              if (m?.[1]) {
                const msg = m[1].trim();
                if (!messages.has(msg)) messages.set(msg, new Set());
                messages.get(msg).add(relPath);
              }
            }
          });
        }
      }

      const root = component ? join(tmpDir, "client", "src", "components", component) : tmpDir;
      walk(root);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            repo,
            component: component ?? "all",
            total_messages: messages.size,
            messages: Array.from(messages.entries()).map(([msg, files]) => ({
              message: msg,
              files: Array.from(files),
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 14: Get open pull requests ─────────────────────────────────────────
//
// Use case: "Is there already an infrastructure/architecture change in flight for this module?"
server.tool(
  "get_open_prs",
  "List open pull requests for a GitHub repository with title, author, branch, and labels",
  {
    repo: z.string().describe("Repo name, e.g. 'racpad_agreement'"),
    org: z.string().optional(),
    limit: z.number().optional().describe("Max PRs to return (default 10)"),
  },
  async ({ repo, org = DEFAULT_ORG, limit = 10 }) => {
    try {
      const res = await github.get(`/repos/${org}/${repo}/pulls`, {
        params: { state: "open", per_page: Math.min(limit, 30), sort: "updated", direction: "desc" },
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            repo,
            open_prs: res.data.length,
            prs: res.data.map((pr) => ({
              number: pr.number,
              title: pr.title,
              author: pr.user.login,
              branch: pr.head.ref,
              created_at: pr.created_at,
              updated_at: pr.updated_at,
              url: pr.html_url,
              labels: pr.labels.map((l) => l.name),
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 15: Multi-repo search (find a shared client/config across all racpad repos) ──
//
// Use case: "Which other modules also depend on this shared auth/config pattern?"
// Uses GitHub Code Search (rate-limited to 10 req/min) — use sparingly.
server.tool(
  "multi_repo_search",
  "Search for a function, component, or symbol across all repositories in a GitHub organization, filtered by repo prefix",
  {
    query: z.string().describe("Exact symbol, function, or text to search, e.g. 'useCustomerClub', 'EnableClubTransfer'"),
    prefix: z.string().optional().describe("Limit to repos starting with this prefix, e.g. 'racpad', 'es'. Defaults to 'racpad'."),
    org: z.string().optional(),
    language: z.string().optional().describe("Language filter, e.g. 'typescript'"),
    max_results: z.number().optional().describe("Max results (default 8)"),
  },
  async ({ query, prefix = "racpad", org = DEFAULT_ORG, language, max_results = 8 }) => {
    try {
      let q = `${query} org:${org}`;
      if (language) q += ` language:${language}`;
      // GitHub doesn't support prefix filtering in code search — we post-filter
      const res = await github.get("/search/code", {
        params: { q, per_page: 30 },
        headers: { Accept: "application/vnd.github.v3.text-match+json" },
      });
      const filtered = res.data.items.filter((item) => item.repository.name.startsWith(prefix));
      const top = filtered.slice(0, max_results);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            query,
            prefix_filter: prefix,
            total_org_matches: res.data.total_count,
            prefix_matches: filtered.length,
            results: top.map((item) => ({
              repo: item.repository.name,
              path: item.path,
              url: item.html_url,
              snippets: (item.text_matches || []).map((m) => m.fragment.trim()),
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool 16: Get all API endpoints used in a component ────────────────────────
//
// Use case: "What backend APIs does this module's UI call?" — feeds the
// Experience → Services edges in the diagram.
server.tool(
  "get_api_calls",
  "Clone a repository and extract all API endpoint calls made by a component or the entire frontend source",
  {
    repo: z.string().describe("Repo name, e.g. 'racpad_agreement'"),
    component: z.string().optional().describe("Component folder name, e.g. 'AgreementTransfer'. Searches entire src if omitted."),
    org: z.string().optional(),
  },
  async ({ repo, component, org = DEFAULT_ORG }) => {
    try {
      const { dir: tmpDir } = await getOrCloneRepo(org, repo);
      const sparseTarget = component ? `client/src/components/${component}` : "client/src";

      // API call patterns: axios calls, custom API functions (GetXxx, PostXxx, UpdateXxx, DeleteXxx)
      const patterns = [
        { name: "axios/fetch", re: /(?:axios|fetch)\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/ },
        { name: "custom API fn", re: /(?:await\s+|=\s*)([A-Z][a-z]+(?:[A-Z][a-zA-Z]+)*)\s*\(/ },
        { name: "API path string", re: /['"`](\/(?:api|agreement|customer|payment|store|inventory)[^'"`]+)['"`]/ },
      ];

      const apiCalls = new Map();
      const extensions = [".tsx", ".ts", ".js", ".jsx"];

      function walk(dir) {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          if (!extensions.some((e) => entry.name.endsWith(e))) continue;
          let content;
          try { content = readFileSync(full, "utf8"); } catch { continue; }
          const relPath = full.replace(tmpDir, "").replace(/\\/g, "/");
          content.split("\n").forEach((line) => {
            for (const { name, re } of patterns) {
              const m = re.exec(line);
              if (m?.[1] && m[1].length > 3) {
                const key = m[1];
                if (!apiCalls.has(key)) apiCalls.set(key, { type: name, files: [] });
                if (!apiCalls.get(key).files.includes(relPath)) {
                  apiCalls.get(key).files.push(relPath);
                }
              }
            }
          });
        }
      }

      const searchRoot = join(tmpDir, ...sparseTarget.split("/"));
      walk(searchRoot);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            repo,
            component: component ?? "entire src",
            total_api_calls: apiCalls.size,
            api_calls: Array.from(apiCalls.entries()).map(([call, info]) => ({
              call,
              type: info.type,
              files: info.files,
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${redact(err.message)}` }], isError: true };
    }
  }
);

// ─── Tool: Cleanup analysis files ─────────────────────────────────────────────
//
// Deletes temporary scratch/probe files generated during diagram iteration
// (e.g. _*-probe.mmd, _*-probe.png) and clears the in-memory repo cache.
// Call this once a diagram has been finalized and agreed upon.
server.tool(
  "cleanup_analysis_files",
  "Delete temporary probe/scratch files and clear the repo cache after a diagram investigation is complete",
  {
    confirm: z.literal(true).describe("Must be true to confirm deletion. Prevents accidental calls."),
    directory: z.string().optional().describe("Absolute path to scan for scratch files. Defaults to process.cwd()."),
    pattern: z.string().optional().describe("Filename substring to match for deletion. Defaults to files starting with '_' and ending in '-probe.mmd', '-probe.png', or '-probe.svg'."),
  },
  async ({ confirm, directory, pattern }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: "Aborted: confirm must be true." }], isError: true };
    }

    const targetDir = directory ?? process.cwd();
    const deleted = [];
    const errors  = [];
    const isScratch = (name) =>
      pattern
        ? name.includes(pattern)
        : name.startsWith("_") && (name.endsWith("-probe.mmd") || name.endsWith("-probe.png") || name.endsWith("-probe.svg"));

    let entries;
    try {
      entries = readdirSync(targetDir, { withFileTypes: true });
    } catch (err) {
      return { content: [{ type: "text", text: `Cannot read directory: ${redact(err.message)}` }], isError: true };
    }

    for (const entry of entries) {
      if (!entry.isFile() || !isScratch(entry.name)) continue;
      const fullPath = join(targetDir, entry.name);
      try {
        rmSync(fullPath, { force: true });
        deleted.push(entry.name);
      } catch (err) {
        errors.push({ file: entry.name, error: redact(err.message) });
      }
    }

    // Clear all cached repo clones
    let cacheCleared = 0;
    for (const [key, entry] of repoCache.entries()) {
      try { rmSync(entry.dir, { recursive: true, force: true }); } catch { /**/ }
      repoCache.delete(key);
      cacheCleared++;
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          directory: targetDir,
          deleted,
          errors,
          repos_cache_cleared: cacheCleared,
          summary: `${deleted.length} file(s) deleted, ${cacheCleared} cached repo(s) cleared, ${errors.length} error(s).`,
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: List cached repos ───────────────────────────────────────────────────
//
// Returns which repos are currently in the SHA-pinned cache and how old they are.
// Useful for confirming a cache hit before calling clone_and_search.
server.tool(
  "list_cached_repos",
  "List all repositories currently in the SHA-pinned local cache with their commit SHA and age in minutes",
  {},
  async () => {
    const now = Date.now();
    const entries = Array.from(repoCache.entries()).map(([key, entry]) => ({
      repo: key,
      commit_sha: entry.commitSha,
      age_minutes: Math.floor((now - entry.clonedAt) / 60000),
      dir: entry.dir,
    }));
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ cached_repos: entries.length, repos: entries }, null, 2),
      }],
    };
  }
);

// ─── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("✅ Architecture Diagram MCP server running (v1.0.0) — READ-ONLY mode enforced (GET/HEAD only)...");
