#!/usr/bin/env bash
#
# Unified Public-Data API — one-shot server deploy.
#
# Run ONCE on the target server as root (Ubuntu). Safe to re-run: it will
# pull the latest code, rebuild, re-run tests, and restart services.
#
#   curl -fsSL https://raw.githubusercontent.com/cryptostoner94/unified-data-api/main/deploy.sh | sudo bash
#
# Optional: export NPM_TOKEN=<npm-token> to also publish @unified-data/sdk
# to the npm registry during deploy. The token is read from the environment
# only, used once via a temp file, and never written to disk permanently.
#
# Secrets: the script creates /opt/unified-data-api/.env from
# backend/.env.example ONLY if .env does not already exist. It never prints,
# embeds, or overwrites secrets.
#
set -euo pipefail

REPO_URL="https://github.com/cryptostoner94/unified-data-api.git"
REPO_DIR="/opt/unified-data-api"
ENV_FILE="$REPO_DIR/.env"
VENV="$REPO_DIR/.venv"
API_PORT="8000"
LANDING_PORT="8080"

log()  { echo "[deploy] $*"; }
warn() { echo "[deploy][WARN] $*" >&2; }

# ---------------------------------------------------------------- root check
if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (e.g.: curl ... | sudo bash)" >&2
  exit 1
fi

# ------------------------------------------------------- system dependencies
log "Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git python3 python3-venv python3-pip ca-certificates > /dev/null

# ------------------------------------------------------------- Node.js >= 20
need_node=0
if ! command -v node >/dev/null 2>&1; then
  need_node=1
else
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 20 ]; then need_node=1; fi
fi
if [ "$need_node" -eq 1 ]; then
  log "Installing Node.js 20 (nodesource)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs > /dev/null
else
  log "Node $(node -v) already present."
fi

# ------------------------------------------------------------------ repo
if [ -d "$REPO_DIR/.git" ]; then
  log "Repo exists — pulling latest..."
  git -C "$REPO_DIR" pull --ff-only
else
  log "Cloning repo to $REPO_DIR..."
  git clone "$REPO_URL" "$REPO_DIR"
fi

# ------------------------------------------------------------------ .env
if [ -f "$ENV_FILE" ]; then
  log ".env already exists — leaving it untouched."
else
  log "Creating .env from backend/.env.example (fill in real values!)"
  cp "$REPO_DIR/backend/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if ! grep -q "WATCHER_CONTACT" "$ENV_FILE"; then
    cat >> "$ENV_FILE" <<'EOF'

# Contact for docs-watcher User-Agent (descriptive UA required by some
# upstreams, e.g. SEC EDGAR). Fill in before relying on watcher reports.
# WATCHER_CONTACT=you@example.com
EOF
  fi
fi

# ---------------------------------------------------------- python venv
if [ ! -x "$VENV/bin/python" ]; then
  log "Creating Python venv..."
  python3 -m venv "$VENV"
fi
log "Installing Python dependencies..."
"$VENV/bin/pip" install -q -r "$REPO_DIR/backend/requirements.txt" \
                              -r "$REPO_DIR/docs-watcher/requirements.txt"

# ---------------------------------------------------------- SDK build+test
log "Installing SDK dependencies (npm ci)..."
npm ci --prefix "$REPO_DIR/sdk/packages/sdk" --no-audit --no-fund
log "Building SDK..."
npm run --prefix "$REPO_DIR/sdk/packages/sdk" build
log "Running SDK offline tests..."
npm test --prefix "$REPO_DIR/sdk/packages/sdk"

# ---------------------------------------------------------- backend tests
log "Running backend offline tests..."
(cd "$REPO_DIR/backend" && "$VENV/bin/python" -m pytest -q)

# ---------------------------------------------------------- watcher tests
log "Running docs-watcher offline tests..."
(cd "$REPO_DIR/docs-watcher" && "$VENV/bin/python" -m pytest -q)

# ---------------------------------------------------------- data dir
mkdir -p "$REPO_DIR/backend/data"

