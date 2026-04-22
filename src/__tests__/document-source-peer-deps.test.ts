/**
 * R4-13 — document sources referencing PDFs or DOCX must surface a clear
 * error message naming the missing peer dependency (`pdf-parse` or
 * `mammoth`). Also verify package.json advertises them as optional peer
 * deps so `npm install` doesn't try to pull them implicitly.
 */
import { describe, it, expect } from "vitest";
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
          if (mod === "pdf-parse")
            throw new Error("Cannot find module 'pdf-parse'");
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
          if (mod === "mammoth")
            throw new Error("Cannot find module 'mammoth'");
          return {};
        },
      }),
    ).rejects.toThrow(/mammoth/);
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
