import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { stringify } from "yaml";

// Mirror config.test.ts: control the module cache and mock fs so each test
// drives a fresh parseConfig() over a hand-built YAML config.

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const mockedExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockedReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

function makeYaml(overrides: Record<string, unknown> = {}): string {
  const base = {
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
        name: "search-docs",
        type: "search",
        source: "docs",
        description: "Search docs",
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
    ...overrides,
  };
  return stringify(base);
}

// Fresh import helper — resets module cache so cached config is cleared.
async function freshImport() {
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual("node:fs");
    return {
      ...actual,
      existsSync: mockedExistsSync,
      readFileSync: mockedReadFileSync,
    };
  });
  return await import("../config.js");
}

// A slack-source config: exercises SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET gating.
function slackYaml(): string {
  return makeYaml({
    sources: [{ name: "slack", type: "slack", channels: ["C123"], chunk: {} }],
    tools: [
      {
        name: "s",
        type: "search",
        source: "slack",
        description: "d",
        default_limit: 5,
        max_limit: 10,
        result_format: "docs",
      },
    ],
  });
}

describe("SLACK_SIGNING_SECRET boot validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    // Start each test from an EMPTY, controlled env base — NOT a spread of the
    // ambient shell env. Spreading `originalEnv` let a var set in the runner's
    // shell (esp. OPENAI_API_KEY) leak in, so preflight negatives (absence
    // cases) became shell-dependent and the covered paths drifted with the
    // environment. Each test sets exactly the vars it needs below.
    process.env = {};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when SLACK_SIGNING_SECRET is missing and a slack source is configured", async () => {
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    delete process.env.SLACK_SIGNING_SECRET;

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(slackYaml());

    const { getConfig } = await freshImport();
    expect(() => getConfig()).toThrow("SLACK_SIGNING_SECRET");
  });

  it("boots when SLACK_SIGNING_SECRET is present and a slack source is configured", async () => {
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SIGNING_SECRET = "signing-secret";

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(slackYaml());

    const { getConfig } = await freshImport();
    const cfg = getConfig();
    expect(cfg.slackSigningSecret).toBe("signing-secret");
  });

  it("does not require SLACK_SIGNING_SECRET when no slack source is configured", async () => {
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.SLACK_SIGNING_SECRET;

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(makeYaml());

    const { getConfig } = await freshImport();
    expect(() => getConfig()).not.toThrow();
  });
});

describe("collectMissingRequiredEnv preflight helper", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    // Start each test from an EMPTY, controlled env base — NOT a spread of the
    // ambient shell env. Spreading `originalEnv` let a var set in the runner's
    // shell (esp. OPENAI_API_KEY) leak in, so preflight negatives (absence
    // cases) became shell-dependent and the covered paths drifted with the
    // environment. Each test sets exactly the vars it needs below.
    process.env = {};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("lists ALL missing required vars at once (does not stop at the first)", async () => {
    // Production + slack source, nothing set: the boot path throws on the
    // FIRST group it checks, but the preflight helper must enumerate the full
    // set so an operator fixes them in one pass.
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.MCP_JWT_SECRET;
    delete process.env.PATHFINDER_CONSENT_HMAC_KEY;

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(slackYaml());

    const { collectMissingRequiredEnv } = await freshImport();
    const missing = collectMissingRequiredEnv();
    const joined = missing.join(",");

    expect(missing).toContain("DATABASE_URL");
    expect(missing).toContain("SLACK_BOT_TOKEN");
    expect(missing).toContain("SLACK_SIGNING_SECRET");
    expect(joined).toContain("MCP_JWT_SECRET");
    expect(joined).toContain("PATHFINDER_CONSENT_HMAC_KEY");
    // Enumerates the full set, not just the first failing group.
    expect(missing.length).toBeGreaterThanOrEqual(5);
  });

  it("returns empty when a fully-configured production environment is provided", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SIGNING_SECRET = "signing-secret";
    process.env.MCP_JWT_SECRET = "x".repeat(64);
    process.env.PATHFINDER_CONSENT_HMAC_KEY = "a".repeat(64);

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(slackYaml());

    const { collectMissingRequiredEnv } = await freshImport();
    expect(collectMissingRequiredEnv()).toEqual([]);
  });

  it("flags a set-but-empty PATHFINDER_CONSENT_HMAC_KEY as invalid, not missing (production)", async () => {
    // A SET-but-all-empty value (e.g. "," or " ") must be reported as INVALID
    // (≥32 hex chars) rather than as merely missing — it defeats fail-loud on
    // an operator who set the var to garbage.
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MCP_JWT_SECRET = "x".repeat(64);
    process.env.PATHFINDER_CONSENT_HMAC_KEY = ",";

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(makeYaml());

    const { collectMissingRequiredEnv } = await freshImport();
    const joined = collectMissingRequiredEnv().join(",");
    expect(joined).toContain("PATHFINDER_CONSENT_HMAC_KEY");
    expect(joined).toContain("32 hex chars");
    expect(joined).not.toContain("required in production");
  });

  it("flags MCP_JWT_SECRET and PATHFINDER_CONSENT_HMAC_KEY only in production", async () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.MCP_JWT_SECRET;
    delete process.env.PATHFINDER_CONSENT_HMAC_KEY;

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(makeYaml());

    const { collectMissingRequiredEnv } = await freshImport();
    expect(collectMissingRequiredEnv()).toEqual([]);
  });
});

