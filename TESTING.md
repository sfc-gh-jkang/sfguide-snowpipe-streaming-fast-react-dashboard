# Testing Coverage

Honest matrix of what's been verified end-to-end, what's static-validated only, and known gaps.

| Path / sub-path | Static checks | Live test | Verified outcome |
|---|---|---|---|
| **A — Quick-tunnel** (`docker compose --profile quick`) | ✅ image pulls, YAML parses | ✅ Full E2E | Public `*.trycloudflare.com` URL assigned in 12s, 3 events committed to `RAW_EVENTS` Interactive Table |
| **B — Named tunnel via API** (the path Path C falls back to under the hood) | ✅ image pulls, YAML parses | ✅ Full E2E | Stable hostname survives `docker compose restart`, reconnects in 5–12s with same hostname |
| **B — Named tunnel via Cloudflare dashboard** (the click-through documented in README) | ✅ — same compose service as API path | ✅ Full E2E | Tunnel rebuilt via Cloudflare API on 2026-05-14: 4 healthy QUIC connections to `ord06`/`ord11`/`ord12`/`ord14`, `curl https://<host>/health` returns 200 with HPA-SDK 4-channel status. The dashboard click-through produces an identical token shape (`eyJh…` payload), so same compose container starts cleanly with either method. |
| **C — `vm-bootstrap.sh` Mode 1** (compose-embedded) | ✅ shellcheck-clean, OS gate fires | ✅ Full E2E | Verified on fresh GCP Ubuntu 22.04 VM. Docker 29.4.3 + Compose v5.1.3 installed, prompts walked through |
| **C — `vm-bootstrap.sh` Mode 2** (host-installed cloudflared via apt + `cloudflared tunnel login`) | ✅ apt repo + key urls correct, codename fallback gates new Ubuntu/Debian releases | ✅ apt install path verified on Ubuntu 25.10 (questing → noble fallback installs cloudflared 2026.5.0) | The browser-SSO `cloudflared tunnel login` step is interactive by design and must be driven by the operator (prints a one-time URL). Apt repo install + binary execution verified end-to-end. |
| **D — Terraform: Cloudflare resources** (tunnel, ingress config, DNS CNAME, random_id) | ✅ `terraform fmt`, `terraform validate` | ✅ `apply` + `destroy` cleanly | 5 resources created and destroyed, no orphans |
| **D — Terraform: GCP resources** (VM, static IP, firewall) | ✅ `terraform validate` (with `use_external_ip` toggle) | ✅ Full E2E with `use_external_ip=false` on a restrictive org | Verified 2026-05-14 on a GCP project with `compute.vmExternalIpAccess` org-policy enforced: `terraform apply -var use_external_ip=false` provisioned 6 resources in 13s (VM at internal IP only, no `accessConfigs.natIP`, IAP firewall, all 3 Cloudflare resources). Outputs correctly emit `vm_static_ip = ""` and `ssh_command` with `--tunnel-through-iap`. `terraform destroy` cleanly removed all 6 resources in 60s. cloudflared egresses outbound only — no public IP needed when VPC has Cloud NAT or Private Google Access (default). |
| Streamlit on Snowflake (Container Runtime) | ✅ deploy.sh idempotent | ✅ Full E2E | App loads, click "New Trade" → POST through public tunnel → row in `RAW_EVENTS`. EAI rule auto-syncs from `.env` on every `deploy.sh` run. |
| Cortex Agent chat tab | ✅ agent created, search service running, semantic view validated | ✅ Full E2E | Live in Streamlit chat 2026-05-14: "what was the most recent trade?" → `credit_book_analyst` text-to-SQL against `CREDIT_SV` returned a markdown table (Northbay Consulting POS-0051, BUY 41,531.62 @ 112.40, BAML, ACME Direct Lending II). "top 5 sectors by par amount" → ranked aggregation table (Healthcare $460.9M, Tech/SaaS $452.6M, Industrials $401.6M, Consumer $392.3M, Business Svcs $306.6M). |
| `teardown.sh` (new helper script) | ✅ shellcheck-clean | ✅ Idempotent | Verified 2026-05-14: dropped schema CASCADE, EAI, NP, user, role, pool, 2 warehouses on first run; second consecutive run reported "already dropped" for everything (no errors). Confirms a clean rebuild from scratch via `./teardown.sh -y && setup.sql && semantic_view.sql && ./deploy.sh` works end-to-end (cycle test below). |
| Full teardown → 4-path cycle → teardown | n/a | ✅ Verified 2026-05-14 | Single base setup, then cycled tunnel through all 4 paths: **Round A** (`*.trycloudflare.com` quick): event committed in 503ms cold. **Round B** (named tunnel via API, docker cloudflared): 105ms warm. **Round C2** (apt-installed `cloudflared 2026.5.0` + systemd unit, Ubuntu 25.10 questing→noble fallback): 548ms cold. **Round D** (`terraform apply -var use_external_ip=false`): 6 resources up in 13s, VM at internal IP only, `--tunnel-through-iap` SSH command, `terraform destroy` clean in 70s. Final teardown wiped Snowflake + VM containers + systemd unit + 2 Cloudflare tunnels + DNS records. |

