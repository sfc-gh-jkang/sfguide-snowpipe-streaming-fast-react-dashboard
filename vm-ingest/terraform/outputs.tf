output "vm_name" {
  description = "GCE instance name (for gcloud commands)."
  value       = google_compute_instance.ingest.name
}

output "vm_zone" {
  description = "GCE instance zone."
  value       = google_compute_instance.ingest.zone
}

output "vm_static_ip" {
  description = "Static external IP of the VM (empty when use_external_ip = false)."
  value       = var.use_external_ip ? google_compute_address.ingest[0].address : ""
}

output "ssh_command" {
  description = "SSH into the VM via gcloud (uses IAP tunnel when no external IP)."
  value       = var.use_external_ip ? (
    "gcloud compute ssh ${google_compute_instance.ingest.name} --zone ${google_compute_instance.ingest.zone}"
  ) : (
    "gcloud compute ssh ${google_compute_instance.ingest.name} --zone ${google_compute_instance.ingest.zone} --tunnel-through-iap"
  )
}

output "tunnel_hostname" {
  description = "Public hostname for the ingest endpoint."
  value       = "${var.ingest_subdomain}.${data.cloudflare_zone.this.name}"
}

output "tunnel_token" {
  description = "Cloudflare tunnel token (use in docker-compose .env or cloudflared CLI)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.this.tunnel_token
  sensitive   = true
}
