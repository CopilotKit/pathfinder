import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ValidationResult } from "../validate.js";

// Mock fs
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn(),
  };
});

// Mock child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// Mock config
vi.mock("../config.js", () => {
  const sources = [
    {
      name: "docs",
      type: "markdown",
      path: "./docs",
      file_patterns: ["**/*.md"],
      chunk: {},
    },
    {
      name: "discord-support",
      type: "discord",
      guild_id: "123456",
      channels: [
        { id: "111", type: "text" },
        { id: "222", type: "forum" },
      ],
      confidence_threshold: 0.7,
      min_thread_replies: 2,
      chunk: {},
      category: "faq",
    },
  ];
  const tools = [
    {
      name: "search-docs",
      type: "search",
      source: "docs",
      description: "Search",
      default_limit: 10,
      max_limit: 50,
      result_format: "docs",
    },
    {
      name: "get-faq",
      type: "knowledge",
      sources: ["discord-support"],
      description: "FAQ",
      min_confidence: 0.7,
      default_limit: 20,
      max_limit: 100,
    },
  ];
  return {
    getConfig: vi.fn().mockReturnValue({
      openaiApiKey: "test-key",
      slackBotToken: "",
      slackSigningSecret: "",
      discordBotToken: "test-discord-token",
      discordPublicKey: "test-public-key",
      databaseUrl: "postgresql://test",
      githubToken: "",
      githubWebhookSecret: "",
      port: 3001,
      nodeEnv: "test",
      logLevel: "info",
      cloneDir: "/tmp/test",
      notionToken: "",
    }),
    getServerConfig: vi.fn().mockReturnValue({
      server: { name: "test", version: "1.0" },
      sources,
      tools,
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
      indexing: {
        auto_reindex: true,
        reindex_hour_utc: 4,
        stale_threshold_hours: 24,
      },
    }),
  };
});

// Mock Discord API client
vi.mock("../indexing/providers/discord-api.js", () => {
  const MockDiscordApiClient = vi.fn(function (this: Record<string, unknown>) {
    this.rest = {
      get: vi.fn(),
    };
  });
  return { DiscordApiClient: MockDiscordApiClient };
});

// Mock Slack API client
vi.mock("../indexing/providers/slack-api.js", () => {
  const MockSlackApiClient = vi.fn(function (this: Record<string, unknown>) {
    this.webClient = {
      auth: { test: vi.fn() },
      conversations: { info: vi.fn() },
    };
  });
  return { SlackApiClient: MockSlackApiClient };
});

import { validateConfig, formatValidationResult } from "../validate.js";
import { existsSync } from "node:fs";
import { getConfig, getServerConfig } from "../config.js";

const defaultSources = [
  {
    name: "docs",
    type: "markdown",
    path: "./docs",
    file_patterns: ["**/*.md"],
    chunk: {},
  },
  {
    name: "discord-support",
    type: "discord",
    guild_id: "123456",
    channels: [
      { id: "111", type: "text" },
      { id: "222", type: "forum" },
    ],
    confidence_threshold: 0.7,
    min_thread_replies: 2,
    chunk: {},
    category: "faq",
  },
];

const defaultTools = [
  {
    name: "search-docs",
    type: "search",
    source: "docs",
    description: "Search",
    default_limit: 10,
    max_limit: 50,
    result_format: "docs",
  },
  {
    name: "get-faq",
    type: "knowledge",
    sources: ["discord-support"],
    description: "FAQ",
    min_confidence: 0.7,
    default_limit: 20,
    max_limit: 100,
  },
];

const defaultServerConfig = {
  server: { name: "test", version: "1.0" },
  sources: defaultSources,
  tools: defaultTools,
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  indexing: {
    auto_reindex: true,
    reindex_hour_utc: 4,
    stale_threshold_hours: 24,
  },
};

const defaultConfig = {
  openaiApiKey: "test-key",
  slackBotToken: "",
  slackSigningSecret: "",
  discordBotToken: "test-discord-token",
  discordPublicKey: "test-public-key",
  databaseUrl: "postgresql://test",
  githubToken: "",
  githubWebhookSecret: "",
  port: 3001,
  nodeEnv: "test",
  logLevel: "info",
  cloneDir: "/tmp/test",
  notionToken: "",
};

