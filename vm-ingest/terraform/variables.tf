variable "gcp_project" {
  description = "GCP project ID where the VM will be created."
  type        = string
}

variable "gcp_region" {
  description = "GCP region for the VM and static IP."
  type        = string
  default     = "us-central1"
}

variable "gcp_zone" {
  description = "GCP zone for the VM."
  type        = string
  default     = "us-central1-c"
}

variable "vm_name" {
  description = "Name of the GCE instance."
  type        = string
  default     = "credit-ingest"
}

variable "vm_machine_type" {
  description = "GCE machine type."
  type        = string
  default     = "e2-small"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID. Find at: dash.cloudflare.com → select domain → Overview → right sidebar."
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare Account ID. Find at: dash.cloudflare.com → right sidebar."
  type        = string
}

variable "ingest_subdomain" {
  description = "Subdomain for the tunnel CNAME record (e.g. 'credit-ingest' → credit-ingest.example.com)."
  type        = string
  default     = "credit-ingest"
}

variable "ingest_api_key" {
  description = "API key for authenticating ingest requests. Generate a strong random value."
  type        = string
  sensitive   = true
}

variable "repo_url" {
  type        = string
  description = "Git repo URL to clone into /opt/credit-ingest on the VM."
}

variable "use_external_ip" {
  type        = bool
  default     = true
  description = "Whether to attach an external IP to the VM. Set to false in GCP orgs that block constraints/compute.vmExternalIpAccess (cloudflared egresses outbound only, so it works without an external IP as long as the VPC has Cloud NAT or Private Google Access — most VPCs do by default)."
}
