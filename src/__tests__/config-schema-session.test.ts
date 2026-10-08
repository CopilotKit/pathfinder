import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ServerConfigSchema } from "../types.js";
import {
  JSONRPC_CAPACITY_CODE,
  JSONRPC_RATE_LIMIT_CODE,
} from "../rate-limit-response.js";
import { droppedKeys } from "./helpers/dropped-keys.js";

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

/**
 * Parse `base` with `server` overrides. Returns the paths of the issues, or
 * [] when the config parses. A rejection test asserts the exact path, so it
 * cannot pass because some other part of the config became invalid.
 */
const rejectedPaths = (server: Record<string, unknown>): string[] => {
  const r = ServerConfigSchema.safeParse({
    ...base,
    server: { ...base.server, ...server },
  });
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
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
    expect(rejectedPaths({ max_sessions: 0 })).toEqual(["server.max_sessions"]);
  });

  it("rejects non-integer", () => {
    expect(rejectedPaths({ max_sessions: 1.5 })).toEqual([
      "server.max_sessions",
    ]);
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
    expect(rejectedPaths({ session_unused_ttl_minutes: -1 })).toEqual([
      "server.session_unused_ttl_minutes",
    ]);
  });

  it("is optional (defaults to undefined)", () => {
    const result = ServerConfigSchema.parse(base);
    expect(result.server.session_unused_ttl_minutes).toBeUndefined();
  });
});

describe("ServerConfigSchema — trust_proxy field", () => {
  it("accepts false, 0, a hop count and a CIDR list", () => {
    for (const v of [false, 0, 1, ["10.0.0.0/8"]]) {
      expect(rejectedPaths({ trust_proxy: v }), JSON.stringify(v)).toEqual([]);
    }
  });

  // docs/config/index.html says an empty list fails config load.
  it("rejects an empty list", () => {
    expect(rejectedPaths({ trust_proxy: [] })).toEqual(["server.trust_proxy"]);
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
          expect(rejectedPaths({ [key]: bad })).toEqual([`server.${key}`]);
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
    for (const v of [2 ** 31, 3_000_000_000]) {
      expect(
        rejectedPaths({ modern_request_timeout_ms: v }),
        String(v),
      ).toEqual(["server.modern_request_timeout_ms"]);
    }
  });

  // A plain parse strips unknown keys, so a misspelled key in a deploy YAML
  // would pass and then be ignored at runtime. Fail on any dropped key too.
  it("the deploy YAMLs parse, with no key the schema does not know", () => {
    const dir = join(__dirname, "..", "..", "deploy");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBe(3);
    for (const f of files) {
      const raw: unknown = parseYaml(readFileSync(join(dir, f), "utf8"));
      const result = ServerConfigSchema.safeParse(raw);
      expect(
        result.success
          ? []
          : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        f,
      ).toEqual([]);
      expect(droppedKeys(raw, result.data), f).toEqual([]);
    }
  });
});

