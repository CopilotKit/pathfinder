import { describe, it, expect } from "vitest";
import { FileSourceConfigSchema } from "../types.js";

describe("document type schema validation", () => {
  it("accepts document as a valid source type", () => {
    const result = FileSourceConfigSchema.safeParse({
      name: "specs",
      type: "document",
      path: "docs/",
      file_patterns: ["**/*.pdf"],
      chunk: {},
    });
    expect(result.success).toBe(true);
  });
});

describe("document type registration", () => {
  it("document type is registered in provider registry", async () => {
    // Import the registry and verify 'document' maps to FileDataProvider
    const { getProvider } = await import("../indexing/providers/index.js");
    const provider = getProvider("document");
    expect(provider).toBeDefined();
  });

  it("document type is registered in chunker registry", async () => {
    const { getChunker } = await import("../indexing/chunking/index.js");
    const chunker = getChunker("document");
    expect(chunker).toBeDefined();
  });
});

describe("backwards compatibility", () => {
  it("markdown source type still works after document type addition", async () => {
    const { getProvider } = await import("../indexing/providers/index.js");
    const provider = getProvider("markdown");
    expect(provider).toBeDefined();
  });

  it("html source type still works after document type addition", async () => {
    const { getProvider } = await import("../indexing/providers/index.js");
    const provider = getProvider("html");
    expect(provider).toBeDefined();
  });

  it("code source type still works after document type addition", async () => {
    const { getProvider } = await import("../indexing/providers/index.js");
    const provider = getProvider("code");
    expect(provider).toBeDefined();
  });
});
