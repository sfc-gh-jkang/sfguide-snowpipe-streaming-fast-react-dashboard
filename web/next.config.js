/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output is required for the SPCS CNB buildpack to package the
  // app into the runtime tarball. We OVERWRITE the auto-generated
  // .next/standalone/server.js with our custom WebSocket-aware server.js
  // (see the install step in app.yml).
  output: "standalone",
  // Standalone trace excludes `ws` because it's only imported by our custom
  // server.js (not by any Next route handler). Force-include it so the
  // runtime container has the WebSocket library available.
  experimental: {
    outputFileTracingIncludes: {
      "/": ["./node_modules/ws/**/*"],
    },
  },
};

module.exports = nextConfig;
