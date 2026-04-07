#!/usr/bin/env bash
# Smoke test for Pathfinder production
# Run BEFORE and AFTER merge to compare results.
#
# Usage:
#   ./scripts/smoke-test.sh https://mcp.copilotkit.ai > before.txt
#   # ... merge ...
#   ./scripts/smoke-test.sh https://mcp.copilotkit.ai > after.txt
#   diff before.txt after.txt

set -euo pipefail

BASE_URL="${1:-https://mcp.copilotkit.ai}"
ACCEPT="Accept: application/json, text/event-stream"
CT="Content-Type: application/json"

# Extract JSON from SSE response (event: message\ndata: {...})
parse_sse() {
    grep '^data: ' | head -1 | sed 's/^data: //'
}

echo "=== Pathfinder Smoke Test ==="
echo "Target: $BASE_URL"
echo "Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# 1. Health check
echo "--- Health Check ---"
curl -sf "$BASE_URL/health" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"Status: {d['status']}\")
print(f\"Server: {d.get('server', 'N/A')}\")
if isinstance(d.get('index'), dict):
    print(f\"Chunks: {d['index']['total_chunks']}\")
    for s in d['index'].get('sources', []):
        print(f\"  {s['key']}: {s['status']} @ {s.get('commit','?')[:8]}\")
else:
    print(f\"Index: {d.get('index', 'N/A')}\")
" 2>/dev/null || echo "FAILED: Health check unreachable"
echo ""

# 2. Initialize MCP session
echo "--- MCP Session ---"
INIT_HEADERS=$(mktemp)
curl -s -X POST "$BASE_URL/mcp" \
  -H "$CT" -H "$ACCEPT" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}},"id":1}' \
  -D "$INIT_HEADERS" > /dev/null 2>&1

SESSION_ID=$(grep -oi 'mcp-session-id: [a-f0-9-]*' "$INIT_HEADERS" | cut -d' ' -f2 || true)
rm -f "$INIT_HEADERS"

if [ -z "$SESSION_ID" ]; then
    echo "FAILED: Could not establish MCP session"
    echo ""
    echo "=== Done (partial) ==="
    exit 1
fi
echo "Session: ${SESSION_ID:0:8}..."

# Helper: call MCP method and extract JSON from SSE
mcp_call() {
    curl -s -X POST "$BASE_URL/mcp" \
      -H "$CT" -H "$ACCEPT" \
      -H "Mcp-Session-Id: $SESSION_ID" \
      -d "$1" | parse_sse
}

# 3. List tools
echo ""
echo "--- Tools ---"
TOOLS_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/list","id":2}')
echo "$TOOLS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tools = d.get('result', {}).get('tools', [])
for t in sorted(tools, key=lambda x: x['name']):
    params = [p for p in t.get('inputSchema', {}).get('properties', {}).keys()]
    print(f\"  {t['name']}({', '.join(params)})\")
print(f\"Total: {len(tools)} tools\")
" 2>/dev/null || echo "FAILED: tools/list"

# 4. Search tests — 3 queries, capture top result title
echo ""
echo "--- Search Results ---"
for QUERY in "how to use useCopilotAction" "authentication setup" "streaming response handling"; do
    BODY="{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"search-docs\",\"arguments\":{\"query\":\"$QUERY\",\"limit\":3}},\"id\":3}"
    SEARCH_JSON=$(mcp_call "$BODY")
    echo "Query: \"$QUERY\""
    echo "$SEARCH_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
text = d.get('result', {}).get('content', [{}])[0].get('text', '')
lines = text.split('\n')
for line in lines:
    if line.startswith('TITLE:') or line.startswith('SNIPPET'):
        print(f\"  {line.strip()}\")
if 'No results' in text:
    print('  No results found')
" 2>/dev/null || echo "  FAILED"
done

# 5. Bash tool — find and grep
echo ""
echo "--- Bash Tool ---"
BASH_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"explore-docs","arguments":{"command":"find / -name \"*.mdx\" | head -5"}},"id":4}')
echo "find / -name '*.mdx' | head -5:"
echo "$BASH_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
text = d.get('result', {}).get('content', [{}])[0].get('text', '')
for line in text.split('\n')[1:6]:
    if line.strip():
        print(f\"  {line}\")
" 2>/dev/null || echo "  FAILED"

GREP_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"explore-docs","arguments":{"command":"grep -rl \"useCopilotAction\" /docs | head -3"}},"id":5}')
echo ""
echo "grep -rl 'useCopilotAction' /docs | head -3:"
echo "$GREP_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
text = d.get('result', {}).get('content', [{}])[0].get('text', '')
for line in text.split('\n')[1:4]:
    if line.strip():
        print(f\"  {line}\")
" 2>/dev/null || echo "  FAILED"

# 6. New endpoints (v1.3)
echo ""
echo "--- New Endpoints (v1.3) ---"
echo -n "GET /llms.txt: "
LLMS_STATUS=$(curl -so /dev/null -w "%{http_code}" "$BASE_URL/llms.txt" 2>/dev/null || echo "000")
if [ "$LLMS_STATUS" = "200" ]; then
    LLMS_LINES=$(curl -sf "$BASE_URL/llms.txt" 2>/dev/null | wc -l | tr -d ' ')
    echo "OK ($LLMS_LINES lines)"
else
    echo "HTTP $LLMS_STATUS (not deployed yet — expected before merge)"
fi

echo -n "GET /llms-full.txt: "
FULL_STATUS=$(curl -so /dev/null -w "%{http_code}" "$BASE_URL/llms-full.txt" 2>/dev/null || echo "000")
if [ "$FULL_STATUS" = "200" ]; then
    FULL_SIZE=$(curl -sf "$BASE_URL/llms-full.txt" 2>/dev/null | wc -c | tr -d ' ')
    echo "OK ($FULL_SIZE bytes)"
else
    echo "HTTP $FULL_STATUS (not deployed yet — expected before merge)"
fi

echo -n "GET /.well-known/skills/default/skill.md: "
SKILL_STATUS=$(curl -so /dev/null -w "%{http_code}" "$BASE_URL/.well-known/skills/default/skill.md" 2>/dev/null || echo "000")
if [ "$SKILL_STATUS" = "200" ]; then
    echo "OK"
else
    echo "HTTP $SKILL_STATUS (not deployed yet — expected before merge)"
fi

echo -n "Link header: "
LINK_HEADER=$(curl -sI "$BASE_URL/health" 2>/dev/null | grep -i "^link:" | tr -d '\r' || true)
if [ -n "$LINK_HEADER" ]; then
    echo "$LINK_HEADER"
else
    echo "not present (not deployed yet — expected before merge)"
fi

# 7. Clean up
curl -s -X DELETE "$BASE_URL/mcp" \
  -H "Mcp-Session-Id: $SESSION_ID" > /dev/null 2>&1 || true

echo ""
echo "=== Done ==="
