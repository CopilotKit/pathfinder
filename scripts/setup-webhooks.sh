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
echo "=== CopilotKit MCP Docs Server — GitHub Webhook Setup ==="
echo ""

# ── Repos to configure ─────────────────────────────────────────

REPOS=(
    "CopilotKit/CopilotKit"
    "CopilotKit/with-agno"
    "CopilotKit/with-crewai-flows"
    "CopilotKit/with-langgraph-fastapi"
    "CopilotKit/with-langgraph-js"
    "CopilotKit/with-langgraph-python"
    "CopilotKit/with-llamaindex"
    "CopilotKit/with-mastra"
)

# ── Prerequisites ──────────────────────────────────────────────

if ! command -v gh &>/dev/null; then
    error "gh CLI is required but not installed"
    error "Install: https://cli.github.com/"
    exit 1
fi
success "gh CLI found"

if ! gh auth status &>/dev/null 2>&1; then
    error "gh CLI not authenticated. Run: gh auth login"
    exit 1
fi
success "gh CLI authenticated"

echo ""

# ── Read webhook secret from .env ──────────────────────────────

if [ ! -f .env ]; then
    error ".env not found. Run: scripts/setup.sh"
    exit 1
fi

WEBHOOK_SECRET="$(grep "^GITHUB_WEBHOOK_SECRET=" .env 2>/dev/null | cut -d= -f2- || true)"

if [ -z "$WEBHOOK_SECRET" ] || [ "$WEBHOOK_SECRET" = "whsec_..." ]; then
    error "GITHUB_WEBHOOK_SECRET not set in .env"
    exit 1
fi
success "GITHUB_WEBHOOK_SECRET loaded from .env"

echo ""

# ── Webhook URL ────────────────────────────────────────────────

DEFAULT_URL="https://mcp.copilotkit.ai/webhooks/github"

printf "Webhook URL [%s]: " "$DEFAULT_URL"
read -r WEBHOOK_URL
WEBHOOK_URL="${WEBHOOK_URL:-$DEFAULT_URL}"

echo ""
echo "Configuring webhooks for: $WEBHOOK_URL"
echo ""

# ── Configure webhooks ─────────────────────────────────────────

CREATED=0
UPDATED=0
SKIPPED=0
FAILED=0

for REPO in "${REPOS[@]}"; do
    printf "  %-40s " "$REPO"

    # List existing webhooks and check if one matches our URL
    EXISTING_HOOK_ID=""
    EXISTING_HOOK_ID="$(
        gh api "repos/${REPO}/hooks" --jq ".[] | select(.config.url == \"${WEBHOOK_URL}\") | .id" 2>/dev/null || true
    )"

    if [ -n "$EXISTING_HOOK_ID" ]; then
        # Update the existing webhook (secret may have changed)
        if gh api "repos/${REPO}/hooks/${EXISTING_HOOK_ID}" --method PATCH \
            -f "config[url]=${WEBHOOK_URL}" \
            -f "config[content_type]=json" \
            -f "config[secret]=${WEBHOOK_SECRET}" \
            -F "active=true" &>/dev/null; then
            printf "${GREEN}updated${NC} (hook #%s)\n" "$EXISTING_HOOK_ID"
            UPDATED=$((UPDATED + 1))
        else
            printf "${RED}update failed${NC}\n"
            FAILED=$((FAILED + 1))
        fi
    else
        # Create a new webhook
        if gh api "repos/${REPO}/hooks" --method POST \
            -f "config[url]=${WEBHOOK_URL}" \
            -f "config[content_type]=json" \
            -f "config[secret]=${WEBHOOK_SECRET}" \
            -F "events[]=push" \
            -F "active=true" &>/dev/null; then
            printf "${GREEN}created${NC}\n"
            CREATED=$((CREATED + 1))
        else
            printf "${RED}create failed${NC}\n"
            FAILED=$((FAILED + 1))
        fi
    fi
done

echo ""

# ── Summary ────────────────────────────────────────────────────

echo "=== Webhook Setup Summary ==="
echo ""
echo "  Repos processed:  ${#REPOS[@]}"
[ "$CREATED" -gt 0 ] && success "$CREATED webhook(s) created"
[ "$UPDATED" -gt 0 ] && success "$UPDATED webhook(s) updated"
[ "$FAILED" -gt 0 ]  && error "$FAILED webhook(s) failed"
echo ""

if [ "$FAILED" -gt 0 ]; then
    warn "Some webhooks failed. Verify you have admin access to those repos."
    warn "You can also configure webhooks manually in each repo's Settings > Webhooks."
fi

echo "Webhook URL:    $WEBHOOK_URL"
echo "Events:         push"
echo "Content type:   application/json"
echo ""
