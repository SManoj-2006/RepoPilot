/**
 * Smoke test: connect to a running RepoPilot server as a real MCP client
 * (Streamable HTTP), list tools, and try one tool call.
 *
 * Usage:
 *   1. npm run build && npm start        (in another terminal)
 *   2. npm run smoke                     (from the repo root)
 *
 * Exits 0 if the server answers and all 6 expected tools are listed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://localhost:3001/mcp");
const EXPECTED = [
  "list_repos",
  "list_pull_requests",
  "get_ci_status",
  "list_issues",
  "create_issue",
  "get_repo_summary",
];

const client = new Client({ name: "repopilot-smoke-test", version: "0.1.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(url));
  console.log(`Connected to ${url}`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  console.log(`tools/list returned ${names.length} tools: ${names.join(", ")}`);

  const missing = EXPECTED.filter((n) => !names.includes(n));
  if (missing.length) {
    console.error(`FAIL: missing tools: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("PASS: all 6 expected tools are present.");

  // Exercise one real tool call. Without GITHUB_TOKEN the tool must return a
  // graceful error (not crash); with a token it returns live data.
  const result = await client.callTool({ name: "list_repos", arguments: { limit: 3 } });
  const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "";
  console.log(`\nlist_repos call -> isError=${Boolean(result.isError)}`);
  console.log(text.slice(0, 600));
} catch (err) {
  console.error("FAIL: could not talk to the MCP server:", err?.message ?? err);
  process.exit(1);
} finally {
  await client.close().catch(() => {});
}
