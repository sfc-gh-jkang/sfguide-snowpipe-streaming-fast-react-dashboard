"use client";

import { PUBLIC_INTERACTIVE_WH } from "@/lib/constants";

/**
 * Architecture diagram — pure SVG/HTML, no JS deps.
 * Mirrors the Mermaid diagram in README.md but renders inline so demo viewers
 * see the click-flow without leaving the page.
 */
export function ArchitectureDiagram() {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <h2 className="text-lg font-semibold mb-1">Architecture</h2>
      <p className="text-xs text-slate-400 mb-4">
        Three flows overlaid: <span className="text-cyan-300">Click loop</span> (orange path),{" "}
        <span className="text-snow-blue">Tile re-query</span> (dotted), and{" "}
        <span className="text-violet-400">Cortex Agent</span> (right column).
      </p>

      <div className="grid grid-cols-12 gap-2 text-xs">
        {/* Browser */}
        <div className="col-span-12 flex justify-center">
          <Node color="user" label="User Browser" sub="Snowsight ingress (OAuth)" wide />
        </div>

        <div className="col-span-12 flex justify-center text-slate-500">▼ HTTPS</div>

        {/* SPCS Next.js + Cortex Agent */}
        <div className="col-span-7">
          <Node
            color="snow"
            label="Next.js on SPCS"
            sub="Live Desk · /api/ingest · /api/snapshot · /api/observability"
          />
        </div>
        <div className="col-span-5">
          <Node
            color="ai"
            label="Cortex Agent"
            sub="cortex_analyst_text_to_sql + cortex_search"
          />
        </div>

        <div className="col-span-7 flex flex-col items-center text-slate-500">
          <span>▼ POST /ingest (X-API-Key, EAI-allowed)</span>
        </div>
        <div className="col-span-5 flex flex-col items-center text-slate-500">
          <span>▼ text-to-SQL</span>
        </div>

        {/* VM + Semantic View / Search */}
        <div className="col-span-7">
          <Node
            color="ext"
            label="GCP VM (Cloudflared tunnel)"
            sub="FastAPI + 4-channel HPA SDK · keypair JWT"
          />
        </div>
        <div className="col-span-5">
          <Node
            color="ai"
            label="CREDIT_SV (Semantic View)"
            sub="+ POSITIONS_SEARCH (Cortex Search)"
          />
        </div>

        <div className="col-span-7 flex flex-col items-center text-slate-500">
          <span>▼ wait_for_flush() ~30 ms</span>
        </div>
        <div className="col-span-5 flex flex-col items-center text-slate-500">
          <span>▼ FROM …</span>
        </div>

        {/* Snowpipe → RAW_EVENTS (standard table) → PORTFOLIO_LIVE (Interactive Table) */}
        <div className="col-span-12">
          <Node
            color="snow"
            label="Snowpipe Streaming HPA → Auto-PIPE → RAW_EVENTS (standard table)"
            sub="Raw event log; written by HPA SDK from VM producer"
            wide
          />
        </div>

        <div className="col-span-12 flex justify-center text-slate-500">
          ▼ Auto-refresh
        </div>

        <div className="col-span-12">
          <Node
            color="snow"
            label="PORTFOLIO_LIVE (Interactive Table)"
            sub="CLUSTER BY (SECTOR, ISSUER) · TARGET_LAG = 1 minute · concurrent sub-second reads"
            wide
          />
        </div>

        <div className="col-span-12 flex justify-center text-slate-500">
          ▼ SELECT via Interactive Warehouse ({PUBLIC_INTERACTIVE_WH})
        </div>

        {/* Back to UI */}
        <div className="col-span-12 flex justify-center">
          <Node
            color="snow"
            label="Live tile re-render in browser (React diff &lt;16ms)"
            wide
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px]">
        <Legend color="snow" label="Snowflake-managed" />
        <Legend color="ext" label="Outside Snowflake (VM + cloudflared)" />
        <Legend color="ai" label="Cortex AI" />
        <Legend color="user" label="End user" />
      </div>

      <p className="mt-4 text-xs text-slate-400 leading-relaxed">
        <strong className="text-slate-200">Single takeaway:</strong> the only piece outside Snowflake
        is the producer VM. It exists wherever the trading system / OMS / Kafka Connect already runs.
        Once the row is over the wire to Snowpipe Streaming HPA, every downstream concern (durability,
        fan-out, query, AI, UI) is Snowflake&apos;s problem.
      </p>
    </div>
  );
}

function Node({
  color,
  label,
  sub,
  wide = false,
}: {
  color: "snow" | "ext" | "ai" | "user";
  label: string;
  sub?: string;
  wide?: boolean;
}) {
  const palette: Record<string, string> = {
    snow: "border-snow-blue/60 bg-snow-blue/10 text-slate-100",
    ext: "border-amber-400/60 bg-amber-500/10 text-amber-100",
    ai: "border-violet-400/60 bg-violet-500/10 text-violet-100",
    user: "border-slate-400/60 bg-slate-700/40 text-slate-100",
  };
  return (
    <div
      className={`rounded-md border-2 px-3 py-2 ${palette[color]} ${
        wide ? "w-full" : ""
      }`}
    >
      <div className="font-medium leading-tight">{label}</div>
      {sub && <div className="text-[10px] opacity-80 mt-0.5 leading-tight">{sub}</div>}
    </div>
  );
}

function Legend({
  color,
  label,
}: {
  color: "snow" | "ext" | "ai" | "user";
  label: string;
}) {
  const dot: Record<string, string> = {
    snow: "bg-snow-blue",
    ext: "bg-amber-400",
    ai: "bg-violet-400",
    user: "bg-slate-400",
  };
  return (
    <div className="flex items-center gap-2 text-slate-300">
      <span className={`inline-block w-2.5 h-2.5 rounded-sm ${dot[color]}`} />
      <span>{label}</span>
    </div>
  );
}
