/**
 * POST /chat — the natural-language layer used by the simulator UI.
 *
 * It connects to RepoPilot's own MCP endpoint as a real MCP client, so every
 * answer is produced by calling the same tools an Alexa+ agent would call.
 *
 * - If GROQ_API_KEY is set, Groq (llama-3.3-70b-versatile) drives the
 *   conversation with function/tool calling against the MCP tools.
 * - Otherwise (or if Groq errors), a small built-in intent router maps the
 *   message to a tool call and formats the result, so the demo still runs.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT =
  "You are RepoPilot, the voice assistant behind an Alexa+ experience for GitHub. " +
  "Answer questions about the user's GitHub repositories and take actions using the provided tools. " +
  "Be concise and conversational, as if speaking aloud: short sentences, no markdown tables, no code blocks. " +
  "If the user asks you to open an issue, use create_issue and confirm with the issue number and title. " +
  "If you don't know which repository the user means, ask.";

export function hasGroqKey(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

async function connectMcp(port: number): Promise<Client> {
  const client = new Client({ name: "repopilot-chat", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`)
  );
  await client.connect(transport);
  return client;
}

function resultText(result: CallToolResult): string {
  return result.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

interface ToolOutcome {
  data?: unknown;
  error?: string;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = resultText(result);
  if (result.isError) return { error: text.replace(/^Error:\s*/, "") };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { data: text };
  }
}

/* ------------------------------ Groq path ------------------------------ */

interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface GroqMessage {
  role: string;
  content: string | null;
  tool_calls?: GroqToolCall[];
  tool_call_id?: string;
  name?: string;
}

