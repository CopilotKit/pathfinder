// Resolves MCP_JWT_SECRET with dev/prod policy. Cached after first resolution
// so generated dev secrets remain stable within a single process.

import { randomBytes } from "node:crypto";

const MIN_BYTES = 16;

let cached: string | null = null;

export function resolveJwtSecret(opts: { nodeEnv: string }): string {
  if (cached !== null) return cached;

  const fromEnv = process.env.MCP_JWT_SECRET;
  if (fromEnv && fromEnv.length > 0) {
    if (Buffer.byteLength(fromEnv, "utf8") < MIN_BYTES) {
      throw new Error(
        `MCP_JWT_SECRET must be at least ${MIN_BYTES} bytes. ` +
          "Generate with: openssl rand -hex 32",
      );
    }
    cached = fromEnv;
    return cached;
  }

  if (opts.nodeEnv === "production") {
    throw new Error(
      "MCP_JWT_SECRET is required in production. " +
        "Generate with: openssl rand -hex 32",
    );
  }

  const generated = randomBytes(32).toString("hex");
  console.warn(
    "[oauth] MCP_JWT_SECRET not set — generated an ephemeral secret for development. " +
      "All issued tokens will be invalidated on restart. " +
      "Set MCP_JWT_SECRET to persist across restarts.",
  );
  cached = generated;
  return cached;
}

export function resetJwtSecretCache(): void {
  cached = null;
}
