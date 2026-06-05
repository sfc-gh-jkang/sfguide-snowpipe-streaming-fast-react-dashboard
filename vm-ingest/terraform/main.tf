# -----------------------------------------------------------------------------
# GCP Provider
# -----------------------------------------------------------------------------
provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
  zone    = var.gcp_zone
}

# -----------------------------------------------------------------------------
# Static external IP — only when use_external_ip = true
# (cloudflared egresses outbound only, so it works fine without a public IP
# as long as the VPC has Cloud NAT or Private Google Access. Most default
# VPCs in unrestricted GCP orgs have Private Google Access enabled by default.)
# -----------------------------------------------------------------------------
resource "google_compute_address" "ingest" {
  count  = var.use_external_ip ? 1 : 0
  name   = "${var.vm_name}-ip"
  region = var.gcp_region
}

# -----------------------------------------------------------------------------
# Firewall — allow IAP SSH (GCP Identity-Aware Proxy range)
# -----------------------------------------------------------------------------
resource "google_compute_firewall" "allow_iap_ssh" {
  name    = "${var.vm_name}-allow-iap-ssh"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"] # IAP forwarding range
  target_tags   = [var.vm_name]
}

# -----------------------------------------------------------------------------
# Startup script — installs Docker + Compose, clones repo
# -----------------------------------------------------------------------------
locals {
  startup_script = <<-STARTUP
    #!/usr/bin/env bash
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive

    # Docker CE + Compose v2
    if ! command -v docker &>/dev/null; then
      apt-get update -qq
      apt-get install -y -qq ca-certificates curl gnupg
      install -m 0755 -d /etc/apt/keyrings
      # Save the GPG key in ASCII-armored form (matches the .asc extension and apt expectation).
      # Earlier `gpg --dearmor` here wrote BINARY into a .asc file → NO_PUBKEY 7EA0A9C3F273FCD8 on apt-update.
      curl -fsSL https://download.docker.com/linux/debian/gpg \
        -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      ARCH="$(dpkg --print-architecture)"
      echo "deb [arch=$${ARCH} signed-by=/etc/apt/keyrings/docker.asc] \
        https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    fi

    # Clone repo
    DEST="/opt/credit-ingest"
    if [[ ! -d "$${DEST}/.git" ]]; then
      apt-get install -y -qq git
      git clone "${var.repo_url}" "$${DEST}"
    fi

    # Ensure OS Login users can run docker
    usermod -aG docker "$(logname 2>/dev/null || echo root)" || true
  STARTUP
}

# -----------------------------------------------------------------------------
# GCE instance
# -----------------------------------------------------------------------------
resource "google_compute_instance" "ingest" {
  name         = var.vm_name
  machine_type = var.vm_machine_type
  zone         = var.gcp_zone
  tags         = [var.vm_name]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 20
    }
  }

  network_interface {
    network = "default"
    dynamic "access_config" {
      for_each = var.use_external_ip ? [1] : []
      content {
        nat_ip = google_compute_address.ingest[0].address
      }
    }
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = local.startup_script
}
