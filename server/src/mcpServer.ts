/**
 * RepoPilot MCP server.
 *
 * Implements the Model Context Protocol (streamable HTTP transport) using the
 * official @modelcontextprotocol/sdk, exposing GitHub tools that an Alexa+
 * agent (or any MCP client) can call to answer questions about — and take
 * actions on — the user's GitHub repositories.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  gh,
  type GhCombinedStatus,
  type GhEvent,
  type GhIssue,
  type GhPullRequest,
  type GhRepo,
  type GhWorkflowRun,
} from "./github.js";

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

const ownerRepo = {
  owner: z.string().min(1).describe("GitHub user or organisation that owns the repo"),
  repo: z.string().min(1).describe("Repository name"),
};

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "repopilot", version: "0.1.0" });

  /* ------------------------------ list_repos ----------------------------- */
  server.registerTool(
    "list_repos",
    {
      description:
        "List the authenticated GitHub user's repositories, most recently updated first (name, description, primary language, last updated).",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("How many repos to return (default 10, max 30)"),
      },
    },
    async ({ limit }) => {
      try {
        const repos = await gh<GhRepo[]>(
          `/user/repos?sort=updated&direction=desc&per_page=${limit ?? 10}`
        );
        return ok(
          repos.map((r) => ({
            name: r.name,
            full_name: r.full_name,
            description: r.description,
            language: r.language,
            updated_at: r.updated_at,
            private: r.private,
            url: r.html_url,
          }))
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  /* -------------------------- list_pull_requests ------------------------- */
  server.registerTool(
    "list_pull_requests",
    {
      description:
        "List open pull requests for a repository, including title, author and (for up to 10 PRs) the CI status of the PR head commit.",
      inputSchema: {
        ...ownerRepo,
        include_ci: z
          .boolean()
          .optional()
          .describe("Include CI status per PR (default true)"),
      },
    },
    async ({ owner, repo, include_ci }) => {
      try {
        const prs = await gh<GhPullRequest[]>(
          `/repos/${owner}/${repo}/pulls?state=open&per_page=30`
        );
        const out = [];
        for (const [i, pr] of prs.entries()) {
          let ci_status: string | undefined;
          if (include_ci !== false && i < 10) {
            try {
              const s = await gh<GhCombinedStatus>(
                `/repos/${owner}/${repo}/commits/${pr.head.sha}/status`
              );
              ci_status = s.state;
            } catch {
              ci_status = "unknown";
            }
          }
          out.push({
            number: pr.number,
            title: pr.title,
            author: pr.user?.login ?? "unknown",
            state: pr.state,
            draft: pr.draft,
            created_at: pr.created_at,
            ...(ci_status !== undefined ? { ci_status } : {}),
            url: pr.html_url,
          });
        }
        return ok(out);
      } catch (err) {
        return fail(err);
      }
    }
  );

  /* ----------------------------- get_ci_status --------------------------- */
  server.registerTool(
    "get_ci_status",
    {
      description:
        "Get the latest GitHub Actions workflow runs for a repository, and the combined commit status when a branch is given.",
      inputSchema: {
        ...ownerRepo,
        branch: z.string().min(1).optional().describe("Optional branch name"),
      },
    },
    async ({ owner, repo, branch }) => {
      try {
        const runs = await gh<{ workflow_runs: GhWorkflowRun[] }>(
          `/repos/${owner}/${repo}/actions/runs?per_page=5` +
            (branch ? `&branch=${encodeURIComponent(branch)}` : "")
        );
        const result: Record<string, unknown> = {
          workflow_runs: runs.workflow_runs.map((r) => ({
            workflow: r.name,
            status: r.status,
            conclusion: r.conclusion,
            branch: r.head_branch,
            event: r.event,
            created_at: r.created_at,
            url: r.html_url,
          })),
        };
        if (branch) {
          try {
            const combined = await gh<GhCombinedStatus>(
              `/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}/status`
            );
            result.branch_combined_status = {
              state: combined.state,
              checks_reported: combined.total_count,
            };
          } catch {
            result.branch_combined_status = { state: "unknown" };
          }
        }
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  /* ------------------------------ list_issues ---------------------------- */
  server.registerTool(
    "list_issues",
    {
      description: "List open issues for a repository (pull requests excluded).",
      inputSchema: {
        ...ownerRepo,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many issues to return (default 10)"),
      },
    },
    async ({ owner, repo, limit }) => {
      try {
        const items = await gh<GhIssue[]>(
          `/repos/${owner}/${repo}/issues?state=open&per_page=50`
        );
        const issues = items
          .filter((i) => !i.pull_request)
          .slice(0, limit ?? 10)
          .map((i) => ({
            number: i.number,
            title: i.title,
            author: i.user?.login ?? "unknown",
            labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
            created_at: i.created_at,
            url: i.html_url,
          }));
        return ok(issues);
      } catch (err) {
        return fail(err);
      }
    }
  );

  /* ----------------------------- create_issue ---------------------------- */
  server.registerTool(
    "create_issue",
    {
      description:
        "Create a new issue in a repository. This is a write action — use it when the user asks to open/file an issue.",
      inputSchema: {
        ...ownerRepo,
        title: z.string().min(1).describe("Issue title"),
        body: z.string().optional().describe("Issue body (Markdown)"),
      },
    },
    async ({ owner, repo, title, body }) => {
      try {
        const issue = await gh<GhIssue>(`/repos/${owner}/${repo}/issues`, {
          method: "POST",
          body: JSON.stringify({ title, body: body ?? "" }),
        });
        return ok({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          url: issue.html_url,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  /* --------------------------- get_repo_summary -------------------------- */
  server.registerTool(
    "get_repo_summary",
    {
      description:
        "One-call briefing on a repository: description, open PR count, open issue count, latest CI run and recent activity. Ideal for 'give me a status update on owner/repo'.",
      inputSchema: { ...ownerRepo },
    },
    async ({ owner, repo }) => {
      try {
        const [info, pulls, issues, runs, events] = await Promise.all([
          gh<GhRepo>(`/repos/${owner}/${repo}`),
          gh<GhPullRequest[]>(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`),
          gh<GhIssue[]>(`/repos/${owner}/${repo}/issues?state=open&per_page=100`),
          gh<{ workflow_runs: GhWorkflowRun[] }>(
            `/repos/${owner}/${repo}/actions/runs?per_page=3`
          ).catch(() => ({ workflow_runs: [] as GhWorkflowRun[] })),
          gh<GhEvent[]>(`/repos/${owner}/${repo}/events?per_page=5`).catch(
            () => [] as GhEvent[]
          ),
        ]);
        const latest = runs.workflow_runs[0];
        return ok({
          repo: info.full_name,
          description: info.description,
          language: info.language,
          stars: info.stargazers_count,
          default_branch: info.default_branch,
          open_pull_requests: pulls.length,
          open_issues: issues.filter((i) => !i.pull_request).length,
          latest_ci: latest
            ? {
                workflow: latest.name,
                status: latest.status,
                conclusion: latest.conclusion,
                branch: latest.head_branch,
                created_at: latest.created_at,
                url: latest.html_url,
              }
            : null,
          recent_activity: events.map((e) => ({
            type: e.type,
            actor: e.actor?.login ?? "unknown",
            at: e.created_at,
          })),
          url: info.html_url,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}
