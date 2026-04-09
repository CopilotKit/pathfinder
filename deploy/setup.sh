#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

success() { printf "${GREEN}✓${NC} %s\n" "$1"; }
error()   { printf "${RED}✗ %s${NC}\n" "$1" >&2; }
warn()    { printf "${YELLOW}⚠${NC} %s\n" "$1"; }

# Resolve project root (parent of scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo ""
echo "=== mcp-docs — Setup ==="
echo ""

# ── Prerequisites ──────────────────────────────────────────────

check_cmd() {
    local cmd="$1"
    local label="${2:-$cmd}"
    if ! command -v "$cmd" &>/dev/null; then
        error "$label is required but not installed"
        exit 1
    fi
}

check_cmd docker "docker"
success "docker found"

if docker compose version &>/dev/null; then
    success "docker compose found"
elif docker-compose version &>/dev/null; then
    success "docker-compose found"
else
    error "docker compose is required but not installed (tried 'docker compose' and 'docker-compose')"
    exit 1
fi

check_cmd node "node"
NODE_VERSION="$(node --version)"
success "node $NODE_VERSION found"

check_cmd npm "npm"
success "npm found"

echo ""

# ── .env ───────────────────────────────────────────────────────

if [ -f .env ]; then
    success ".env already exists, skipping copy"
else
    if [ ! -f .env.example ]; then
        error ".env.example not found — cannot create .env"
        exit 1
    fi
    cp .env.example .env
    echo "Creating .env from template..."
    success ".env created from .env.example"
fi

# Check for placeholder values regardless of whether .env was just created
NEEDS_EDIT=0
if grep -qE '^OPENAI_API_KEY=sk-\.\.\.' .env 2>/dev/null; then
    NEEDS_EDIT=1
fi
if grep -qE '^GITHUB_WEBHOOK_SECRET=whsec_\.\.\.' .env 2>/dev/null; then
    NEEDS_EDIT=1
fi
if [ "$NEEDS_EDIT" -eq 1 ]; then
    warn "Please edit .env and set OPENAI_API_KEY and GITHUB_WEBHOOK_SECRET"
fi

echo ""

# ── npm install ────────────────────────────────────────────────

echo "Installing dependencies..."
npm ci --loglevel=error
success "npm ci complete"

echo ""

# ── Docker images ──────────────────────────────────────────────

echo "Pulling Docker images..."
docker pull pgvector/pgvector:pg16 --quiet
success "Images pulled"

echo ""

echo "Building app image..."
docker compose build --quiet app
success "App image built"

echo ""

# ── Start DB and wait for healthy ──────────────────────────────

echo "Starting database..."
docker compose up -d db

RETRIES=30
until docker compose exec db pg_isready -U mcp &>/dev/null; do
    RETRIES=$((RETRIES - 1))
    if [ "$RETRIES" -le 0 ]; then
        error "Database did not become healthy in time"
        exit 1
    fi
    sleep 1
done
success "Database is healthy"

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your API keys"
echo "  2. docker compose up"
echo "  3. docker compose exec app npx tsx scripts/seed-index.ts"
echo "  4. docker compose exec app npx tsx scripts/test-search.ts \"your query\""
echo ""