describe("validateConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getConfig as ReturnType<typeof vi.fn>).mockReturnValue(defaultConfig);
    (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue(
      defaultServerConfig,
    );
  });

  it("returns valid result when config and sources are accessible", async () => {
    const result = await validateConfig();

    expect(result.configValid).toBe(true);
    expect(result.sources).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("reports missing env vars", async () => {
    const { getConfig } = await import("../config.js");
    (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      openaiApiKey: "",
      discordBotToken: "",
      discordPublicKey: "",
      slackBotToken: "",
      databaseUrl: "",
      notionToken: "",
    });

    const result = await validateConfig();

    const discordEnv = result.envVars.find(
      (e) => e.name === "DISCORD_BOT_TOKEN",
    );
    expect(discordEnv?.present).toBe(false);
    expect(result.errors.some((e) => e.includes("DISCORD_BOT_TOKEN"))).toBe(
      true,
    );
  });

  it("validates tool-source cross references", async () => {
    const result = await validateConfig();

    expect(result.tools).toHaveLength(2);
    expect(result.tools.every((t) => t.valid)).toBe(true);
  });

  it("detects invalid tool-source references", async () => {
    const { getServerConfig } = await import("../config.js");
    (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      server: { name: "test", version: "1.0" },
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
          name: "bad-tool",
          type: "search",
          source: "nonexistent",
          description: "X",
          default_limit: 10,
          max_limit: 50,
          result_format: "docs",
        },
      ],
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
      indexing: {
        auto_reindex: true,
        reindex_hour_utc: 4,
        stale_threshold_hours: 24,
      },
    });

    const result = await validateConfig();
    const badTool = result.tools.find((t) => t.name === "bad-tool");
    expect(badTool?.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  it("handles config load failure gracefully", async () => {
    const { getServerConfig } = await import("../config.js");
    (getServerConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Invalid YAML at line 5");
    });

    const result = await validateConfig();
    expect(result.configValid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Invalid YAML");
  });

  it("detects local path not existing", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await validateConfig();

    const docsSource = result.sources.find((s) => s.name === "docs");
    expect(docsSource?.valid).toBe(false);
  });

  // ── Additional coverage tests ────────────────────────────────────────────

  it("sets PATHFINDER_CONFIG when configPath is provided", async () => {
    const result = await validateConfig("/custom/path.yaml");
    // The function should set the env var (even though getServerConfig is mocked)
    expect(process.env.PATHFINDER_CONFIG).toBe("/custom/path.yaml");
    expect(result.configValid).toBe(true);
  });

  it("handles non-Error exceptions during config load", async () => {
    (getServerConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw "string error";
    });

    const result = await validateConfig();
    expect(result.configValid).toBe(false);
    expect(result.errors[0]).toContain("string error");
  });

  it("reports all missing required env vars", async () => {
    (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      openaiApiKey: "",
      discordBotToken: "",
      discordPublicKey: "",
      slackBotToken: "",
      databaseUrl: "",
      notionToken: "",
    });

    const result = await validateConfig();
    // Should report DATABASE_URL, OPENAI_API_KEY, DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY
    expect(
      result.errors.filter((e) =>
        e.includes("Missing required environment variable"),
      ),
    ).toHaveLength(4);
  });

  it("marks env vars as not required when no relevant sources/tools", async () => {
    (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      server: { name: "test", version: "1.0" },
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
          name: "c",
          type: "collect",
          description: "collect",
          response: "Collected",
          schema: { field1: { type: "string" } },
        },
      ],
    });
    (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      openaiApiKey: "",
      slackBotToken: "",
      discordBotToken: "",
      discordPublicKey: "",
      databaseUrl: "",
      notionToken: "",
    });

    const result = await validateConfig();
    // No errors because collect tools don't require these env vars in validate
    const requiredEnvs = result.envVars.filter((e) => e.required);
    expect(requiredEnvs).toHaveLength(0);
  });

  it("marks NOTION_TOKEN as required when notion source exists", async () => {
    (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      server: { name: "test", version: "1.0" },
      sources: [{ name: "notion-docs", type: "notion", chunk: {} }],
      tools: [
        {
          name: "c",
          type: "collect",
          description: "collect",
          response: "Collected",
          schema: { field1: { type: "string" } },
        },
      ],
    });
    (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultConfig,
      notionToken: "",
    });

    const result = await validateConfig();
    const notionEnv = result.envVars.find((e) => e.name === "NOTION_TOKEN");
    expect(notionEnv?.required).toBe(true);
    expect(notionEnv?.present).toBe(false);
    expect(result.errors.some((e) => e.includes("NOTION_TOKEN"))).toBe(true);
  });

  it("marks SLACK_BOT_TOKEN as required when slack source exists", async () => {
    (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      server: { name: "test", version: "1.0" },
      sources: [
        { name: "slack-src", type: "slack", channels: ["C123"], chunk: {} },
      ],
      tools: [
        {
          name: "c",
          type: "collect",
          description: "collect",
          response: "Collected",
          schema: { field1: { type: "string" } },
        },
      ],
    });
    (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultConfig,
      slackBotToken: "",
    });

    const result = await validateConfig();
    const slackEnv = result.envVars.find((e) => e.name === "SLACK_BOT_TOKEN");
    expect(slackEnv?.required).toBe(true);
    expect(slackEnv?.present).toBe(false);
  });

  it("marks OPENAI_API_KEY as required for discord text channels", async () => {
    (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      server: { name: "test", version: "1.0" },
      sources: [
        {
          name: "disc",
          type: "discord",
          guild_id: "123",
          channels: [{ id: "1", type: "text" }],
          chunk: {},
        },
      ],
      tools: [
        {
          name: "c",
          type: "collect",
          description: "collect",
          response: "Collected",
          schema: { field1: { type: "string" } },
        },
      ],
    });
    (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultConfig,
      openaiApiKey: "",
      discordBotToken: "token",
      discordPublicKey: "key",
    });

    const result = await validateConfig();
    const openaiEnv = result.envVars.find((e) => e.name === "OPENAI_API_KEY");
    expect(openaiEnv?.required).toBe(true);
  });

  // ── Optional dependency checks ──────────────────────────────────────────

  describe("optional dependency checks", () => {
    it("reports missing pdf-parse for PDF document sources", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        server: { name: "test", version: "1.0" },
        sources: [
          {
            name: "pdf-docs",
            type: "document",
            path: "./docs",
            file_patterns: ["**/*.pdf"],
            chunk: {},
          },
        ],
        tools: [
          {
            name: "c",
            type: "collect",
            description: "collect",
            response: "Collected",
            schema: { field1: { type: "string" } },
          },
        ],
      });

      const result = await validateConfig();
      expect(
        result.errors.some(
          (e) =>
            e.includes("Missing optional dependency: pdf-parse") &&
            e.includes("npm install pdf-parse"),
        ),
      ).toBe(true);
    });

    it("reports missing mammoth for DOCX document sources", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        server: { name: "test", version: "1.0" },
        sources: [
          {
            name: "docx-docs",
            type: "document",
            path: "./docs",
            file_patterns: ["**/*.docx"],
            chunk: {},
          },
        ],
        tools: [
          {
            name: "c",
            type: "collect",
            description: "collect",
            response: "Collected",
            schema: { field1: { type: "string" } },
          },
        ],
      });

      const result = await validateConfig();
      expect(
        result.errors.some(
          (e) =>
            e.includes("Missing optional dependency: mammoth") &&
            e.includes("npm install mammoth"),
        ),
      ).toBe(true);
    });

    it("reports missing @xenova/transformers for local embedding provider", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        server: { name: "test", version: "1.0" },
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
            name: "c",
            type: "collect",
            description: "collect",
            response: "Collected",
            schema: { field1: { type: "string" } },
          },
        ],
        embedding: {
          provider: "local",
          model: "Xenova/all-MiniLM-L6-v2",
          dimensions: 384,
        },
      });

      const result = await validateConfig();
      expect(
        result.errors.some(
          (e) =>
            e.includes("Missing optional dependency: @xenova/transformers") &&
            e.includes("npm install @xenova/transformers"),
        ),
      ).toBe(true);
    });

    it("does not report optional dep errors when no document sources or local embeddings", async () => {
      const result = await validateConfig();
      expect(
        result.errors.some((e) => e.includes("Missing optional dependency")),
      ).toBe(false);
    });
  });

  // ── Source validation ────────────────────────────────────────────────────

  describe("source validation", () => {
    it("validates file source with existing local path", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        server: { name: "test", version: "1.0" },
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
            name: "c",
            type: "collect",
            description: "collect",
            response: "Collected",
            schema: { field1: { type: "string" } },
          },
        ],
      });
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const result = await validateConfig();
      const src = result.sources.find((s) => s.name === "docs");
      expect(src?.valid).toBe(true);
      expect(src?.details).toContain("exists");
    });

    it("validates file source with missing local path", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        server: { name: "test", version: "1.0" },
        sources: [
          {
            name: "docs",
            type: "markdown",
            path: "./nonexistent",
            file_patterns: ["**/*.md"],
            chunk: {},
          },
        ],
        tools: [
          {
            name: "c",
            type: "collect",
            description: "collect",
            response: "Collected",
            schema: { field1: { type: "string" } },
          },
        ],
      });
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await validateConfig();
      const src = result.sources.find((s) => s.name === "docs");
      expect(src?.valid).toBe(false);
      expect(src?.details).toContain("not found");
      expect(result.errors.some((e) => e.includes("docs"))).toBe(true);
    });

    it("validates file source with remote repo (skips local path check)", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        server: { name: "test", version: "1.0" },
        sources: [
          {
            name: "remote-docs",
            type: "markdown",
            path: "./docs",
            file_patterns: ["**/*.md"],
            repo: "https://github.com/org/repo",
            chunk: {},
          },
        ],
        tools: [
          {
            name: "c",
            type: "collect",
            description: "collect",
            response: "Collected",
            schema: { field1: { type: "string" } },
          },
        ],
      });

      const result = await validateConfig();
      const src = result.sources.find((s) => s.name === "remote-docs");
      expect(src?.valid).toBe(true);
      expect(src?.details).toContain("Remote repo");
    });

    it("validates slack source (offline mode)", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        server: { name: "test", version: "1.0" },
        sources: [
          { name: "slack-src", type: "slack", channels: ["C123"], chunk: {} },
        ],
        tools: [
          {
            name: "c",
            type: "collect",
            description: "collect",
            response: "Collected",
            schema: { field1: { type: "string" } },
          },
        ],
      });

      const result = await validateConfig();
      const src = result.sources.find((s) => s.name === "slack-src");
      expect(src?.valid).toBe(true);
      expect(src?.details).toContain(
        "Slack validation requires live API probe",
      );
    });

    it("validates discord source (offline mode)", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        server: { name: "test", version: "1.0" },
        sources: [
          {
            name: "disc",
            type: "discord",
            guild_id: "123",
            channels: [{ id: "1", type: "forum" }],
            chunk: {},
          },
        ],
        tools: [
          {
            name: "c",
            type: "collect",
            description: "collect",
            response: "Collected",
            schema: { field1: { type: "string" } },
          },
        ],
      });

      const result = await validateConfig();
      const src = result.sources.find((s) => s.name === "disc");
      expect(src?.valid).toBe(true);
      expect(src?.details).toContain(
        "Discord validation requires live API probe",
      );
    });

    it("validates notion source (offline mode)", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        server: { name: "test", version: "1.0" },
        sources: [{ name: "notion-src", type: "notion", chunk: {} }],
        tools: [
          {
            name: "c",
            type: "collect",
            description: "collect",
            response: "Collected",
            schema: { field1: { type: "string" } },
          },
        ],
      });

      const result = await validateConfig();
      const src = result.sources.find((s) => s.name === "notion-src");
      expect(src?.valid).toBe(true);
      expect(src?.details).toContain(
        "Notion validation requires live API probe",
      );
    });

    it("handles source validation exceptions gracefully", async () => {
      // Make existsSync throw for file source validation
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Permission denied");
      });
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        server: { name: "test", version: "1.0" },
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
            name: "c",
            type: "collect",
            description: "collect",
            response: "Collected",
            schema: { field1: { type: "string" } },
          },
        ],
      });

      const result = await validateConfig();
      const src = result.sources.find((s) => s.name === "docs");
      expect(src?.valid).toBe(false);
      expect(src?.details).toContain("Validation error");
      expect(result.errors.some((e) => e.includes("Permission denied"))).toBe(
        true,
      );
    });
  });

  // ── Tool cross-validation ────────────────────────────────────────────────

  describe("tool cross-validation", () => {
    it("validates search tool with valid source reference", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        ...defaultServerConfig,
        tools: [
          {
            name: "search-docs",
            type: "search",
            source: "docs",
            description: "Search",
            default_limit: 10,
            max_limit: 50,
            result_format: "docs",
          },
        ],
      });

      const result = await validateConfig();
      const tool = result.tools.find((t) => t.name === "search-docs");
      expect(tool?.valid).toBe(true);
      expect(tool?.detail).toContain("docs");
    });

    it("detects knowledge tool with missing source references", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        ...defaultServerConfig,
        tools: [
          {
            name: "faq",
            type: "knowledge",
            sources: ["docs", "nonexistent"],
            description: "FAQ",
            min_confidence: 0.5,
            default_limit: 10,
            max_limit: 50,
          },
        ],
      });

      const result = await validateConfig();
      const tool = result.tools.find((t) => t.name === "faq");
      expect(tool?.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
    });

    it("validates bash tool with valid source references", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        ...defaultServerConfig,
        tools: [
          {
            name: "bash-tool",
            type: "bash",
            sources: ["docs"],
            description: "Bash",
          },
        ],
      });

      const result = await validateConfig();
      const tool = result.tools.find((t) => t.name === "bash-tool");
      expect(tool?.valid).toBe(true);
    });

    it("detects bash tool with missing source references", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        ...defaultServerConfig,
        tools: [
          {
            name: "bash-tool",
            type: "bash",
            sources: ["docs", "ghost"],
            description: "Bash",
          },
        ],
      });

      const result = await validateConfig();
      const tool = result.tools.find((t) => t.name === "bash-tool");
      expect(tool?.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("ghost"))).toBe(true);
    });

    it("accepts collect tool (always valid)", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        ...defaultServerConfig,
        tools: [
          { name: "collect-tool", type: "collect", description: "Collect" },
        ],
      });

      const result = await validateConfig();
      const tool = result.tools.find((t) => t.name === "collect-tool");
      expect(tool?.valid).toBe(true);
      expect(tool?.detail).toContain("type: collect");
    });

    it("validates knowledge tool with all valid source references", async () => {
      (getServerConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        ...defaultServerConfig,
        tools: [
          {
            name: "faq",
            type: "knowledge",
            sources: ["docs", "discord-support"],
            description: "FAQ",
            min_confidence: 0.5,
            default_limit: 10,
            max_limit: 50,
          },
        ],
      });

      const result = await validateConfig();
      const tool = result.tools.find((t) => t.name === "faq");
      expect(tool?.valid).toBe(true);
      expect(tool?.detail).toContain("docs");
      expect(tool?.detail).toContain("discord-support");
    });
  });
});

