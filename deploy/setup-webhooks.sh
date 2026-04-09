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
echo "=== mcp-docs — GitHub Webhook Setup ==="
echo ""

# ── Parse arguments ───────────────────────────────────────────

CLI_REPOS=()
CLI_URL=""
for arg in "$@"; do
    case "$arg" in
        --repo=*) CLI_REPOS+=("${arg#--repo=}") ;;
        --url=*)  CLI_URL="${arg#--url=}" ;;
        --help|-h)
            echo "Usage: $0 [--repo=owner/repo ...] [--url=https://...]"
            echo ""
            echo "Options:"
            echo "  --repo=OWNER/REPO  Repository to configure (repeatable)"
            echo "  --url=URL          Webhook delivery URL"
            echo ""
            echo "If --repo is not provided, repos are read from webhook.repo_sources"
            echo "in mcp-docs.yaml. If --url is not provided, you will be prompted."
            exit 0
            ;;
    esac
done

# ── Repos to configure ─────────────────────────────────────────

if [ ${#CLI_REPOS[@]} -gt 0 ]; then
    REPOS=("${CLI_REPOS[@]}")
else
    # Try to read repos from mcp-docs.yaml webhook.repo_sources keys
    if [ -f mcp-docs.yaml ] && command -v python3 &>/dev/null; then
        mapfile -t REPOS < <(python3 -c "
import yaml, sys
with open('mcp-docs.yaml') as f:
    cfg = yaml.safe_load(f)
for repo in cfg.get('webhook', {}).get('repo_sources', {}):
    print(repo)
" 2>/dev/null || true)
    fi

    if [ ${#REPOS[@]} -eq 0 ]; then
        error "No repos found. Provide --repo=owner/repo or configure webhook.repo_sources in mcp-docs.yaml"
        exit 1
    fi
fi

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

if [ -n "$CLI_URL" ]; then
    WEBHOOK_URL="$CLI_URL"
else
    DEFAULT_URL="https://localhost:3001/webhooks/github"
    printf "Webhook URL [%s]: " "$DEFAULT_URL"
    read -r WEBHOOK_URL
    WEBHOOK_URL="${WEBHOOK_URL:-$DEFAULT_URL}"
fi

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