# ---------------------------------------------------------- systemd: API
log "Installing systemd unit: unified-api.service"
cat > /etc/systemd/system/unified-api.service <<EOF
[Unit]
Description=Unified Data API - licensing/metering backend
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR/backend
EnvironmentFile=$ENV_FILE
ExecStart=$VENV/bin/uvicorn app.main:app --host 0.0.0.0 --port $API_PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------- systemd: watcher
log "Installing systemd units: docs-watcher (daily full + hourly tier0)"
cat > /etc/systemd/system/unified-docs-watcher.service <<EOF
[Unit]
Description=Unified Data API docs-watcher (daily full run)
After=network.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR/docs-watcher
EnvironmentFile=$ENV_FILE
ExecStart=$VENV/bin/python watcher.py
EOF
cat > /etc/systemd/system/unified-docs-watcher-tier0.service <<EOF
[Unit]
Description=Unified Data API docs-watcher (hourly Tier-0 crypto run)
After=network.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR/docs-watcher
EnvironmentFile=$ENV_FILE
ExecStart=$VENV/bin/python watcher.py --tier0
EOF
cat > /etc/systemd/system/unified-docs-watcher.timer <<EOF
[Unit]
Description=Daily docs-watcher run

[Timer]
OnCalendar=daily
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/unified-docs-watcher-tier0.timer <<EOF
[Unit]
Description=Hourly Tier-0 docs-watcher run

[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
EOF

# ---------------------------------------------------------- landing page
if command -v nginx >/dev/null 2>&1; then
  log "nginx found — serving landing page via nginx on :$LANDING_PORT"
  cat > /etc/nginx/sites-available/unified-landing <<EOF
server {
    listen $LANDING_PORT;
    server_name _;
    root $REPO_DIR/landing;
    index index.html;
    location / { try_files \$uri \$uri/ =404; }
}
EOF
  ln -sf /etc/nginx/sites-available/unified-landing /etc/nginx/sites-enabled/unified-landing
  nginx -t
  systemctl reload nginx || systemctl restart nginx
  systemctl disable --now unified-landing.service 2>/dev/null || true
else
  warn "nginx not present — using python http.server fallback on :$LANDING_PORT"
  cat > /etc/systemd/system/unified-landing.service <<EOF
[Unit]
Description=Unified Data API landing page (static fallback)
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR/landing
ExecStart=/usr/bin/python3 -m http.server $LANDING_PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl enable --now unified-landing.service
fi

# ---------------------------------------------------------- enable all
log "Enabling and starting services..."
systemctl daemon-reload
systemctl enable --now unified-api.service
systemctl enable --now unified-docs-watcher.timer
systemctl enable --now unified-docs-watcher-tier0.timer

# ---------------------------------------------------------- optional npm publish
if [ -n "${NPM_TOKEN:-}" ]; then
  log "NPM_TOKEN set — publishing @unified-data/sdk..."
  NPMRC_TMP="$(mktemp)"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC_TMP"
  ( cd "$REPO_DIR/sdk/packages/sdk" && npm publish --userconfig "$NPMRC_TMP" --registry https://registry.npmjs.org/ )
  rm -f "$NPMRC_TMP"
  unset NPM_TOKEN
  log "npm publish done."
else
  log "NPM_TOKEN not set — skipping npm publish (export NPM_TOKEN=<token> to enable)."
fi

# ---------------------------------------------------------------- summary
echo
log "Deploy complete."
log "  API backend : http://<server-ip>:$API_PORT  (service: unified-api)"
log "  Landing page: http://<server-ip>:$LANDING_PORT"
log "  Watcher     : daily full + hourly tier0 (timers active)"
log "  Secrets     : $ENV_FILE  (fill in real values, then: systemctl restart unified-api)"
log "  Health      : curl http://localhost:$API_PORT/v1/health"
systemctl --no-pager --type=service list-units 'unified-*' | grep -E 'unified-(api|landing)' || true
