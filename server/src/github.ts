/**
 * Thin GitHub REST API client built on fetch.
 * The token is read from the GITHUB_TOKEN environment variable only —
 * never hardcode a token here.
 */

const GITHUB_API = "https://api.github.com";

export function hasGitHubToken(): boolean {
  return Boolean(process.env.GITHUB_TOKEN);
}

function requireToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set. Copy server/.env.example to server/.env, add a GitHub personal access token, and restart the server."
    );
  }
  return token;
}

export async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = requireToken();
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "repopilot-mcp-server",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}` +
        (body ? ` — ${body.slice(0, 300)}` : "")
    );
  }
  return (await res.json()) as T;
}

/* Minimal response shapes (only the fields RepoPilot surfaces). */

export interface GhRepo {
  name: string;
  full_name: string;
  description: string | null;
  language: string | null;
  updated_at: string;
  html_url: string;
  private: boolean;
  stargazers_count: number;
  default_branch: string;
}

export interface GhPullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  created_at: string;
  html_url: string;
  user: { login: string } | null;
  head: { sha: string; ref: string };
}

export interface GhIssue {
  number: number;
  title: string;
  state: string;
  created_at: string;
  html_url: string;
  user: { login: string } | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

export interface GhWorkflowRun {
  name: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  event: string;
  created_at: string;
  html_url: string;
}

export interface GhEvent {
  type: string;
  created_at: string;
  actor: { login: string } | null;
}

export interface GhCombinedStatus {
  state: string;
  total_count: number;
}
