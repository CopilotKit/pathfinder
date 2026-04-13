#!/usr/bin/env bash
# Verify package.json version matches src/cli.ts version.
# Run as: ./scripts/check-version-sync.sh
# Used by: static-quality CI, can also be used as a pre-commit hook.

set -euo pipefail

PKG_VERSION=$(node -p "require('./package.json').version")
CLI_VERSION=$(sed -n 's/.*\.version("\([^"]*\)").*/\1/p' src/cli.ts)

if [ -z "$CLI_VERSION" ]; then
  echo "❌ Could not extract version from src/cli.ts"
  exit 1
fi

if [ "$PKG_VERSION" != "$CLI_VERSION" ]; then
  echo "❌ Version mismatch: package.json=$PKG_VERSION, cli.ts=$CLI_VERSION"
  echo "   Update src/cli.ts .version() to match package.json"
  exit 1
fi

echo "✓ Versions in sync: $PKG_VERSION"
