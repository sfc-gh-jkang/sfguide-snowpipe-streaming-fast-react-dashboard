"use client";

import "./globals.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWebSocket } from "@/lib/ws";

function Nav() {
  const pathname = usePathname();
  const isDesk = pathname === "/";
  const isAsk = pathname === "/ask";

  return (
    <nav className="flex gap-6 px-6 pt-3 border-b border-slate-700">
      <Link
        href="/"
        className={`pb-2 text-sm transition-colors ${
          isDesk ? "tab-active" : "tab-inactive hover:text-slate-300"
        }`}
      >
        Live Credit Desk
      </Link>
      <Link
        href="/ask"
        className={`pb-2 text-sm transition-colors ${
          isAsk ? "tab-active" : "tab-inactive hover:text-slate-300"
        }`}
      >
        Ask the Book
      </Link>
    </nav>
  );
}

function WebSocketProvider({ children }: { children: React.ReactNode }) {
  useWebSocket();
  return <>{children}</>;
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#0f172a] text-slate-200 antialiased">
        <WebSocketProvider>
          <header className="header-strip mx-4 mt-4">
            <h1>ACME Credit Management — Live Credit Desk</h1>
            <p>
              Real-time trade capture · Snowpipe Streaming HPA · Interactive
              Table analytics
            </p>
          </header>
          <Nav />
          <main className="p-4">{children}</main>
        </WebSocketProvider>
      </body>
    </html>
  );
}
