#!/usr/bin/env bash
# vm-bootstrap.sh — Interactive setup for a fresh Ubuntu/Debian VM.
# Installs Docker, optionally installs cloudflared, and clones the repo.
# Run ON the VM after: gcloud compute ssh <vm-name>
#
# Usage: bash vm-bootstrap.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

info()  { printf "${GREEN}==>${RESET} ${BOLD}%s${RESET}\n" "$*"; }
warn()  { printf "${RED}==>${RESET} ${BOLD}%s${RESET}\n" "$*"; }
dim()   { printf "${DIM}%s${RESET}\n" "$*"; }
ask()   { printf "${BOLD}%s${RESET} " "$*"; }

# ---------------------------------------------------------------------------
# Detect OS
# ---------------------------------------------------------------------------
if [[ ! -f /etc/os-release ]]; then
    warn "Cannot detect OS — /etc/os-release not found."
    warn "This script supports Ubuntu and Debian only."
    exit 1
fi

# shellcheck source=/dev/null
source /etc/os-release

case "${ID:-}" in
    ubuntu|debian) info "Detected ${PRETTY_NAME:-$ID}" ;;
    *)
        warn "Unsupported OS: ${PRETTY_NAME:-$ID}. This script supports Ubuntu and Debian."
        exit 1
        ;;
esac

# ---------------------------------------------------------------------------
# Docker CE + Compose v2 plugin
# ---------------------------------------------------------------------------
if command -v docker &>/dev/null && docker compose version &>/dev/null; then
    dim "Docker CE + Compose v2 already installed — skipping."
else
    info "Installing Docker CE + Compose v2 plugin..."

    sudo apt-get update -qq
    sudo apt-get install -y -qq ca-certificates curl gnupg

    sudo install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
        # Save the ASCII-armored key directly (no dearmor — APT supports .asc).
        sudo curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
            -o /etc/apt/keyrings/docker.asc
        sudo chmod a+r /etc/apt/keyrings/docker.asc
    fi

    ARCH="$(dpkg --print-architecture)"
    # shellcheck disable=SC2154
    echo \
        "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} \
        ${VERSION_CODENAME:-bookworm} stable" \
        | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

    info "Docker CE installed."
fi

# Add current user to docker group (if not already)
if ! groups | grep -qw docker; then
    sudo usermod -aG docker "$USER"
    warn "Added $USER to the docker group."
    warn "Log out and back in (or run: newgrp docker) for group changes to take effect."
fi

# ---------------------------------------------------------------------------
# Tunnel mode selection
# ---------------------------------------------------------------------------
echo ""
info "Cloudflare Tunnel setup"
echo ""
echo "  [1] Compose-embedded (recommended) — token in .env, cloudflared runs in Docker"
echo "  [2] Host-installed   — cloudflared CLI with a named tunnel on this VM"
echo ""
ask "Tunnel mode? [1/2]:"
read -r TUNNEL_MODE
TUNNEL_MODE="${TUNNEL_MODE:-1}"

