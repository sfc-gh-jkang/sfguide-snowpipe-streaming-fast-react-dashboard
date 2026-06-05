/**
 * POST /api/agent/stream — SSE proxy to Cortex Agent API.
 * Returns text/event-stream with delta events.
 */

import { NextRequest } from "next/server";
import { streamAgent } from "../../../../server/agent-proxy";
import type { ChatMessage } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let question: string;
  let history: ChatMessage[] = [];

  try {
    const body = await req.json();
    question = body.question;
    history = body.history || [];
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!question) {
    return new Response(
      JSON.stringify({ error: "question is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamAgent(question, history)) {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        }
      } catch (err) {
        const errorEvent = `data: ${JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        })}\n\n`;
        controller.enqueue(encoder.encode(errorEvent));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
