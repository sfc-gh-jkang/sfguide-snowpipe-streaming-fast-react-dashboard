"use client";

import { AgentChat } from "@/components/AgentChat";

export default function AskPage() {
  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold mb-1">Ask the Book</h2>
      <p className="text-xs text-slate-400 mb-4">
        Powered by <strong>Cortex Agent</strong> — text-to-SQL via Cortex
        Analyst + fuzzy issuer search via Cortex Search. Ask any question about
        the loan book.
      </p>
      <AgentChat />
    </div>
  );
}
