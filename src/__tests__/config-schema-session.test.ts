import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
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

describe("ServerConfigSchema — modern limit keys", () => {
  for (const key of [
    "modern_rpm_per_ip",
    "modern_burst_per_ip",
    "modern_max_inflight",
    "modern_request_timeout_ms",
  ] as const) {
    describe(key, () => {
      it("accepts 1", () => {
        const result = ServerConfigSchema.parse({
          ...base,
          server: { ...base.server, [key]: 1 },
        });
        expect(result.server[key]).toBe(1);
      });

      for (const bad of [0, -1, 1.5]) {
        it(`rejects ${bad}`, () => {
          expect(() =>
            ServerConfigSchema.parse({
              ...base,
              server: { ...base.server, [key]: bad },
            }),
          ).toThrow();
        });
      }

      it("is optional (defaults to undefined)", () => {
        const result = ServerConfigSchema.parse(base);
        expect(result.server[key]).toBeUndefined();
      });
    });
  }

  // Node's setTimeout turns any delay above 2^31-1 ms into 1 ms, so a larger
  // deadline would expire every request at once. Config load must reject it.
  it("modern_request_timeout_ms accepts 2^31-1 and rejects 2^31", () => {
    const parse = (v: number) =>
      ServerConfigSchema.parse({
        ...base,
        server: { ...base.server, modern_request_timeout_ms: v },
      });
    expect(parse(2 ** 31 - 1).server.modern_request_timeout_ms).toBe(
      2 ** 31 - 1,
    );
    expect(() => parse(2 ** 31)).toThrow();
    expect(() => parse(3_000_000_000)).toThrow();
  });

  it("the deploy YAMLs still parse", () => {
    const dir = join(__dirname, "..", "..", "deploy");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBe(3);
    for (const f of files) {
      const raw = parseYaml(readFileSync(join(dir, f), "utf8"));
      expect(() => ServerConfigSchema.parse(raw), f).not.toThrow();
    }
  });
});