describe("PATHFINDER_CONSENT_HMAC_KEY set-but-empty validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws the ≥32-hex validation error (not 'required in production') for a set-but-empty value in production", async () => {
    // "," is SET but yields no valid keys — must fail loud on INVALID with the
    // ≥32-hex error, distinct from the missing/unset "required in production"
    // message.
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MCP_JWT_SECRET = "x".repeat(64);
    process.env.PATHFINDER_CONSENT_HMAC_KEY = ",";

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(makeYaml());

    const { getConfig } = await freshImport();
    expect(() => getConfig()).toThrow(/≥32 hex chars/);
    expect(() => getConfig()).not.toThrow(/required in production/);
  });

  it("throws the ≥32-hex validation error for a whitespace-only value in development (no silent ephemeral key)", async () => {
    // In dev an UNSET key generates an ephemeral one; a SET-but-whitespace
    // value is still garbage and must fail loud rather than silently generate.
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.PATHFINDER_CONSENT_HMAC_KEY = "   ";

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(makeYaml());

    const { getConfig } = await freshImport();
    expect(() => getConfig()).toThrow(/≥32 hex chars/);
  });

  it("still throws the ≥32-hex error for a non-empty but too-short value", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MCP_JWT_SECRET = "x".repeat(64);
    process.env.PATHFINDER_CONSENT_HMAC_KEY = "abc";

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(makeYaml());

    const { getConfig } = await freshImport();
    expect(() => getConfig()).toThrow(/≥32 hex chars/);
  });

  it("still accepts a valid ≥32-hex key", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MCP_JWT_SECRET = "x".repeat(64);
    process.env.PATHFINDER_CONSENT_HMAC_KEY = "a".repeat(64);

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(makeYaml());

    const { getConfig } = await freshImport();
    expect(getConfig().oauthConsentHmacKeys).toEqual(["a".repeat(64)]);
  });
});

describe("atlas preflight verb", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    // Start each test from an EMPTY, controlled env base — NOT a spread of the
    // ambient shell env. Spreading `originalEnv` let a var set in the runner's
    // shell (esp. OPENAI_API_KEY) leak in, so preflight negatives (absence
    // cases) became shell-dependent and the covered paths drifted with the
    // environment. Each test sets exactly the vars it needs below.
    process.env = {};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("exits non-zero and lists every missing var before any work (production)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    delete process.env.MCP_JWT_SECRET;
    delete process.env.PATHFINDER_CONSENT_HMAC_KEY;

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(makeYaml());

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual("node:fs");
      return {
        ...actual,
        existsSync: mockedExistsSync,
        readFileSync: mockedReadFileSync,
      };
    });
    const { runAtlasCli } = await import("../atlas-cli.js");

    let out = "";
    let err = "";
    const code = await runAtlasCli(["preflight"], {
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
    });

    expect(code).not.toBe(0);
    const combined = out + err;
    expect(combined).toContain("DATABASE_URL");
    expect(combined).toContain("MCP_JWT_SECRET");
    expect(combined).toContain("PATHFINDER_CONSENT_HMAC_KEY");
  });

  it("exits zero when the environment is fully configured", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MCP_JWT_SECRET = "x".repeat(64);
    process.env.PATHFINDER_CONSENT_HMAC_KEY = "a".repeat(64);

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(makeYaml());

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual("node:fs");
      return {
        ...actual,
        existsSync: mockedExistsSync,
        readFileSync: mockedReadFileSync,
      };
    });
    const { runAtlasCli } = await import("../atlas-cli.js");

    let out = "";
    const code = await runAtlasCli(["preflight"], {
      stdout: (t) => (out += t),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("ok");
  });
});