// ── formatValidationResult ───────────────────────────────────────────────────

describe("formatValidationResult", () => {
  it("formats a fully valid result", () => {
    const result: ValidationResult = {
      configValid: true,
      envVars: [
        { name: "DATABASE_URL", present: true, required: true },
        { name: "OPENAI_API_KEY", present: true, required: true },
      ],
      sources: [
        {
          name: "docs",
          type: "markdown",
          valid: true,
          details: "Path: /docs -- exists",
        },
      ],
      tools: [{ name: "search-docs", valid: true, detail: "-> docs" }],
      errors: [],
    };

    const output = formatValidationResult(result);
    expect(output).toContain("Config: valid");
    expect(output).toContain("DATABASE_URL OK");
    expect(output).toContain("OPENAI_API_KEY OK");
    expect(output).toContain("docs (markdown) OK");
    expect(output).toContain("search-docs OK");
    expect(output).toContain("All validations passed");
  });

  it("formats an invalid config result", () => {
    const result: ValidationResult = {
      configValid: false,
      envVars: [],
      sources: [],
      tools: [],
      errors: ["Config validation failed: missing server field"],
    };

    const output = formatValidationResult(result);
    expect(output).toContain("Config: INVALID");
    expect(output).toContain("1 error(s) found");
    expect(output).toContain("missing server field");
  });

  it("formats missing env vars as MISSING", () => {
    const result: ValidationResult = {
      configValid: true,
      envVars: [
        { name: "DATABASE_URL", present: false, required: true },
        { name: "SLACK_BOT_TOKEN", present: false, required: false },
      ],
      sources: [],
      tools: [],
      errors: ["Missing required environment variable: DATABASE_URL"],
    };

    const output = formatValidationResult(result);
    expect(output).toContain("DATABASE_URL MISSING");
    // Non-required env vars should NOT appear in the output
    expect(output).not.toContain("SLACK_BOT_TOKEN");
  });

  it("formats failed sources", () => {
    const result: ValidationResult = {
      configValid: true,
      envVars: [],
      sources: [
        {
          name: "docs",
          type: "markdown",
          valid: false,
          details: "Path: /docs -- not found",
        },
      ],
      tools: [],
      errors: ['Source "docs" validation failed'],
    };

    const output = formatValidationResult(result);
    expect(output).toContain("docs (markdown) FAILED");
    expect(output).toContain("not found");
  });

  it("formats source with channels", () => {
    const result: ValidationResult = {
      configValid: true,
      envVars: [],
      sources: [
        {
          name: "discord",
          type: "discord",
          valid: true,
          details: "Discord guild accessible",
          channels: [
            { id: "111", name: "general", valid: true, detail: "accessible" },
            { id: "222", valid: false, detail: "not found" },
          ],
        },
      ],
      tools: [],
      errors: [],
    };

    const output = formatValidationResult(result);
    expect(output).toContain("111 OK accessible");
    expect(output).toContain("222 FAILED not found");
  });

  it("formats failed tools", () => {
    const result: ValidationResult = {
      configValid: true,
      envVars: [],
      sources: [],
      tools: [
        {
          name: "bad-tool",
          valid: false,
          detail: 'Source "missing" not found',
        },
      ],
      errors: ['Tool "bad-tool" references missing source'],
    };

    const output = formatValidationResult(result);
    expect(output).toContain("bad-tool FAILED");
    expect(output).toContain('Source "missing" not found');
  });

  it("formats multiple errors", () => {
    const result: ValidationResult = {
      configValid: true,
      envVars: [],
      sources: [],
      tools: [],
      errors: ["Error one", "Error two", "Error three"],
    };

    const output = formatValidationResult(result);
    expect(output).toContain("3 error(s) found");
    expect(output).toContain("- Error one");
    expect(output).toContain("- Error two");
    expect(output).toContain("- Error three");
  });

  it("formats optional dependency warnings separately from hard errors", () => {
    const result: ValidationResult = {
      configValid: true,
      envVars: [],
      sources: [],
      tools: [],
      errors: [
        "Missing optional dependency: pdf-parse — Required for PDF document sources. Install: npm install pdf-parse",
        "Missing required environment variable: DATABASE_URL",
      ],
    };

    const output = formatValidationResult(result);
    expect(output).toContain("Optional Dependencies:");
    expect(output).toContain("pdf-parse");
    expect(output).toContain("2 error(s) found");
    expect(output).toContain(
      "- Missing required environment variable: DATABASE_URL",
    );
    // The optional dep error should appear in the Optional Dependencies section, not in the error list
    const lines = output.split("\n");
    const errorListLines = lines.filter(
      (l) => l.startsWith("  - ") && l.includes("Missing required"),
    );
    expect(errorListLines).toHaveLength(1);
  });

  it("formats result with only optional dep warnings as no hard errors", () => {
    const result: ValidationResult = {
      configValid: true,
      envVars: [],
      sources: [],
      tools: [],
      errors: [
        "Missing optional dependency: mammoth — Required for DOCX document sources. Install: npm install mammoth",
      ],
    };

    const output = formatValidationResult(result);
    expect(output).toContain("Optional Dependencies:");
    expect(output).toContain(
      "1 optional dependency warning(s), no hard errors",
    );
    expect(output).not.toContain("error(s) found");
  });

  it("includes section headers", () => {
    const result: ValidationResult = {
      configValid: true,
      envVars: [],
      sources: [],
      tools: [],
      errors: [],
    };

    const output = formatValidationResult(result);
    expect(output).toContain("Pathfinder Config Validation");
    expect(output).toContain("============================");
    expect(output).toContain("Environment Variables:");
    expect(output).toContain("Sources:");
    expect(output).toContain("Tools:");
  });
});