case "${TUNNEL_MODE}" in
    1)
        echo ""
        info "Compose-embedded mode selected."
        echo ""
        echo "  1. Create a tunnel at https://one.dash.cloudflare.com → Networks → Tunnels"
        echo "  2. Copy the tunnel token"
        echo "  3. Paste it into vm-ingest/.env as CLOUDFLARE_TUNNEL_TOKEN=<token>"
        echo "  4. Run: docker compose up -d"
        echo ""
        dim "No additional software needed on the host."
        ;;
    2)
        info "Host-installed mode selected. Installing cloudflared..."

        # Install cloudflared via official apt repo
        if ! command -v cloudflared &>/dev/null; then
            # Cloudflare's repo only ships specific suites. Map current codename
            # to a supported one (newer-than-noble → noble, debian → bookworm).
            CURRENT_CODENAME="$(lsb_release -cs)"
            case "${CURRENT_CODENAME}" in
                noble|jammy|focal|bookworm|bullseye)
                    REPO_CODENAME="${CURRENT_CODENAME}" ;;
                # Newer Ubuntu (25.04 plucky, 25.10 questing, 24.10 oracular, etc.)
                plucky|questing|oracular|mantic|lunar|kinetic|impish|hirsute|groovy)
                    REPO_CODENAME="noble"
                    warn "Codename '${CURRENT_CODENAME}' has no Cloudflare apt repo; using 'noble' (24.04) packages — verified compatible." ;;
                # Newer Debian (trixie, sid, etc.)
                trixie|sid|forky)
                    REPO_CODENAME="bookworm"
                    warn "Codename '${CURRENT_CODENAME}' has no Cloudflare apt repo; using 'bookworm' (Debian 12) packages — verified compatible." ;;
                *)
                    warn "Unknown distro codename '${CURRENT_CODENAME}'. Defaulting to 'noble'."
                    REPO_CODENAME="noble" ;;
            esac

            curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
                | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
            echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared ${REPO_CODENAME} main" \
                | sudo tee /etc/apt/sources.list.d/cloudflared.list > /dev/null
            sudo apt-get update -qq
            sudo apt-get install -y -qq cloudflared
        else
            dim "cloudflared already installed — skipping."
        fi

        echo ""
        info "Cloudflare login"
        echo "  A URL will print below — open it in your browser to authenticate."
        echo ""
        cloudflared tunnel login

        echo ""
        ask "Tunnel name? [credit-ingest-tunnel]:"
        read -r TUNNEL_NAME
        TUNNEL_NAME="${TUNNEL_NAME:-credit-ingest-tunnel}"

        info "Creating tunnel: ${TUNNEL_NAME}"
        TUNNEL_UUID="$(cloudflared tunnel create "${TUNNEL_NAME}" 2>&1 | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')"
        info "Tunnel UUID: ${TUNNEL_UUID}"

        ask "Public hostname? (e.g. ingest.example.com):"
        read -r TUNNEL_HOSTNAME
        if [[ -z "${TUNNEL_HOSTNAME}" ]]; then
            warn "Hostname is required for DNS routing."
            exit 1
        fi

        info "Routing DNS: ${TUNNEL_HOSTNAME} → ${TUNNEL_NAME}"
        cloudflared tunnel route dns "${TUNNEL_NAME}" "${TUNNEL_HOSTNAME}"

        # Write config
        CREDS_FILE="$HOME/.cloudflared/${TUNNEL_UUID}.json"
        CONFIG_FILE="$HOME/.cloudflared/config.yml"
        info "Writing ${CONFIG_FILE}"
        cat > "${CONFIG_FILE}" <<CFGEOF
tunnel: ${TUNNEL_UUID}
credentials-file: ${CREDS_FILE}

ingress:
  - hostname: ${TUNNEL_HOSTNAME}
    service: http://localhost:8080
  - service: http_status:404
CFGEOF

        info "Installing cloudflared systemd service..."
        sudo cloudflared service install

        echo ""
        info "Tunnel running as systemd service."
        echo ""
        echo "  Tunnel hostname: ${TUNNEL_HOSTNAME}"
        echo "  Paste this into the top-level .env as:"
        echo "    INGEST_TUNNEL_HOST=${TUNNEL_HOSTNAME}"
        echo ""
        dim "Manage with: sudo systemctl {status|restart|stop} cloudflared"
        ;;
    *)
        warn "Invalid choice: ${TUNNEL_MODE}. Expected 1 or 2."
        exit 1
        ;;
esac

# ---------------------------------------------------------------------------
# Clone repo
# ---------------------------------------------------------------------------
echo ""
ask "Clone the project repo? [Y/n]:"
read -r CLONE_ANSWER
CLONE_ANSWER="${CLONE_ANSWER:-Y}"

if [[ "${CLONE_ANSWER}" =~ ^[Yy] ]]; then
    ask "Git clone URL:"
    read -r GIT_URL
    if [[ -z "${GIT_URL}" ]]; then
        warn "No URL provided — skipping clone."
    else
        DEST="$HOME/credit-ingest"
        info "Cloning to ${DEST}..."
        git clone "${GIT_URL}" "${DEST}"
        info "Cloned successfully."
    fi
fi

# ---------------------------------------------------------------------------
# Final banner
# ---------------------------------------------------------------------------
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
info "Next steps"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  1. cd ~/credit-ingest/vm-ingest"
echo "  2. cp .env.example .env && \$EDITOR .env   # fill in Snowflake + tunnel values"
echo "  3. docker compose up -d"
echo ""
echo "  Verify: curl -s http://localhost:8080/health | python3 -m json.tool"
echo ""