// Docs consistency: the modern-leg facts are written by hand in several docs
// files. These rows tie them to the code, so a change to a default, an
// exemption or an event name fails here instead of in a later review round.
// Assertions match key phrases, not whole paragraphs.
describe("docs consistency — modern leg", () => {
  const root = join(__dirname, "..", "..");
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  const typesSrc = read("src/types.ts");
  const serverSrc = read("src/server.ts");
  const configHtml = read("docs/config/index.html");
  const exampleYaml = read("pathfinder.example.yaml");
  const readme = read("README.md");

  // The defaults server.ts applies (`serverCfg.server.<key> ?? <n>` in
  // src/server.ts, where the modern limiter, ceiling and route are built).
  // This is the one place the test names them; the first row checks that
  // server.ts still applies exactly these values.
  const CODE_DEFAULTS: Record<string, number> = {
    modern_rpm_per_ip: 120,
    modern_burst_per_ip: 60,
    modern_max_inflight: 200,
    modern_request_timeout_ms: 60000,
  };

  // The session defaults, applied the same way (`serverCfg.server.<key> ??
  // <n>` in startServer()). They are inline literals in server.ts, not named
  // constants, so the test reads them from the source like CODE_DEFAULTS.
  const SESSION_DEFAULTS: Record<string, number> = {
    max_sessions: 1000,
    max_sessions_per_ip: 20,
    session_ttl_minutes: 30,
    session_unused_ttl_minutes: 15,
  };

  // `serverCfg.server.<key> ?? <n>` in src/server.ts. The key must be
  // followed by `??`, so max_sessions does not match max_sessions_per_ip.
  const serverDefault = (key: string) =>
    serverSrc.match(new RegExp(`server\\.${key}\\s*\\?\\?\\s*(\\d+)`))?.[1];

  // The sample line for `key` in a docs/config/index.html code block: its
  // value, and the "(default: N)" comment on the same line.
  const htmlSampleLine = (key: string) =>
    configHtml.match(
      new RegExp(
        `<span class="key">${key}:</span>\\s*<span class="value">(\\d+)</span>[^\\n]*?\\(default:\\s*(\\d+)\\)`,
      ),
    );

  // Every modern_* key declared in the server schema in src/types.ts (the
  // zod chain may start on the next line).
  const schemaKeys = [...typesSrc.matchAll(/^\s+(modern_\w+):\s*z\s*\./gm)].map(
    (m) => m[1],
  );

  // The <li> that documents `key` in docs/config/index.html.
  const htmlItem = (key: string) => {
    const m = configHtml.match(
      new RegExp(`<strong>${key}</strong>([\\s\\S]*?)</li>`),
    );
    return m ? m[1] : "";
  };

  // The commented-out line(s) for `key` in pathfinder.example.yaml, up to the
  // next key line.
  const yamlEntry = (key: string) => {
    const m = exampleYaml.match(
      new RegExp(`^\\s*#\\s*${key}:[^\\n]*(?:\\n\\s*#\\s{3,}[^\\n]*)*`, "m"),
    );
    return m ? m[0] : "";
  };

  // The comment block directly above `key: z.` in src/types.ts.
  const typesComment = (key: string) => {
    const m = typesSrc.match(
      new RegExp(`((?:^\\s*//[^\\n]*\\n)+)\\s*${key}:\\s*z\\s*\\.`, "m"),
    );
    return m ? m[1] : "";
  };

  it("the schema keys and server.ts defaults match CODE_DEFAULTS", () => {
    expect(schemaKeys.sort()).toEqual(Object.keys(CODE_DEFAULTS).sort());
    for (const [key, def] of Object.entries(CODE_DEFAULTS)) {
      expect(serverDefault(key), `server.ts default for ${key}`).toBe(
        String(def),
      );
    }
  });

  for (const [key, def] of Object.entries(SESSION_DEFAULTS)) {
    it(`${key}: server.ts, docs/config/index.html and pathfinder.example.yaml agree on default ${def}`, () => {
      expect(serverDefault(key), `server.ts default for ${key}`).toBe(
        String(def),
      );
      const sample = htmlSampleLine(key);
      expect(sample?.[1], `sample value for ${key}`).toBe(String(def));
      expect(sample?.[2], `sample default for ${key}`).toBe(String(def));
      const item = htmlItem(key);
      expect(item, `<li> for ${key}`).not.toBe("");
      expect(
        item.match(/(?:defaults\s+to|Set\s+to)\s+(\d+)/)?.[1],
        `<li> default for ${key}`,
      ).toBe(String(def));
      const entry = yamlEntry(key);
      expect(entry, `example entry for ${key}`).not.toBe("");
      expect(entry.match(new RegExp(`${key}:\\s*(\\d+)`))?.[1]).toBe(
        String(def),
      );
      expect(entry.match(/\(default:\s*(\d+)\)/)?.[1]).toBe(String(def));
    });
  }

  for (const [key, def] of Object.entries(CODE_DEFAULTS)) {
    it(`${key}: docs/config/index.html documents default ${def}`, () => {
      const item = htmlItem(key);
      expect(item, `<li> for ${key}`).not.toBe("");
      expect(item.match(/defaults\s+to\s+(\d+)/)?.[1]).toBe(String(def));
      // The sample YAML block: value and its "(default: N)" comment.
      const sample = htmlSampleLine(key);
      expect(sample?.[1], `sample value for ${key}`).toBe(String(def));
      expect(sample?.[2], `sample default for ${key}`).toBe(String(def));
    });

    it(`${key}: pathfinder.example.yaml documents default ${def}`, () => {
      const entry = yamlEntry(key);
      expect(entry, `example entry for ${key}`).not.toBe("");
      expect(entry.match(new RegExp(`${key}:\\s*(\\d+)`))?.[1]).toBe(
        String(def),
      );
      expect(entry.match(/\(default:\s*(\d+)\)/)?.[1]).toBe(String(def));
    });

    it(`${key}: the src/types.ts comment states default ${def}`, () => {
      expect(typesComment(key).match(/Default\s+(\d+)/)?.[1]).toBe(String(def));
    });
  }

  it("the allowlist docs name every per-IP limit and exclude modern_max_inflight", () => {
    const item = htmlItem("allowlist");
    expect(item).toMatch(/max_sessions_per_ip/);
    expect(item).toMatch(/per-IP\s+concurrent body-read cap/);
    expect(item).toMatch(/modern[\s\S]{0,20}per-IP rate\s+limit/i);
    expect(item).toMatch(/modern_rpm_per_ip/);
    expect(item).toMatch(/but not[\s\S]{0,40}modern_max_inflight/);
  });

  it("the modern limit docs name the JSON-RPC error codes, and the legacy 429 body is not attributed to them", () => {
    // Modern 429: JSON-RPC error JSONRPC_RATE_LIMIT_CODE (-32005). Modern 503:
    // JSONRPC_CAPACITY_CODE (-32006), with a fixed 1-second retry. Both carry
    // Retry-After. The legacy body (error, reason, limit, currentCount ...)
    // belongs to max_sessions_per_ip only. The docs must name the codes'
    // real values, read from src/rate-limit-response.ts.
    const rateLimitCode = String(JSONRPC_RATE_LIMIT_CODE);
    const capacityCode = String(JSONRPC_CAPACITY_CODE);
    // `n` as a whole number: not part of a longer number.
    const exactNumber = (n: string) => new RegExp(`(?<![\\d-])${n}(?!\\d)`);
    expect(serverSrc).toMatch(
      /\.status\(429\)[\s\S]{0,200}code:\s*JSONRPC_RATE_LIMIT_CODE\b/,
    );
    const capacityReply = serverSrc.match(
      /\.status\(503\)\s*\.set\("Retry-After",\s*"(\d+)"\)[\s\S]{0,200}code:\s*JSONRPC_CAPACITY_CODE\b[\s\S]{0,120}retryAfterSeconds:\s*(\d+)/,
    );
    expect(capacityReply?.[1], "modern 503 Retry-After").toBe("1");
    expect(capacityReply?.[2], "modern 503 data.retryAfterSeconds").toBe("1");
    // Line wraps and the yaml "#" prefix must not split a phrase.
    const oneLine = (t: string) => t.replace(/\s*\n\s*#?\s*/g, " ");
    for (const key of ["modern_rpm_per_ip", "modern_burst_per_ip"]) {
      for (const [where, text] of [
        ["docs/config/index.html", htmlItem(key)],
        ["pathfinder.example.yaml", yamlEntry(key)],
      ]) {
        const flatText = oneLine(text);
        expect(flatText, `${where} ${key}`).toMatch(exactNumber(rateLimitCode));
        expect(flatText, `${where} ${key}`).toMatch(/JSON-RPC error/);
        expect(flatText, `${where} ${key}`).toMatch(/Retry-After/);
      }
    }
    // The body field that carries the wait, as the docs name it.
    for (const [where, text] of [
      ["docs/config/index.html", htmlItem("modern_rpm_per_ip")],
      ["pathfinder.example.yaml", yamlEntry("modern_rpm_per_ip")],
    ]) {
      expect(oneLine(text), `${where} modern_rpm_per_ip`).toMatch(
        /data\.retryAfterSeconds/,
      );
    }
    for (const [where, text] of [
      ["docs/config/index.html", htmlItem("modern_max_inflight")],
      ["pathfinder.example.yaml", yamlEntry("modern_max_inflight")],
    ]) {
      const flatText = oneLine(text);
      expect(flatText, `${where} modern_max_inflight`).toMatch(
        exactNumber(capacityCode),
      );
      expect(flatText, `${where} modern_max_inflight`).toMatch(
        /JSON-RPC error/,
      );
      expect(flatText, `${where} modern_max_inflight`).toMatch(/Retry-After/);
      expect(flatText, `${where} modern_max_inflight`).toMatch(
        /data\.retryAfterSeconds(?:<\/code>)? of 1/,
      );
    }
    // The allowlist bullet: the sentence with the legacy body names
    // max_sessions_per_ip and does not name a modern_ key.
    const flat = htmlItem("allowlist")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ");
    const sentence = flat.split(/\.\s/).find((s) => /currentCount/.test(s));
    expect(sentence, "allowlist sentence with the legacy body").toBeTruthy();
    expect(sentence).toMatch(/max_sessions_per_ip/);
    expect(sentence).not.toMatch(/modern/i);
  });

  it("the modern_max_inflight docs say the allowlist does not bypass it", () => {
    for (const [where, text] of [
      ["docs/config/index.html", htmlItem("modern_max_inflight")],
      ["pathfinder.example.yaml", yamlEntry("modern_max_inflight")],
      ["src/types.ts", typesComment("modern_max_inflight")],
    ]) {
      expect(text, where).toMatch(/allowlist does not bypass/i);
    }
  });

  it("the modern_max_inflight docs mention the subscriptions/listen exemption", () => {
    for (const [where, text] of [
      ["docs/config/index.html", htmlItem("modern_max_inflight")],
      ["pathfinder.example.yaml", yamlEntry("modern_max_inflight")],
      ["src/types.ts", typesComment("modern_max_inflight")],
    ]) {
      expect(text, where).toMatch(/subscriptions\/listen/);
      expect(text, where).toMatch(/not count/i);
    }
  });

  it("every count of modern_* keys in the docs matches the schema", () => {
    // Compares any stated count to the schema, so it also catches the next
    // stale number when a key is added, not only one known stale phrase.
    // Each file must state the count at least once, so a reworded phrase
    // fails here instead of leaving nothing to check.
    const words = ["zero", "one", "two", "three", "four", "five", "six"];
    const toNumber = (w: string) =>
      /^\d+$/.test(w) ? Number(w) : words.indexOf(w.toLowerCase());
    for (const [where, text, re] of [
      [
        "docs/config/index.html",
        configHtml,
        /\b(\w+)\s+<code>modern_\*<\/code>\s+keys/gi,
      ],
      ["pathfinder.example.yaml", exampleYaml, /\b(\w+)\s+modern_\*\s+keys/gi],
    ] as const) {
      const phrases = [...text.matchAll(re)];
      expect(phrases.length, `count phrases in ${where}`).toBeGreaterThan(0);
      for (const m of phrases) {
        expect(toNumber(m[1]), `${where}: "${m[0]}"`).toBe(schemaKeys.length);
      }
    }
  });

  it("README Telemetry names both events the code sends", async () => {
    const { CLIENT_SEEN_EVENT } = await import("../p2p-telemetry.js");
    const legacy = serverSrc.match(/emit\(\s*"(pathfinder\.session\.\w+)"/);
    expect(legacy?.[1]).toBe("pathfinder.session.created");
    const section = readme.match(/^## Telemetry\n([\s\S]*?)(?=^## )/m)?.[1];
    expect(section, "README ## Telemetry section").toBeTruthy();
    expect(section).toContain(`\`${legacy![1]}\``);
    expect(section).toContain(`\`${CLIENT_SEEN_EVENT}\``);
    expect(section).toMatch(/Both events/);
  });
});
