/**
 * R4-13 — document sources referencing PDFs or DOCX must surface a clear
 * error message naming the missing peer dependency (`pdf-parse` or
 * `mammoth`). Also verify package.json advertises them as optional peer
 * deps so `npm install` doesn't try to pull them implicitly.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("package.json optional peer deps for document extraction (R4-13)", () => {
  it("declares pdf-parse and mammoth as optional peer dependencies", () => {
    const pkgPath = resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(pkg.peerDependencies?.["pdf-parse"]).toBeDefined();
    expect(pkg.peerDependencies?.["mammoth"]).toBeDefined();
    expect(pkg.peerDependenciesMeta?.["pdf-parse"]?.optional).toBe(true);
    expect(pkg.peerDependenciesMeta?.["mammoth"]?.optional).toBe(true);
  });
});

describe("assertDocumentPeerDepsForSources (R4-13)", () => {
  /**
   * Helper: build a MODULE_NOT_FOUND error in the shape Node's dynamic
   * `import()` rejects with — Error instance carrying `.code` = one of
   * ERR_MODULE_NOT_FOUND (ESM) / MODULE_NOT_FOUND (CJS). The peer-dep
   * helper distinguishes these from other throws so it can classify
   * "not installed" vs "installed but broken".
   */
  function moduleNotFound(pkg: string): Error & { code: string } {
    const err = new Error(`Cannot find module '${pkg}'`) as Error & {
      code: string;
    };
    err.code = "ERR_MODULE_NOT_FOUND";
    return err;
  }

  it("throws naming pdf-parse when a document source pulls PDFs but the peer is missing", async () => {
    const { assertDocumentPeerDepsForSources } = await import("../config.js");
    const sources = [
      {
        name: "handbook",
        type: "document" as const,
        path: "./docs",
        file_patterns: ["*.pdf"],
      },
    ];
    await expect(
      assertDocumentPeerDepsForSources(sources, {
        tryImport: async (mod: string) => {
          if (mod === "pdf-parse") throw moduleNotFound("pdf-parse");
          return {};
        },
      }),
    ).rejects.toThrow(/pdf-parse/);
  });

  it("throws naming mammoth when a document source pulls DOCXs but the peer is missing", async () => {
    const { assertDocumentPeerDepsForSources } = await import("../config.js");
    const sources = [
      {
        name: "handbook",
        type: "document" as const,
        path: "./docs",
        file_patterns: ["*.docx"],
      },
    ];
    await expect(
      assertDocumentPeerDepsForSources(sources, {
        tryImport: async (mod: string) => {
          if (mod === "mammoth") throw moduleNotFound("mammoth");
          return {};
        },
      }),
    ).rejects.toThrow(/mammoth/);
  });

  it("surfaces a distinct 'installed but failed to import' error when the peer throws a non-MODULE_NOT_FOUND error", async () => {
    // Regression: the previous empty catch swallowed every throw as "peer
    // missing", producing a confusing install-hint message even when the
    // peer WAS installed but failed to load (native-addon ABI mismatch,
    // ESM/CJS interop throw, fs permission error). This test injects a
    // runtime TypeError to simulate that case and asserts the surfaced
    // error is DIFFERENT from the missing-peer path.
    const { assertDocumentPeerDepsForSources } = await import("../config.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sources = [
        {
          name: "handbook",
          type: "document" as const,
          path: "./docs",
          file_patterns: ["*.pdf"],
        },
      ];
      await expect(
        assertDocumentPeerDepsForSources(sources, {
          tryImport: async (mod: string) => {
            if (mod === "pdf-parse") {
              throw new TypeError(
                "Cannot read properties of undefined (reading 'default')",
              );
            }
            return {};
          },
        }),
      ).rejects.toThrow(/installed but failed to import/);
      // Full stack was logged so operators can diagnose the real cause.
      const stackCalls = errSpy.mock.calls.filter((args: unknown[]) =>
        String(args[0] ?? "").includes("installed but failed to import"),
      );
      expect(stackCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does not throw when the peer is installed", async () => {
    const { assertDocumentPeerDepsForSources } = await import("../config.js");
    const sources = [
      {
        name: "handbook",
        type: "document" as const,
        path: "./docs",
        file_patterns: ["*.pdf"],
      },
    ];
    await expect(
      assertDocumentPeerDepsForSources(sources, {
        tryImport: async (_m: string) => ({}),
      }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when no document sources are configured", async () => {
    const { assertDocumentPeerDepsForSources } = await import("../config.js");
    const calls: string[] = [];
    await assertDocumentPeerDepsForSources(
      [{ name: "site", type: "website" as const }],
      {
        tryImport: async (m: string) => {
          calls.push(m);
          return {};
        },
      },
    );
    expect(calls).toEqual([]);
  });
});
