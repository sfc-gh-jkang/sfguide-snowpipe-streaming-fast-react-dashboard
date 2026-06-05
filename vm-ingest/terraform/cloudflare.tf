# -----------------------------------------------------------------------------
# Cloudflare Provider
# -----------------------------------------------------------------------------
provider "cloudflare" {
  # Authenticate via CLOUDFLARE_API_TOKEN env var.
  # Required scopes: Zone:DNS:Edit, Account:Cloudflare Tunnel:Edit
}

# -----------------------------------------------------------------------------
# Tunnel secret
# -----------------------------------------------------------------------------
resource "random_id" "tunnel_secret" {
  byte_length = 32
}

# -----------------------------------------------------------------------------
# Cloudflare Tunnel
# -----------------------------------------------------------------------------
resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id = var.cloudflare_account_id
  name       = var.ingest_subdomain
  secret     = random_id.tunnel_secret.b64_std
}

# -----------------------------------------------------------------------------
# DNS CNAME → tunnel
# -----------------------------------------------------------------------------
resource "cloudflare_record" "ingest" {
  zone_id = var.cloudflare_zone_id
  name    = var.ingest_subdomain
  type    = "CNAME"
  # `content` replaces `value` in cloudflare provider v4+; v5 will remove `value`.
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  proxied = true
  comment = "Managed by Terraform — credit ingest tunnel"
}

# -----------------------------------------------------------------------------
# Tunnel config (ingress rules)
# -----------------------------------------------------------------------------
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id

  config {
    ingress_rule {
      hostname = "${var.ingest_subdomain}.${data.cloudflare_zone.this.name}"
      # Default Path D operating mode is `docker compose --profile tunnel up` —
      # cloudflared and credit-ingest run as separate containers on the same compose
      # network. The cloudflared container resolves "credit-ingest" via compose DNS;
      # using "localhost" would point at cloudflared's own loopback (502 connection
      # refused). If you instead run cloudflared on the host (Path C Mode 2), change
      # this to "http://localhost:8080" or use --network=host on the docker container.
      service = "http://credit-ingest:8080"
    }
    ingress_rule {
      service = "http_status:404"
    }
  }
}

# Look up zone name for the FQDN in tunnel config
data "cloudflare_zone" "this" {
  zone_id = var.cloudflare_zone_id
}
