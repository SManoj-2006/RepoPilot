/**
 * RepoPilot server entry point.
 *
 * - POST /mcp  — Model Context Protocol endpoint (Streamable HTTP transport,
 *   MCP spec 2025-11-25). This is the endpoint an Alexa+ agent connects to.
 * - POST /chat — natural-language endpoint for the simulator UI; internally
 *   it is just another MCP client talking to /mcp.
 * - GET /health — liveness + which integrations are configured (booleans
 *   only, never secret values).
 */
import "dotenv/config";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcpServer.js";
import { handleChat, hasGroqKey } from "./chat.js";
import { hasGitHubToken } from "./github.js";

const PORT = Number(process.env.PORT ?? 3001);

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "repopilot",
    mcp_endpoint: "/mcp",
    github_configured: hasGitHubToken(),
    groq_configured: hasGroqKey(),
  });
});

/**
 * Stateless Streamable HTTP: a fresh MCP server + transport per request.
 * That keeps the demo dead simple to run (no session store) while speaking
 * the standard protocol any MCP client — including Alexa+ — expects.
 */
app.post("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// In stateless mode there is no server-initiated stream or session to delete.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.post("/chat", async (req, res) => {
  const message = (req.body as { message?: unknown })?.message;
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Body must be { \"message\": \"...\" }" });
    return;
  }
  try {
    const reply = await handleChat(PORT, message.trim());
    res.json({ reply });
  } catch (err) {
    console.error("[chat] failed:", err);
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Chat failed" });
  }
});

app.listen(PORT, () => {
  console.log(`RepoPilot server listening on http://localhost:${PORT}`);
  console.log(`  MCP endpoint : http://localhost:${PORT}/mcp`);
  console.log(`  Chat endpoint: http://localhost:${PORT}/chat`);
  console.log(`  GitHub token : ${hasGitHubToken() ? "configured" : "NOT set (tools will return a setup error)"}`);
  console.log(`  Groq key     : ${hasGroqKey() ? "configured" : "not set (chat uses intent-routing fallback)"}`);
});
