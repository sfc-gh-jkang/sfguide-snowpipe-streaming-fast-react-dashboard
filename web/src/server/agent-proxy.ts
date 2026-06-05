/**
 * Cortex Agent SSE proxy — streams responses from the Snowflake Cortex Agent API.
 * Implements the BDC pattern (Bearer OAuth + event-typed parser) from app.py.
 */

import { getOAuthToken } from "./snowflake-client";
import type { AgentStreamEvent, ChatMessage } from "../lib/types";

import { APP_DB, APP_SCHEMA, AGENT_NAME } from "./config";

/**
 * Extract text from any known Cortex Agent SSE payload shape.
 * Handles 5 documented variants from memo 70c59ef8.
 */
function extractText(payload: Record<string, unknown>): string {
  const parts: string[] = [];

  // Shape 1: {"delta": {"content": [{"type": "text", "text": "..."}]}}
  const delta = payload.delta as Record<string, unknown> | undefined;
  if (delta) {
    const content = delta.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (
          typeof item === "object" &&
          item !== null &&
          (item as Record<string, unknown>).type === "text"
        ) {
          parts.push(String((item as Record<string, unknown>).text || ""));
        }
      }
    } else if (
      typeof content === "object" &&
      content !== null &&
      (content as Record<string, unknown>).type === "text"
    ) {
      parts.push(String((content as Record<string, unknown>).text || ""));
    }
  }

  // Shape 2: {"choices":[{"delta":{"content":"..."}}]}
  const choices = payload.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const d = (choice as Record<string, unknown>).delta as
        | Record<string, unknown>
        | undefined;
      if (d) {
        const c = d.content;
        if (typeof c === "string") {
          parts.push(c);
        }
      }
    }
  }

  // Shape 3: top-level text
  if (typeof payload.text === "string") {
    parts.push(payload.text);
  }

  // Shape 4: top-level content list
  const topContent = payload.content;
  if (Array.isArray(topContent)) {
    for (const item of topContent) {
      if (
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).type === "text"
      ) {
        parts.push(String((item as Record<string, unknown>).text || ""));
      }
    }
  }

  return parts.join("");
}

/**
 * Stream Cortex Agent responses as an async iterable of AgentStreamEvent.
 */
export async function* streamAgent(
  question: string,
  history: ChatMessage[]
): AsyncGenerator<AgentStreamEvent> {
  const token = getOAuthToken();
  if (!token) {
    yield { type: "error", message: "OAuth token not available" };
    return;
  }

  const snowflakeHost = process.env.SNOWFLAKE_HOST || "";
  if (!snowflakeHost) {
    yield { type: "error", message: "SNOWFLAKE_HOST not configured" };
    return;
  }

  // Build messages array
  const messages = history.map((msg) => ({
    role: msg.role,
    content: [{ type: "text", text: msg.content }],
  }));
  messages.push({
    role: "user",
    content: [{ type: "text", text: question }],
  });

  const url = `https://${snowflakeHost}/api/v2/databases/${APP_DB}/schemas/${APP_SCHEMA}/agents/${AGENT_NAME}:run`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const body = JSON.stringify({ messages });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      // Defensive cache opt-out (Next.js Data Cache) — see snowflake-client.ts
      // for full rationale. POSTs aren't cached by default, but Next.js 14.2.x
      // has documented edge cases with identical bodies.
      cache: "no-store",
      headers,
      body,
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    yield {
      type: "error",
      message: `Agent request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    yield {
      type: "error",
      message: `Agent error (HTTP ${response.status}): ${text.slice(0, 400)}`,
    };
    return;
  }

  if (!response.body) {
    yield { type: "error", message: "No response body from agent" };
    return;
  }

  // Parse SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType: string | null = null;
  let dataBuf: string[] = [];

  // Skip non-content events
  const SKIP_EVENTS = new Set([
    "response.thinking.delta",
    "response.thinking",
    "response.status",
    "response.tool_use",
    "response.tool_result",
    "response.tool_result.status",
    "response",
    "response.text",
  ]);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();

        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
          dataBuf = [];
        } else if (line.startsWith("data:")) {
          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]") {
            yield { type: "done" };
            return;
          }
          dataBuf.push(dataStr);
        } else if (line === "" && dataBuf.length > 0) {
          const raw = dataBuf.join("\n");
          dataBuf = [];

          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(raw);
          } catch {
            continue;
          }

          if (eventType && SKIP_EVENTS.has(eventType)) {
            // Emit status events for UI progress
            if (eventType === "response.status") {
              yield {
                type: "status",
                message: String(
                  (payload as Record<string, unknown>).message || eventType
                ),
              };
            }
            continue;
          }

          if (eventType === "error") {
            yield {
              type: "error",
              message: String(
                (payload as Record<string, unknown>).message ||
                  JSON.stringify(payload).slice(0, 300)
              ),
            };
            return;
          }

          const text = extractText(payload);
          if (text) {
            yield { type: "delta", text };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: "done" };
}
