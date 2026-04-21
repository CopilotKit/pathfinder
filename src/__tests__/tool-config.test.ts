import { describe, it, expect } from "vitest";
import {
  CollectToolConfigSchema,
  AnyToolConfigSchema,
  ServerConfigSchema,
} from "../types.js";

describe("CollectToolConfigSchema", () => {
  const validCollect = {
    name: "submit-feedback",
    type: "collect" as const,
    description: "Submit feedback",
    response: "Thanks!",
    schema: {
      rating: {
        type: "enum" as const,
        values: ["good", "bad"],
        required: true,
      },
    },
  };

  it("parses a valid collect tool config", () => {
    const result = CollectToolConfigSchema.safeParse(validCollect);
    expect(result.success).toBe(true);
  });

  it("rejects missing name", () => {
    const { name, ...rest } = validCollect;
    expect(CollectToolConfigSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing description", () => {
    const { description, ...rest } = validCollect;
    expect(CollectToolConfigSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing response", () => {
    const { response, ...rest } = validCollect;
    expect(CollectToolConfigSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing schema", () => {
    const { schema, ...rest } = validCollect;
    expect(CollectToolConfigSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects enum field without values", () => {
    const config = {
      ...validCollect,
      schema: {
        rating: { type: "enum" as const, required: true },
      },
    };
    expect(CollectToolConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects enum field with empty values", () => {
    const config = {
      ...validCollect,
      schema: {
        rating: { type: "enum" as const, values: [], required: true },
      },
    };
    const result = CollectToolConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(
        messages.some((m) => m.includes("non-empty values array")),
      ).toBe(true);
    }
  });

  it("rejects unknown field type", () => {
    const config = {
      ...validCollect,
      schema: {
        data: { type: "boolean", required: true },
      },
    };
    expect(CollectToolConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects values on non-enum fields", () => {
    const config = {
      ...validCollect,
      schema: {
        name: { type: "string" as const, values: ["a", "b"], required: true },
      },
    };
    expect(CollectToolConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("BashToolConfigSchema", () => {
  it("parses a valid bash tool config", () => {
    const config = {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs",
      sources: ["docs"],
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe("bash");
  });

  it("parses bash tool with multiple sources", () => {
    const config = {
      name: "explore-all",
      type: "bash",
      description: "Explore everything",
      sources: ["docs", "code"],
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("rejects bash tool with empty sources", () => {
    const config = {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs",
      sources: [],
    };
    expect(AnyToolConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects bash tool without sources", () => {
    const config = {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs",
    };
    expect(AnyToolConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("AnyToolConfigSchema", () => {
  it("parses a search tool with explicit type", () => {
    const config = {
      name: "search-docs",
      type: "search",
      description: "Search docs",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe("search");
  });

  it("parses a collect tool", () => {
    const config = {
      name: "feedback",
      type: "collect",
      description: "Give feedback",
      response: "OK",
      schema: { note: { type: "string" } },
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe("collect");
  });

  it("rejects unknown tool type", () => {
    const config = {
      name: "mystery",
      type: "magic",
      description: "Does magic",
    };
    expect(AnyToolConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects collect tool with empty schema", () => {
    const config = {
      name: "feedback",
      type: "collect",
      description: "Give feedback",
      response: "OK",
      schema: {},
    };
    expect(AnyToolConfigSchema.safeParse(config).success).toBe(false);
  });

  it("discriminates correctly between search and collect fields", () => {
    // A collect tool should not need source/limits
    const collect = {
      name: "feedback",
      type: "collect",
      description: "Give feedback",
      response: "OK",
      schema: { note: { type: "string" } },
    };
    expect(AnyToolConfigSchema.safeParse(collect).success).toBe(true);

    // A search tool should not need response/schema
    const search = {
      name: "search",
      type: "search",
      description: "Search",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
    };
    expect(AnyToolConfigSchema.safeParse(search).success).toBe(true);
  });
});

describe("backwards-compat config defaulting", () => {
  it("defaults missing type to search and parses via AnyToolConfigSchema", () => {
    const toolWithoutType = {
      name: "search-docs",
      description: "Search",
      source: "docs",
      default_limit: 5,
      max_limit: 20,
      result_format: "docs",
    };

    // Simulate the defaulting logic from config.ts
    const tool = { ...toolWithoutType } as Record<string, unknown>;
    if (!("type" in tool)) {
      tool.type = "search";
    }

    const result = AnyToolConfigSchema.safeParse(tool);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe("search");
  });

  it("does not overwrite an explicit type", () => {
    const collectTool = {
      name: "feedback",
      type: "collect",
      description: "Give feedback",
      response: "OK",
      schema: { note: { type: "string" } },
    };

    // Same defaulting logic — should not touch existing type
    const tool = { ...collectTool } as Record<string, unknown>;
    if (!("type" in tool)) {
      tool.type = "search";
    }

    const result = AnyToolConfigSchema.safeParse(tool);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe("collect");
  });
});

describe("ServerConfigSchema", () => {
  const minimalConfig = {
    server: { name: "test", version: "1.0.0" },
    sources: [
      {
        name: "docs",
        type: "markdown",
        repo: "https://github.com/test/test.git",
        path: "docs/",
        file_patterns: ["**/*.md"],
        chunk: { target_tokens: 600, overlap_tokens: 50 },
      },
    ],
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    indexing: {
      auto_reindex: true,
      reindex_hour_utc: 3,
      stale_threshold_hours: 24,
    },
  };

  it("rejects search tool where default_limit > max_limit", () => {
    const config = {
      ...minimalConfig,
      tools: [
        {
          name: "search-docs",
          type: "search",
          description: "Search",
          source: "docs",
          default_limit: 30,
          max_limit: 10,
          result_format: "docs",
        },
      ],
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("accepts search tool where default_limit <= max_limit", () => {
    const config = {
      ...minimalConfig,
      tools: [
        {
          name: "search-docs",
          type: "search",
          description: "Search",
          source: "docs",
          default_limit: 5,
          max_limit: 20,
          result_format: "docs",
        },
      ],
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("rejects bash tool referencing undefined source", () => {
    const config = {
      ...minimalConfig,
      tools: [
        {
          name: "explore",
          type: "bash",
          description: "Explore",
          sources: ["nonexistent"],
        },
      ],
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("accepts bash tool referencing valid source", () => {
    const config = {
      ...minimalConfig,
      tools: [
        {
          name: "explore",
          type: "bash",
          description: "Explore",
          sources: ["docs"],
        },
      ],
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts bash-only config without embedding and indexing", () => {
    const { embedding, indexing, ...configWithoutEmbedding } = minimalConfig;
    const config = {
      ...configWithoutEmbedding,
      tools: [
        {
          name: "explore",
          type: "bash",
          description: "Explore",
          sources: ["docs"],
        },
      ],
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("rejects search config without embedding", () => {
    const { embedding, ...configWithoutEmbedding } = minimalConfig;
    const config = {
      ...configWithoutEmbedding,
      tools: [
        {
          name: "search-docs",
          type: "search",
          description: "Search",
          source: "docs",
          default_limit: 5,
          max_limit: 20,
          result_format: "docs",
        },
      ],
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("rejects search config without indexing", () => {
    const { indexing, ...configWithoutIndexing } = minimalConfig;
    const config = {
      ...configWithoutIndexing,
      tools: [
        {
          name: "search-docs",
          type: "search",
          description: "Search",
          source: "docs",
          default_limit: 5,
          max_limit: 20,
          result_format: "docs",
        },
      ],
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  describe("server.allowlist", () => {
    const baseTools = [
      {
        name: "explore",
        type: "bash" as const,
        description: "Explore",
        sources: ["docs"],
      },
    ];

    it("accepts a plain-IP allowlist entry", () => {
      const config = {
        ...minimalConfig,
        server: {
          ...minimalConfig.server,
          allowlist: ["160.79.106.35"],
        },
        tools: baseTools,
      };
      const result = ServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("accepts a CIDR allowlist entry", () => {
      const config = {
        ...minimalConfig,
        server: {
          ...minimalConfig.server,
          allowlist: ["160.79.106.0/24", "2001:db8::/32"],
        },
        tools: baseTools,
      };
      const result = ServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("accepts an empty allowlist", () => {
      const config = {
        ...minimalConfig,
        server: {
          ...minimalConfig.server,
          allowlist: [],
        },
        tools: baseTools,
      };
      const result = ServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("rejects a malformed allowlist entry (not an IP or CIDR)", () => {
      const config = {
        ...minimalConfig,
        server: {
          ...minimalConfig.server,
          allowlist: ["not-an-ip"],
        },
        tools: baseTools,
      };
      const result = ServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects an allowlist with an invalid CIDR suffix", () => {
      const config = {
        ...minimalConfig,
        server: {
          ...minimalConfig.server,
          allowlist: ["10.0.0.0/99"],
        },
        tools: baseTools,
      };
      const result = ServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    // Edge cases in allowlist-entry validation. The schema has a defensive
    // regex pre-check (in src/types.ts) plus ipaddr.parseCIDR / ipaddr.parse
    // as the semantic validator. Each of these entries must be rejected —
    // if any start passing, either the regex or ipaddr.js has drifted and
    // the allowlist could be bypassed.
    it.each([
      ["negative suffix", "10.0.0.0/-1"],
      ["non-numeric suffix", "10.0.0.0/abc"],
      ["empty suffix", "10.0.0.0/"],
      ["leading whitespace", " 10.0.0.1"],
      ["trailing whitespace", "10.0.0.0/24 "],
      ["internal whitespace", "10.0.0. 1"],
      ["invalid characters (SQL-ish)", "10.0.0.1;DROP"],
      ["invalid characters (letters in octet)", "10.0.0.1abc"],
      ["IPv6 out-of-range suffix", "2001:db8::/129"],
      // Schema-level prefix-length bounds. These MUST be rejected at the
      // schema boundary (by the regex pre-check), not diffused through
      // ipaddr.js with a vaguer error. An operator typing "/999" should see a
      // CIDR-range-out-of-bounds style error, not a generic parse failure.
      ["IPv4 prefix above 32", "10.0.0.0/33"],
      ["IPv6 prefix at 129", "::1/129"],
      ["absurdly large IPv4 prefix", "0.0.0.0/999"],
      ["absurdly large IPv6 prefix", "::1/999"],
    ])("rejects an allowlist with %s (%s)", (_label, entry) => {
      const config = {
        ...minimalConfig,
        server: {
          ...minimalConfig.server,
          allowlist: [entry],
        },
        tools: baseTools,
      };
      const result = ServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("rejects an allowlist that is not an array", () => {
      const config = {
        ...minimalConfig,
        server: {
          ...minimalConfig.server,
          allowlist: "160.79.106.35",
        },
        tools: baseTools,
      };
      const result = ServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });
});

describe("BashToolConfigSchema with bash options", () => {
  it("accepts bash tool with all bash options", () => {
    const config = {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs",
      sources: ["docs"],
      bash: {
        session_state: true,
        grep_strategy: "hybrid",
        workspace: true,
        virtual_files: true,
        max_file_size: 204800,
        cache: { max_entries: 500, ttl_seconds: 600 },
      },
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts bash tool with no bash options (all defaults)", () => {
    const config = {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs",
      sources: ["docs"],
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts bash tool with partial bash options", () => {
    const config = {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs",
      sources: ["docs"],
      bash: {
        session_state: true,
      },
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("rejects invalid grep_strategy value", () => {
    const config = {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs",
      sources: ["docs"],
      bash: {
        grep_strategy: "quantum",
      },
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("rejects negative max_file_size", () => {
    const config = {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs",
      sources: ["docs"],
      bash: {
        max_file_size: -1,
      },
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("rejects cache with zero max_entries", () => {
    const config = {
      name: "explore-docs",
      type: "bash",
      description: "Explore docs",
      sources: ["docs"],
      bash: {
        cache: { max_entries: 0, ttl_seconds: 60 },
      },
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("BashOptionsSchema defaults", () => {
  it("accepts empty bash options object (all fields are partial)", () => {
    const config = {
      name: "explore",
      type: "bash",
      description: "Explore",
      sources: ["docs"],
      bash: {},
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "bash") {
      // BashOptionsSchema uses .partial(), so empty {} is valid
      // and fields remain undefined (no defaults applied for partial fields)
      expect(result.data.bash).toBeDefined();
    }
  });

  it("preserves explicit values through parsing", () => {
    const config = {
      name: "explore",
      type: "bash",
      description: "Explore",
      sources: ["docs"],
      bash: {
        session_state: true,
        grep_strategy: "hybrid",
        workspace: true,
        virtual_files: true,
      },
    };
    const result = AnyToolConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "bash") {
      expect(result.data.bash?.session_state).toBe(true);
      expect(result.data.bash?.grep_strategy).toBe("hybrid");
      expect(result.data.bash?.workspace).toBe(true);
      expect(result.data.bash?.virtual_files).toBe(true);
    }
  });
});

describe("ServerConfigSchema vector grep without embedding", () => {
  it("adds issue when grep_strategy is vector but no embedding config", () => {
    const config = {
      server: { name: "test", version: "1.0.0" },
      sources: [
        {
          name: "docs",
          type: "markdown",
          repo: "https://github.com/test/test.git",
          path: "docs/",
          file_patterns: ["**/*.md"],
          chunk: { target_tokens: 600, overlap_tokens: 50 },
        },
      ],
      tools: [
        {
          name: "explore",
          type: "bash",
          description: "Explore",
          sources: ["docs"],
          bash: {
            grep_strategy: "vector",
          },
        },
      ],
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("embedding"))).toBe(true);
    }
  });

  it("allows grep_strategy vector when embedding config present", () => {
    const config = {
      server: { name: "test", version: "1.0.0" },
      sources: [
        {
          name: "docs",
          type: "markdown",
          repo: "https://github.com/test/test.git",
          path: "docs/",
          file_patterns: ["**/*.md"],
          chunk: { target_tokens: 600, overlap_tokens: 50 },
        },
      ],
      tools: [
        {
          name: "explore",
          type: "bash",
          description: "Explore",
          sources: ["docs"],
          bash: {
            grep_strategy: "vector",
          },
        },
      ],
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
      indexing: {
        auto_reindex: true,
        reindex_hour_utc: 3,
        stale_threshold_hours: 24,
      },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("allows grep_strategy memory without embedding config", () => {
    const config = {
      server: { name: "test", version: "1.0.0" },
      sources: [
        {
          name: "docs",
          type: "markdown",
          repo: "https://github.com/test/test.git",
          path: "docs/",
          file_patterns: ["**/*.md"],
          chunk: { target_tokens: 600, overlap_tokens: 50 },
        },
      ],
      tools: [
        {
          name: "explore",
          type: "bash",
          description: "Explore",
          sources: ["docs"],
          bash: {
            grep_strategy: "memory",
          },
        },
      ],
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});
