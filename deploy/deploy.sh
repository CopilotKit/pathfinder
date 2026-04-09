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
echo "=== mcp-docs — Railway Deploy ==="
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

check_cmd railway "railway CLI"
success "railway CLI found"

# Verify railway is logged in
if ! railway whoami &>/dev/null; then
    error "Not logged in to Railway. Run: railway login"
    exit 1
fi
success "railway authenticated"

# Check .env exists
if [ ! -f .env ]; then
    error ".env not found. Run: scripts/setup.sh"
    exit 1
fi
success ".env found"

# Verify required vars in .env
env_val() {
    local key="$1"
    grep "^${key}=" .env 2>/dev/null | cut -d= -f2- || true
}

OPENAI_KEY="$(env_val OPENAI_API_KEY)"
WEBHOOK_SECRET="$(env_val GITHUB_WEBHOOK_SECRET)"

if [ -z "$OPENAI_KEY" ] || [ "$OPENAI_KEY" = "sk-..." ]; then
    error "OPENAI_API_KEY not set in .env"
    exit 1
fi
success "OPENAI_API_KEY present"

if [ -z "$WEBHOOK_SECRET" ] || [ "$WEBHOOK_SECRET" = "whsec_..." ]; then
    error "GITHUB_WEBHOOK_SECRET not set in .env"
    exit 1
fi
success "GITHUB_WEBHOOK_SECRET present"

echo ""

# ── Railway project ────────────────────────────────────────────

echo "Checking Railway project..."

if railway status &>/dev/null 2>&1; then
    success "Railway project already linked"
else
    warn "No Railway project linked, initializing..."
    railway init
    success "Railway project initialized"
fi

echo ""

# ── PostgreSQL ─────────────────────────────────────────────────

echo "Checking PostgreSQL..."

# Check if a Postgres plugin/service is attached by looking for DATABASE_URL in railway vars
if railway variables 2>/dev/null | grep -q "DATABASE_URL"; then
    success "PostgreSQL already attached (DATABASE_URL found)"
else
    warn "No DATABASE_URL found. Adding PostgreSQL..."
    railway add --plugin postgresql
    success "PostgreSQL plugin added"
    echo "  Waiting for PostgreSQL to provision..."
    sleep 10
fi

# Enable pgvector extension
echo "Enabling pgvector extension..."
if railway run psql "\$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null; then
    success "pgvector extension enabled"
else
    warn "Could not enable pgvector — DATABASE_URL may not be ready yet"
    warn "  You can run manually after deploy:"
    warn "  railway run psql \"\$DATABASE_URL\" -c \"CREATE EXTENSION IF NOT EXISTS vector;\""
fi

echo ""

# ── Environment variables ──────────────────────────────────────

echo "Setting environment variables..."

railway variables set OPENAI_API_KEY="$OPENAI_KEY"
success "OPENAI_API_KEY set"

railway variables set GITHUB_WEBHOOK_SECRET="$WEBHOOK_SECRET"
success "GITHUB_WEBHOOK_SECRET set"

railway variables set NODE_ENV=production
success "NODE_ENV set"

GITHUB_TOKEN="$(env_val GITHUB_TOKEN)"
if [ -n "$GITHUB_TOKEN" ]; then
    railway variables set GITHUB_TOKEN="$GITHUB_TOKEN"
    success "GITHUB_TOKEN set"
else
    warn "GITHUB_TOKEN not set in .env, skipping"
fi

echo ""

# ── Deploy ─────────────────────────────────────────────────────

echo "Deploying to Railway..."
railway up --detach
success "Deployment triggered"

echo ""

# ── Wait for deployment ────────────────────────────────────────

echo "Waiting for deployment to become live..."

# Get the Railway-assigned domain
RAILWAY_URL=""
RETRIES=60
while [ $RETRIES -gt 0 ]; do
    # Try to extract the public domain from railway status or domain command
    RAILWAY_URL="$(railway domain 2>/dev/null || true)"
    if [ -n "$RAILWAY_URL" ]; then
        break
    fi
    RETRIES=$((RETRIES - 1))
    sleep 5
done

if [ -z "$RAILWAY_URL" ]; then
    warn "Could not determine Railway URL automatically"
    warn "Check your Railway dashboard for the deployment URL"
    RAILWAY_URL="<your-railway-url>"
else
    # Ensure URL has https prefix
    if [[ "$RAILWAY_URL" != https://* ]]; then
        RAILWAY_URL="https://${RAILWAY_URL}"
    fi
    success "Railway URL: $RAILWAY_URL"

    # Poll the health endpoint
    echo "Polling health endpoint..."
    RETRIES=60
    HEALTHY=0
    while [ $RETRIES -gt 0 ]; do
        HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" "${RAILWAY_URL}/health" 2>/dev/null || echo "000")"
        if [ "$HTTP_CODE" = "200" ]; then
            HEALTHY=1
            break
        fi
        RETRIES=$((RETRIES - 1))
        sleep 5
    done

    if [ "$HEALTHY" -eq 1 ]; then
        success "Deployment is live and healthy"
    else
        warn "Health endpoint not responding yet — deployment may still be starting"
        warn "Check: curl ${RAILWAY_URL}/health"
    fi
fi

echo ""

# ── Initial seed ───────────────────────────────────────────────

echo "Running initial index seed..."
if railway run npx tsx scripts/seed-index.ts; then
    success "Index seeded successfully"
else
    warn "Seed failed — you can retry with:"
    warn "  railway run npx tsx scripts/seed-index.ts"
fi

echo ""

# ── Done ───────────────────────────────────────────────────────

echo "=== Deployment complete! ==="
echo ""
echo "Railway URL: $RAILWAY_URL"
echo ""
echo "Next steps:"
echo "  1. Set a custom domain:  railway domain"
echo "  2. Configure webhooks:   scripts/setup-webhooks.sh"
echo "  3. Verify MCP endpoint:  curl ${RAILWAY_URL}/health"
echo ""
