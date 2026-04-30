import { describe, it, expect } from "vitest";
import { ServerConfigSchema } from "../types.js";

const base = {
  server: { name: "test", version: "1.0.0" },
  sources: [
    {
      name: "docs",
      type: "markdown",
      path: "./docs",
      file_patterns: ["**/*.md"],
      chunk: {},
    },
  ],
  tools: [
    {
      name: "run-cmd",
      type: "bash",
      description: "Run a command",
      sources: ["docs"],
    },
  ],
};

describe("ServerConfigSchema — max_sessions field", () => {
  it("accepts a positive integer", () => {
    const result = ServerConfigSchema.parse({
      ...base,
      server: { ...base.server, max_sessions: 1000 },
    });
    expect(result.server.max_sessions).toBe(1000);
  });

  it("rejects zero", () => {
    expect(() =>
      ServerConfigSchema.parse({
        ...base,
        server: { ...base.server, max_sessions: 0 },
      }),
    ).toThrow();
  });

  it("rejects non-integer", () => {
    expect(() =>
      ServerConfigSchema.parse({
        ...base,
        server: { ...base.server, max_sessions: 1.5 },
      }),
    ).toThrow();
  });

  it("is optional (defaults to undefined)", () => {
    const result = ServerConfigSchema.parse(base);
    expect(result.server.max_sessions).toBeUndefined();
  });
});

describe("ServerConfigSchema — session_unused_ttl_minutes field", () => {
  it("accepts a positive integer", () => {
    const result = ServerConfigSchema.parse({
      ...base,
      server: { ...base.server, session_unused_ttl_minutes: 15 },
    });
    expect(result.server.session_unused_ttl_minutes).toBe(15);
  });

  it("rejects negative values", () => {
    expect(() =>
      ServerConfigSchema.parse({
        ...base,
        server: { ...base.server, session_unused_ttl_minutes: -1 },
      }),
    ).toThrow();
  });

  it("is optional (defaults to undefined)", () => {
    const result = ServerConfigSchema.parse(base);
    expect(result.server.session_unused_ttl_minutes).toBeUndefined();
  });
});
