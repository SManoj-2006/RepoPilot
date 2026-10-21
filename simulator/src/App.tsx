import { useEffect, useRef, useState } from "react";

interface Message {
  role: "user" | "assistant";
  text: string;
}

const QUICK_PROMPTS = [
  "What's failing in my repos?",
  "List my repos",
  "Summarise my most active repo",
  "Open an issue in owner/repo: CI is red on main",
];

const GREETING: Message = {
  role: "assistant",
  text:
    "Hi, I'm RepoPilot — a simulated Alexa+ experience backed by a real MCP server. " +
    "Ask me about your GitHub repos, for example: “What's failing in my repos?”, " +
    "“Summarise owner/repo”, or “Open an issue in owner/repo: the build is broken”.",
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mcpUp, setMcpUp] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j) => setMcpUp(Boolean(j.ok)))
      .catch(() => setMcpUp(false));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const json = (await res.json()) as { reply?: string; error?: string };
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: json.reply ?? `Something went wrong: ${json.error ?? res.status}`,
        },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: "I can't reach the RepoPilot server. Is it running? (npm run dev:server)",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>🛰️ RepoPilot</h1>
        <p className="sub">
          Simulated Alexa+ experience — every answer comes from live calls to
          the RepoPilot <strong>MCP server</strong> (<code>POST /mcp</code>),
          the same endpoint a real Alexa+ agent connects to.
        </p>
        <p className={`status ${mcpUp === null ? "" : mcpUp ? "up" : "down"}`}>
          {mcpUp === null
            ? "Checking server…"
            : mcpUp
              ? "● MCP server reachable"
              : "● MCP server unreachable — start it with npm run dev:server"}
        </p>
      </header>

      <main className="chat">
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="bubble assistant dim">RepoPilot is thinking…</div>}
        <div ref={bottomRef} />
      </main>

      <div className="quick">
        {QUICK_PROMPTS.map((q) => (
          <button key={q} onClick={() => void send(q)} disabled={busy}>
            {q}
          </button>
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Ask about your repos… e.g. "What PRs are open in owner/repo?"'
          aria-label="Message RepoPilot"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