## Bugs found and fixed during testing

| Bug | Symptom | Fix | Commit |
|---|---|---|---|
| Missing `GRANT CREATE PIPE` | HPA SDK fails with HTTP 404 on `/v2/streaming/hostname` on first channel open | Added grant to `setup.sql` | 2a28369 |
| Docker GPG key dearmor on Ubuntu | `apt update` fails with `NO_PUBKEY 7EA0A9C3F273FCD8` | Save `.asc` directly without `gpg --dearmor` | (latest) |
| Compose YAML — `cloudflared` service auto-starts | Default `docker compose up` started the named-tunnel container that needed a token | Move `cloudflared` and `cloudflared-quick` under named profiles (`tunnel` / `quick`) | 71bd799 |
| EAI rule out of sync with `.env` after tunnel URL change | SiS Streamlit shows `VM unreachable: Name resolution failed` | `deploy.sh` now `CREATE OR REPLACE NETWORK RULE` + `ALTER EAI` from `.env` on every run | 992fbde |
| `app.py` placeholder leaked at runtime | Streamlit hits literal `<your-tunnel-host>` URL | `_load_runtime_config()` reads from `APP_CONFIG` Snowflake table (populated by `deploy.sh`) | (in app.py) |
| Cortex Agent silently empty when created with `SPEC = '{...}'` | Agent answered "I don't have access to any trade data" — fell through to default `read` tool, never called `cortex_analyst_text_to_sql` | `CREATE OR REPLACE AGENT name FROM SPECIFICATION $$...$$` (the `SPEC = '...'` form is silently accepted but stores an EMPTY spec — `DESC AGENT` shows `agent_spec=""`). Patched in both `setup.sql` and `deploy.sh`. | (this branch) |
| `snow sql -f setup.sql` aborts with `'L' is undefined` | snow CLI's Jinja templater intercepts `&L` inside the agent's `P&L` instruction text | `deploy.sh` now recreates the agent via `python3` + `snowflake-connector-python` instead of `snow sql -q`, bypassing CLI templating entirely. Setup.sql carries a comment block warning the same. | (this branch) |
| `vm-bootstrap.sh` Mode 2 fails with `Release file not found` on Ubuntu 25.10 / Debian 13 | Cloudflare's `pkg.cloudflare.com/cloudflared/dists/<suite>` only ships `noble`, `jammy`, `focal`, `bookworm`, `bullseye`. `lsb_release -cs` on newer releases returns codenames (`questing`, `plucky`, `oracular`, `trixie`) that 404 the apt fetch. | Added codename fallback case in `vm-bootstrap.sh`: newer-than-noble Ubuntu codenames map to `noble`, newer-than-bookworm Debian codenames map to `bookworm`, with a `warn` line so the operator sees the substitution. Verified on Ubuntu 25.10 (questing → noble): `cloudflared 2026.5.0` installs cleanly. | (this branch) |
| `setup.sh` aborts immediately on macOS with `declare: -A: invalid option` | `declare -A` (associative arrays) requires bash 4+. macOS ships bash 3.2 which fails the directive at the top of the script. setup.sh had never been exercised on macOS before this polish pass — the very first user on macOS would have been blocked at the `.env` generator. | Replaced the `declare -A CURRENT` + while-read population loop with a `_current()` shell function that greps the existing `.env` on demand. Bash-3.2 compatible, identical UX. | (this branch) |
| `setup.sh` writes a corrupt `.env` containing the prompt label + ANSI codes baked into every value | The `prompt_val` function used `printf` to write the prompt label/default-hint, then `read -r val`, then `echo "${val:-$default}"`. The function is called via `$(prompt_val ...)` which captures stdout — so the prompt label was captured into the variable instead of reaching the user's terminal. Result: lines like `SNOWFLAKE_CONNECTION=  [1mSNOWFLAKE_CONNECTION[0m:  [[2m<your-connection>[0m] <your-connection>`. | Redirected all prompt-label `printf` calls in `prompt_val` to stderr (`>&2`). Only the final `echo "${val:-$default}"` goes to stdout where the command substitution captures it. | (this branch) |
| Streamlit container fails to start after a fresh `DROP STREAMLIT + CREATE STREAMLIT` with `pyproject.toml` | Container Runtime treats bare `streamlit` as insufficient — the `[snowflake]` extra is required to pull in `snowflake-snowpark-python` + the connector. Earlier deploys worked because the dependency cache from the initial deploy carried forward. The first DROP+CREATE on a fresh image cache exposed the gap. | Pinned `streamlit[snowflake]>=1.40.0` (with the extra) in `pyproject.toml`. Cold-start is now ~60-90s on first deploy (PyPI install of all deps) but reliable. Pitfall 8 of `streamlit-container-runtime-uv` skill. | (this branch) |
| Terraform `metadata_startup_script` fails on Debian 12 with same Docker GPG dearmor bug as `vm-bootstrap.sh` | `vm-ingest/terraform/main.tf` startup_script piped `gpg --dearmor` into `/etc/apt/keyrings/docker.asc` — binary content in an `.asc`-named file → `NO_PUBKEY 7EA0A9C3F273FCD8` on every fresh `terraform apply`. `vm-bootstrap.sh` had this fixed; terraform did not. Caught when first end-to-end Path D run produced a VM with no Docker installed. | Same fix: drop the `gpg --dearmor` pipe and `curl -fsSL ... -o /etc/apt/keyrings/docker.asc` directly. | (this branch) |
| `vm-ingest/docker-compose.yml` line 11: `SNOWFLAKE_ACCOUNT: "<your-snowflake-account>"` hardcoded as placeholder LITERAL | A user editing `.env` would not see the value picked up by docker compose because the env block hardcoded the placeholder string. Result: HPA SDK fails JWT auth with `No user provided` (misleading — actual cause is `account=<your-snowflake-account>` literal). | Changed to `SNOWFLAKE_ACCOUNT: "${SNOWFLAKE_ACCOUNT:-<set-via-env-SNOWFLAKE_ACCOUNT>}"` so `.env` actually flows through. Same pattern was already in place for `INGEST_API_KEY`. | (this branch) |
| `vm-ingest/terraform/cloudflare.tf` tunnel ingress set to `http://localhost:8080` returns 502 in compose mode | Path D's default operating model is `docker compose --profile tunnel up` where cloudflared and credit-ingest run as **separate containers**. cloudflared's `localhost` is its own loopback, not credit-ingest's — so `localhost:8080` returns "connection refused" and the tunnel returns HTTP 502 to clients. | Changed terraform ingress to `http://credit-ingest:8080` (compose service name resolves via compose DNS). Added a code comment explaining: if cloudflared runs on the host instead (Path C Mode 2 systemd), revert to `localhost:8080` or use `--network=host` on the docker container. | (this branch) |

