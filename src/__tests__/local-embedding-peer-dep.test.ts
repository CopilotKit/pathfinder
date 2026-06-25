/**
 * #88 (local-embeddings closeout) — `embedding.provider: local` without the
 * `@xenova/transformers` peer must fail LOUDLY and EARLY:
 *   - the eager startup guard throws the actionable message at boot, and
 *   - `validate` records it as a WARNING (exit 0), not a hard error (exit 1).
 *
 * These tests exercise the shared dep-resolution helpers in config.ts and the
 * validate warning surface, injecting `tryImport` so present/absent cases run
 * without manipulating node_modules.
 */
import { describe, it, expect } from "vitest";
import {
  resolveLocalEmbeddingDep,
  assertLocalEmbeddingDepForProvider,
  LOCAL_EMBEDDING_DEP_MESSAGE,
} from "../config.js";

function moduleNotFound(pkg: string): Error & { code: string } {
  const err = new Error(`Cannot find module '${pkg}'`) as Error & {
    code: string;
  };
  err.code = "ERR_MODULE_NOT_FOUND";
  return err;
}

const absentImport = async (mod: string) => {
  if (mod === "@xenova/transformers") throw moduleNotFound(mod);
  return {};
};
const presentImport = async (_mod: string) => ({});

describe("resolveLocalEmbeddingDep (#88)", () => {
  it("returns false when @xenova/transformers is absent", async () => {
    await expect(
      resolveLocalEmbeddingDep({ tryImport: absentImport }),
    ).resolves.toBe(false);
  });

  it("returns true when @xenova/transformers is present", async () => {
    await expect(
      resolveLocalEmbeddingDep({ tryImport: presentImport }),
    ).resolves.toBe(true);
  });
});

describe("assertLocalEmbeddingDepForProvider (#88 startup guard)", () => {
  it("throws the actionable message for provider=local + dep absent", async () => {
    await expect(
      assertLocalEmbeddingDepForProvider("local", { tryImport: absentImport }),
    ).rejects.toThrow(/@xenova\/transformers/);
    // Message must point at BOTH remediations: npm install AND the -local image.
    await expect(
      assertLocalEmbeddingDepForProvider("local", { tryImport: absentImport }),
    ).rejects.toThrow(/latest-local/);
  });

  it("does NOT throw for provider=local + dep present", async () => {
    await expect(
      assertLocalEmbeddingDepForProvider("local", { tryImport: presentImport }),
    ).resolves.toBeUndefined();
  });

  it("does NOT throw for a non-local provider even when the dep is absent (no false positive)", async () => {
    await expect(
      assertLocalEmbeddingDepForProvider("openai", { tryImport: absentImport }),
    ).resolves.toBeUndefined();
    await expect(
      assertLocalEmbeddingDepForProvider(undefined, {
        tryImport: absentImport,
      }),
    ).resolves.toBeUndefined();
  });

  it("exposes a single shared message used by both surfaces", () => {
    expect(LOCAL_EMBEDDING_DEP_MESSAGE).toMatch(/@xenova\/transformers/);
    expect(LOCAL_EMBEDDING_DEP_MESSAGE).toMatch(/latest-local/);
  });
});
