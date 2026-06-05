"use client";

import { useState, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, AgentStreamEvent } from "@/lib/types";

const SUGGESTED_PROMPTS = [
  "What trades fired in the last 60 seconds?",
  "Top 5 issuers by mark moves today",
  "Compare today's notional vs yesterday",
  "What is today's total P&L by sector?",
  "Show the latest 10 trades",
  "Which watchlisted names had a downgrade?",
];

export function AgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [statusSteps, setStatusSteps] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const sendMessage = useCallback(
    async (prompt: string) => {
      if (!prompt.trim() || streaming) return;

      const userMsg: ChatMessage = { role: "user", content: prompt };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setStreaming(true);
      setStatusSteps([]);

      // Add empty assistant placeholder
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
      scrollToBottom();

      try {
        const res = await fetch("/api/agent/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: prompt }),
        });

        if (!res.ok) {
          const errText = await res.text();
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: `Error (HTTP ${res.status}): ${errText.slice(0, 300)}`,
            };
            return updated;
          });
          setStreaming(false);
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";

          for (const block of lines) {
            let eventType = "";
            let data = "";

            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                data = line.slice(5).trim();
              }
            }

            if (!data || data === "[DONE]") continue;

            try {
              const parsed: AgentStreamEvent = JSON.parse(data);

              if (eventType === "delta" || parsed.type === "delta") {
                const text = parsed.text || "";
                if (text) {
                  setMessages((prev) => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    updated[updated.length - 1] = {
                      ...last,
                      content: last.content + text,
                    };
                    return updated;
                  });
                  scrollToBottom();
                }
              } else if (eventType === "status" || parsed.type === "status") {
                if (parsed.message) {
                  setStatusSteps((prev) => [...prev, parsed.message!]);
                }
              } else if (eventType === "error" || parsed.type === "error") {
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: `Error: ${parsed.message || "Unknown agent error"}`,
                  };
                  return updated;
                });
              }
            } catch {
              // Skip unparseable events
            }
          }
        }
      } catch (err) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
          };
          return updated;
        });
      } finally {
        setStreaming(false);
        setStatusSteps([]);
      }
    },
    [streaming, scrollToBottom]
  );

  return (
    <div className="flex flex-col h-[calc(100vh-220px)]">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 pb-4">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">Try one of these:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_PROMPTS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(p)}
                  className="px-3 py-1.5 text-xs rounded-full border border-slate-600 text-slate-300 hover:bg-slate-700 hover:border-slate-500 transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`px-4 py-3 max-w-[85%] ${
              msg.role === "user"
                ? "chat-user ml-auto"
                : "chat-assistant mr-auto"
            }`}
          >
            {msg.role === "assistant" && msg.content === "" && streaming ? (
              <span className="text-sm text-slate-400 animate-pulse">
                Thinking...
              </span>
            ) : (
              <div className="prose prose-invert prose-sm max-w-none prose-table:text-xs prose-th:bg-slate-800 prose-th:px-2 prose-th:py-1 prose-th:border prose-th:border-slate-700 prose-td:px-2 prose-td:py-1 prose-td:border prose-td:border-slate-700 prose-table:my-2">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
              </div>
            )}
          </div>
        ))}

        {/* Status steps */}
        {statusSteps.length > 0 && (
          <div className="px-4 space-y-1">
            {statusSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-slate-500">
                {i < statusSteps.length - 1 ? (
                  <span className="text-green-400">✓</span>
                ) : (
                  <span className="inline-block w-3 h-3 border-2 border-slate-500 border-t-snow-blue rounded-full animate-spin" />
                )}
                {step}
              </div>
            ))}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-slate-700 pt-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage(input);
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={streaming}
            placeholder="Ask about the loan book..."
            className="flex-1 px-4 py-2 rounded-lg bg-slate-800 border border-slate-600 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-snow-blue disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={streaming || !input.trim()}
            className="px-4 py-2 rounded-lg bg-snow-blue text-white text-sm font-medium hover:bg-snow-blue-dark disabled:opacity-50 transition-colors"
          >
            Send
          </button>
        </form>

        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="mt-2 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Clear chat
          </button>
        )}
      </div>
    </div>
  );
}