## What we did NOT test

These are outside the scope of pre-publish validation and should be exercised by the first SE who deploys this fresh:

- **A real customer-network demo** — your office wifi + Cloudflare's edge → real customer browser. We tested SiS-egress only.
- **GCP regions other than `us-central1`** — terraform variable supports all, but only us-central1 was applied.
- **AWS or Azure VMs** — the `vm-ingest/` Docker stack should run anywhere with Docker, but only GCP IAP-tunnel SSH was exercised.
- **Snowflake region other than AWS US East 1** — HPA SDK + Interactive Tables are GA in all clouds but the latency profile differs.
- **Multi-event burst** (50+ events at once) — single events tested, 4-channel pool not stress-tested.
- **Cortex Agent under load** — agent answered correctly in functional spot-checks (Streamlit chat verified live earlier today: trade lookup + sector aggregation); not stress-tested.
- **Snowflake Trial Account** (≠ production demo account) — features like Interactive Tables + HPA require certain edition / preview enablement that may differ on a trial.
- **The `setup.sh` interactive prompt flow from a fresh `.env`** — `.env` was written directly during testing, the prompt path through `setup.sh` wasn't exercised.

## Reproducing the verified E2E (local laptop variant)

```bash
git clone https://github.com/sfc-gh-jkang/sfguide-snowpipe-streaming-fast-react-dashboard.git
cd sfguide-snowpipe-streaming-fast-react-dashboard

# 1. Configure
cp .env.example .env
# fill in 5 values (SNOWFLAKE_CONNECTION, ACCOUNT, VM details, INGEST_TUNNEL_HOST, INGEST_API_KEY)

# 2. Snowflake side + dashboard deploy (one command)
./deploy-app.sh --bootstrap

# 3. Generate keypair, register CREDIT_INGEST_USR (one-time)
# (see README step 3)

# 4. VM side — easiest: quick-tunnel
cd vm-ingest
cp .env.example .env  # fill in Snowflake + Observe (optional)
docker compose --profile quick up -d
docker logs credit-cloudflared-quick | grep trycloudflare
# → paste URL into top-level .env (INGEST_TUNNEL_HOST), then re-deploy:
cd .. && ./deploy-app.sh
```

Click **Fire Trade** in the Next.js dashboard — row should land in `CREDIT_DEMO.RAW_EVENTS` within ~500ms.