async function groqChat(client: Client, message: string): Promise<string> {
  const { tools } = await client.listTools();
  const groqTools = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema,
    },
  }));

  const messages: GroqMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: message },
  ];

  for (let round = 0; round < 5; round++) {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        tools: groqTools,
        tool_choice: "auto",
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      throw new Error(`Groq API failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const json = (await res.json()) as {
      choices: Array<{ message: GroqMessage }>;
    };
    const assistant = json.choices[0]?.message;
    if (!assistant) throw new Error("Groq returned no message");
    messages.push(assistant);

    if (!assistant.tool_calls?.length) {
      return assistant.content?.trim() || "Done.";
    }
    for (const tc of assistant.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = (await client.callTool({
        name: tc.function.name,
        arguments: args,
      })) as CallToolResult;
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content: resultText(result),
      });
    }
  }
  return "I ran out of steps trying to answer that — try a more specific question.";
}

/* --------------------------- Fallback routing --------------------------- */

const SLUG = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/;

function findSlug(message: string): { owner: string; repo: string } | null {
  const m = message.match(SLUG);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function fmtRepos(data: unknown): string {
  const repos = data as Array<{ full_name: string; language: string | null; updated_at: string }>;
  if (!repos.length) return "You don't have any repositories yet.";
  const lines = repos
    .slice(0, 5)
    .map((r) => `${r.full_name}${r.language ? ` (${r.language})` : ""}, updated ${r.updated_at.slice(0, 10)}`);
  return `Here are your most recently updated repos: ${lines.join("; ")}.` +
    (repos.length > 5 ? ` Plus ${repos.length - 5} more.` : "");
}

function fmtSummary(data: unknown): string {
  const s = data as {
    repo: string; open_pull_requests: number; open_issues: number;
    latest_ci: { workflow: string; conclusion: string | null; status: string; branch: string } | null;
  };
  const ci = s.latest_ci
    ? `Latest CI: ${s.latest_ci.workflow} ${s.latest_ci.conclusion ?? s.latest_ci.status} on ${s.latest_ci.branch}.`
    : "No recent CI runs.";
  return `${s.repo}: ${s.open_pull_requests} open pull requests, ${s.open_issues} open issues. ${ci}`;
}

function fmtRuns(data: unknown): string {
  const d = data as { workflow_runs: Array<{ workflow: string; conclusion: string | null; status: string; branch: string }> };
  if (!d.workflow_runs.length) return "No recent workflow runs found.";
  return d.workflow_runs
    .map((r) => `${r.workflow} on ${r.branch}: ${r.conclusion ?? r.status}`)
    .join("; ") + ".";
}

async function fallbackChat(client: Client, message: string): Promise<string> {
  const msg = message.toLowerCase();
  const slug = findSlug(message);

  // "open an issue in owner/repo: Some title"
  const createMatch = message.match(
    /(?:open|create|file)(?:\s+an)?\s+issue\s+in\s+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*[:\-]?\s*(.+)/i
  );
  if (createMatch) {
    const [, owner, repo, title] = createMatch;
    const out = await callTool(client, "create_issue", { owner, repo, title: title.trim() });
    if (out.error) return `I couldn't create that issue: ${out.error}`;
    const issue = out.data as { number: number; title: string; url: string };
    return `Done — created issue #${issue.number} "${issue.title}" in ${owner}/${repo}. ${issue.url}`;
  }

  if (/\b(failing|ci|build|workflow|checks|pipeline)\b/.test(msg)) {
    if (slug) {
      const out = await callTool(client, "get_ci_status", slug);
      return out.error ? `I couldn't check CI: ${out.error}` : `CI for ${slug.owner}/${slug.repo}: ${fmtRuns(out.data)}`;
    }
    // "What's failing in my repos?" — scan the 3 most recently updated repos.
    const reposOut = await callTool(client, "list_repos", { limit: 3 });
    if (reposOut.error) return `I couldn't list your repos: ${reposOut.error}`;
    const repos = reposOut.data as Array<{ full_name: string }>;
    const parts: string[] = [];
    for (const r of repos) {
      const [owner, repo] = r.full_name.split("/");
      const out = await callTool(client, "get_ci_status", { owner, repo });
      parts.push(out.error ? `${r.full_name}: couldn't check` : `${r.full_name}: ${fmtRuns(out.data)}`);
    }
    return `Recent CI across your top repos — ${parts.join(" ")}`;
  }

  if (/\bpull request|prs?\b/.test(msg) && slug) {
    const out = await callTool(client, "list_pull_requests", slug);
    if (out.error) return `I couldn't list pull requests: ${out.error}`;
    const prs = out.data as Array<{ number: number; title: string; author: string }>;
    if (!prs.length) return `No open pull requests in ${slug.owner}/${slug.repo}.`;
    return `${prs.length} open pull request(s) in ${slug.owner}/${slug.repo}: ` +
      prs.slice(0, 5).map((p) => `#${p.number} "${p.title}" by ${p.author}`).join("; ") + ".";
  }

  if (/\bissues?\b/.test(msg) && slug) {
    const out = await callTool(client, "list_issues", slug);
    if (out.error) return `I couldn't list issues: ${out.error}`;
    const issues = out.data as Array<{ number: number; title: string }>;
    if (!issues.length) return `No open issues in ${slug.owner}/${slug.repo}.`;
    return `${issues.length} open issue(s) in ${slug.owner}/${slug.repo}: ` +
      issues.slice(0, 5).map((i) => `#${i.number} "${i.title}"`).join("; ") + ".";
  }

  if (/\b(summar|brief|status|update|overview)\b/.test(msg) && slug) {
    const out = await callTool(client, "get_repo_summary", slug);
    return out.error ? `I couldn't summarise that repo: ${out.error}` : fmtSummary(out.data);
  }

  if (/\brepos?\b|repositor/.test(msg) || !slug) {
    const out = await callTool(client, "list_repos", { limit: 10 });
    if (out.error) return `I couldn't list your repos: ${out.error}`;
    const base = fmtRepos(out.data);
    return slug
      ? base
      : `${base} Try asking "summarise owner/repo", "what's failing in my repos?", or "open an issue in owner/repo: title".`;
  }

  const out = await callTool(client, "get_repo_summary", slug);
  return out.error ? `I couldn't look that up: ${out.error}` : fmtSummary(out.data);
}

/* ------------------------------- Handler -------------------------------- */

export async function handleChat(port: number, message: string): Promise<string> {
  const client = await connectMcp(port);
  try {
    if (hasGroqKey()) {
      try {
        return await groqChat(client, message);
      } catch (err) {
        console.error("[chat] Groq path failed, falling back to intent routing:", err);
      }
    }
    return await fallbackChat(client, message);
  } finally {
    await client.close().catch(() => undefined);
  }
}
