# Security Policy

This is a Snowflake Sales Engineering demo asset, not an officially supported Snowflake product. The code is provided as-is under the Apache-2.0 license with no warranty.

## Reporting a vulnerability

If you find a security issue in this repository, please **do not open a public GitHub issue**. Instead, email the maintainer directly:

- **Maintainer**: John Kang (`john.kang@snowflake.com`)

Include:

- A description of the issue
- Steps to reproduce
- Affected file paths and commit SHA
- Your assessment of impact (e.g. credential exposure, RCE, data exfiltration)

You should expect an acknowledgment within 5 business days. Severity-1 issues (active credential exposure, RCE in deployed instances) will be triaged within 1 business day on a best-effort basis.

## Scope

In scope:

- Code in this repository (`web/`, `vm-ingest/`, `setup.sql`, `deploy-app.sh`, `semantic_view.sql`)
- Configuration patterns documented in `README.md`, `ASSUMPTIONS.md`, `TROUBLESHOOTING.md`
- Default values in `.env.example`

Out of scope:

- Vulnerabilities in upstream dependencies (Next.js, FastAPI, Snowpipe Streaming SDK, cloudflared, etc.) — please report those to the upstream project
- Issues that require an attacker to already have ACCOUNTADMIN on the target Snowflake account
- Issues in Snowflake itself — please file via [Snowflake Support](https://community.snowflake.com)

## Hardening guidance for production-like deployments

This repo is a demo, not a production template. Before adapting it for an environment with real data:

- Rotate `INGEST_API_KEY` to a long random string and store it in a managed secret rather than `.env`
- Replace the permissive `DASHBOARD_BUILD_RULE` (`0.0.0.0:443`) with an explicit allow-list of npm registry hosts
- Re-introduce the `role: DASHBOARD_RL` runtime role-switch (currently disabled, see README gotcha #6) once you've granted that role to the SPCS-bound service user
- Bind cloudflared to a named tunnel with Cloudflare Access policies enforced at the tunnel rather than relying solely on `INGEST_API_KEY`
- Audit `setup.sql` grants and remove any that exceed read-only requirements for your use case

## License

This security policy is published alongside the [Apache-2.0 LICENSE](LICENSE) for this repository.
