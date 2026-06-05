# Terraform — GCP VM + Cloudflare Tunnel (Path 3)

Provisions a GCE instance with Docker pre-installed and a Cloudflare Tunnel
routing public HTTPS traffic to the ingest worker on port 8080.

## Prerequisites

- [Terraform CLI](https://developer.hashicorp.com/terraform/install) >= 1.5
- GCP project with Compute Engine API enabled
- `gcloud auth application-default login` (for the Google provider)
- Cloudflare API token with **Zone:DNS:Edit** + **Account:Cloudflare Tunnel:Edit** scopes
  - Create at: https://dash.cloudflare.com/profile/api-tokens

## Quickstart

```bash
# 1. Authenticate
gcloud auth application-default login
export CLOUDFLARE_API_TOKEN="<your-cloudflare-api-token>"

# 2. Configure
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars   # fill in GCP project, Cloudflare IDs, repo URL, API key

# 3. Deploy
terraform init
terraform plan
terraform apply

# 4. Get the tunnel hostname → paste into top-level .env as INGEST_TUNNEL_HOST
terraform output -raw tunnel_hostname

# 5. SSH into the VM, copy keypair, start containers
gcloud compute ssh $(terraform output -raw vm_name) --zone $(terraform output -raw vm_zone)
# On the VM:
cd /opt/credit-ingest/vm-ingest
cp .env.example .env && nano .env    # fill in Snowflake + API key values
# Copy your credit_ingest.p8 keypair into ./keys/
docker compose up -d
```

## What Gets Created

| Resource | Purpose |
|----------|---------|
| `google_compute_address` | Static external IP for the VM |
| `google_compute_instance` | e2-small Debian 12 VM with Docker pre-installed |
| `google_compute_firewall` | Allow SSH via IAP (35.235.240.0/20) |
| `cloudflare_tunnel` | Named tunnel with auto-generated secret |
| `cloudflare_record` | CNAME pointing subdomain to the tunnel |
| `cloudflare_tunnel_config` | Ingress rules routing to localhost:8080 |

## Tear Down

```bash
terraform destroy
```

This removes the VM, static IP, tunnel, and DNS record. The Snowflake objects
(tables, roles, etc.) are not affected.
