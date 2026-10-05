/**
 * The bash tool's virtual filesystem is one shared Bash per tool, read by
 * every client (src/server.ts builds it once per tool; the legacy and modern
 * legs both pass it to registerBashTool). These rows pin the contract:
 *
 * - Modern (2026-07-28): a read-only view of the shared filesystem plus a
 *   private /tmp that lives for one call and is then discarded.
 * - Legacy (2025-era): the same read-only view plus a /tmp that is private
 *   to the session and lasts as long as the session. The real /workspace
 *   store (WorkspaceManager, on disk) is unchanged.
 *
 * Each modern request gets a fresh McpServer, the same as the modern
 * buildServer in src/server.ts. Each legacy session is one McpServer with
 * its own registerBashTool call, the same as the legacy session handlers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  registerBashTool,
  MODERN_WORKSPACE_REFUSAL,
} from "../mcp/tools/bash.js";
import { BashSessionState } from "../mcp/tools/bash-session.js";
import { WorkspaceManager } from "../workspace.js";
import type { BashToolConfig, ChunkResult } from "../types.js";
import type { EmbeddingProvider } from "../indexing/embeddings.js";
import fs from "fs";
import os from "os";
import path from "path";

function chunk(file_path: string, similarity: number): ChunkResult {
  return {
    id: 1,
    source_name: "",
    source_url: null,
    title: null,
    content: "",
    repo_url: null,
    file_path,
    start_line: null,
    end_line: null,
    language: null,
    similarity,
    cosine_similarity: similarity,
  };
}

// `related` looks up neighbours in the vector index; there is no index here.
vi.mock("../db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/queries.js")>()),
  searchChunks: vi.fn(async () => [chunk("docs/guide/b.md", 0.9)]),
}));

const embeddingClient: EmbeddingProvider = {
  embed: async () => [0.1, 0.2, 0.3],
  embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
};

const toolConfig: BashToolConfig = {
  name: "explore-docs",
  type: "bash",
  description: "Explore docs",
  sources: ["docs"],
  bash: { session_state: true },
};

const ORIGINAL = "ORIGINAL A";
const READ_ONLY = /read-only file system/i;

function sharedBash(): Bash {
  return new Bash({
    files: {
      "/docs/a.md": ORIGINAL,
      "/docs/guide/b.md": "guide body B",
    },
    cwd: "/",
  });
}

interface Conn {
  run(command: string): Promise<string>;
  close(): Promise<void>;
}

async function connect(
  bash: Bash,
  era: "legacy" | "modern",
  opts: { sid?: string; workspace?: WorkspaceManager } = {},
): Promise<Conn> {
  const server = new McpServer({ name: "t", version: "1" });
  registerBashTool(server, toolConfig, bash, {
    sessionState: era === "legacy" ? new BashSessionState() : undefined,
    workspace: opts.workspace,
    getSessionId: () => opts.sid,
    embeddingClient,
    era,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "c", version: "1" });
  await client.connect(ct);
  return {
    async run(command) {
      const r = await client.callTool({
        name: "explore-docs",
        arguments: { command },
      });
      return (r.content as Array<{ type: string; text: string }>)[0].text;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** One modern request: a fresh server, one call, then closed. */
async function modernRequest(
  bash: Bash,
  command: string,
  workspace?: WorkspaceManager,
): Promise<string> {
  const c = await connect(bash, "modern", { workspace });
  try {
    return await c.run(command);
  } finally {
    await c.close();
  }
}

async function docsIntact(bash: Bash): Promise<void> {
  expect(await bash.fs.exists("/docs/a.md")).toBe(true);
  expect(await bash.fs.readFile("/docs/a.md")).toBe(ORIGINAL);
  expect(await bash.fs.readFile("/docs/guide/b.md")).toBe("guide body B");
}

describe("shared bash filesystem isolation", () => {
  let tmpDir: string;
  let open: Conn[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pathfinder-fsiso-"));
    open = [];
  });

  afterEach(async () => {
    for (const c of open) await c.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function legacy(
    bash: Bash,
    sid: string,
    workspace?: WorkspaceManager,
  ): Promise<Conn> {
    const c = await connect(bash, "legacy", { sid, workspace });
    open.push(c);
    return c;
  }

  // (a)
  it("(a) modern: request A's /tmp file is not visible to request B", async () => {
    const bash = sharedBash();
    expect(
      await modernRequest(bash, "echo secret-a > /tmp/x; cat /tmp/x"),
    ).toContain("secret-a");
    const b = await modernRequest(bash, "cat /tmp/x");
    expect(b).not.toContain("secret-a");
    expect(b).toContain("No such file");
    expect(await bash.fs.exists("/tmp/x")).toBe(false);
  });

  it("(a) modern: /tmp does not survive to the next call on the same server", async () => {
    const bash = sharedBash();
    const c = await connect(bash, "modern");
    open.push(c);
    await c.run("echo secret-a > /tmp/x");
    expect(await c.run("cat /tmp/x")).not.toContain("secret-a");
  });

  // (b)
  it("(b) modern: a write to /docs/a.md fails and other clients still read the original", async () => {
    const bash = sharedBash();
    const text = await modernRequest(bash, "echo POISON > /docs/a.md");
    expect(text).toMatch(READ_ONLY);
    expect(text).toContain("[exit code 1]");
    await docsIntact(bash);
    expect(await modernRequest(bash, "cat /docs/a.md")).toContain(ORIGINAL);
    const l = await legacy(bash, "sid-b");
    expect(await l.run("cat /docs/a.md")).toContain(ORIGINAL);
  });

  it.each([
    ["append", "echo POISON >> /docs/a.md"],
    ["touch", "touch /docs/new.md"],
    ["mkdir", "mkdir /docs/d"],
    ["tee", "echo POISON | tee /docs/a.md"],
    ["cp", "cp /docs/guide/b.md /docs/a.md"],
    ["mv", "mv /docs/guide/b.md /docs/a.md"],
    ["rm", "rm /docs/a.md"],
    ["ln", "ln -s /docs/guide/b.md /docs/link.md"],
  ])("(b) modern: %s outside /tmp fails read-only", async (_n, cmd) => {
    const bash = sharedBash();
    const text = await modernRequest(bash, cmd);
    expect(text).toMatch(READ_ONLY);
    await docsIntact(bash);
    for (const p of ["/docs/new.md", "/docs/d", "/docs/link.md"]) {
      expect(await bash.fs.exists(p)).toBe(false);
    }
  });

  // (c)
  for (const wsOn of [false, true]) {
    it.each([
      ["rm -rf /", "rm -rf /"],
      ["rm -rf /docs/..", "rm -rf /docs/.."],
      ["symlink to /", "ln -s / /docs/r; ls /docs/r"],
      ["mv onto /workspace", "mv /docs /workspace"],
      ["cp -r onto /workspace", "cp -r /docs /workspace"],
    ])(
      `(c) modern (workspace ${wsOn ? "on" : "off"}): %s is refused and has no effect`,
      async (_n, cmd) => {
        const bash = sharedBash();
        const ws = wsOn
          ? new WorkspaceManager(path.join(tmpDir, "ws"), 1024)
          : undefined;
        const text = await modernRequest(bash, cmd, ws);
        if (wsOn && cmd.includes("/workspace")) {
          expect(text).toContain(MODERN_WORKSPACE_REFUSAL);
        } else {
          expect(text).toMatch(READ_ONLY);
        }
        // `ln ...; ls /docs/r` exits with ls's code.
        expect(text).toMatch(/\[exit code [12]\]/);
        await docsIntact(bash);
        expect(await bash.fs.exists("/docs/r")).toBe(false);
        expect(await bash.fs.exists("/workspace")).toBe(false);
      },
    );
  }

  // (d)
  it("(d) legacy: a write to /docs/a.md fails and other clients still read the original", async () => {
    const bash = sharedBash();
    const l1 = await legacy(bash, "sid-1");
    const text = await l1.run("echo POISON > /docs/a.md");
    expect(text).toMatch(READ_ONLY);
    expect(text).toContain("[exit code 1]");
    await docsIntact(bash);
    expect(await l1.run("cat /docs/a.md")).toContain(ORIGINAL);
    const l2 = await legacy(bash, "sid-2");
    expect(await l2.run("cat /docs/a.md")).toContain(ORIGINAL);
    expect(await modernRequest(bash, "cat /docs/a.md")).toContain(ORIGINAL);
  });

  // (e)
  it.each([
    ["rm -rf /docs", "rm -rf /docs"],
    ["rm -rf /", "rm -rf /"],
    ["relative rm after cd", "cd /docs && rm -rf guide"],
  ])("(e) legacy: %s is refused and the docs are intact", async (_n, cmd) => {
    const bash = sharedBash();
    const l = await legacy(bash, "sid-e");
    const text = await l.run(cmd);
    expect(text).toMatch(READ_ONLY);
    expect(text).toContain("[exit code 1]");
    await docsIntact(bash);
    expect(await l.run("cat /docs/guide/b.md")).toContain("guide body B");
  });

  // (f)
  it("(f) legacy: /tmp is private to the session and lasts across its calls", async () => {
    const bash = sharedBash();
    const l1 = await legacy(bash, "sid-f1");
    const l2 = await legacy(bash, "sid-f2");
    expect(await l1.run("echo mine-1 > /tmp/x")).not.toMatch(READ_ONLY);
    expect(await l1.run("cat /tmp/x")).toContain("mine-1");
    const other = await l2.run("cat /tmp/x");
    expect(other).not.toContain("mine-1");
    expect(other).toContain("No such file");
    expect(await modernRequest(bash, "cat /tmp/x")).not.toContain("mine-1");
    expect(await bash.fs.exists("/tmp/x")).toBe(false);
  });

  it("(f) legacy: cd into a session /tmp directory persists", async () => {
    const bash = sharedBash();
    const l = await legacy(bash, "sid-f3");
    await l.run("mkdir -p /tmp/work");
    expect(await l.run("cd /tmp/work")).toBe("$ cd /tmp/work");
    await l.run("echo note > n.txt");
    expect(await l.run("pwd")).toContain("/tmp/work");
    expect(await l.run("cat /tmp/work/n.txt")).toContain("note");
  });

  // (g)
  it("(g) legacy: the /workspace real-store round trip still works", async () => {
    const bash = sharedBash();
    const ws = new WorkspaceManager(path.join(tmpDir, "ws"), 1024);
    const l = await legacy(bash, "sid-g", ws);
    expect(await l.run('echo "round trip" > /workspace/rt.txt')).toContain(
      "Written to /workspace/rt.txt",
    );
    expect(await l.run("cat /workspace/rt.txt")).toContain("round trip");
    expect(await l.run("ls /workspace/")).toContain("rt.txt");
    // Content can come from the session's own /tmp.
    await l.run("echo from-tmp > /tmp/src.txt");
    expect(await l.run("cat /tmp/src.txt > /workspace/c.txt")).toContain(
      "Written to /workspace/c.txt",
    );
    expect(ws.readFile("sid-g", "c.txt")).toContain("from-tmp");
    expect(await bash.fs.exists("/workspace")).toBe(false);
  });

  // (h)
  const READS: Array<[string, string, string]> = [
    ["grep -r", "grep -r ORIGINAL /docs", "/docs/a.md:ORIGINAL A"],
    ["grep -r of /", 'grep -r "guide body" /', "guide body B"],
    ["find", "find / -name '*.md'", "/docs/guide/b.md"],
    ["ls", "ls /docs", "guide"],
    ["cat", "cat /docs/guide/b.md", "guide body B"],
    ["head", "head -n 1 /docs/a.md", ORIGINAL],
    ["wc", "wc -c /docs/a.md", "/docs/a.md"],
    ["related", "related /docs/a.md", "/docs/guide/b.md"],
  ];
  for (const era of ["modern", "legacy"] as const) {
    it.each(READS)(`(h) ${era}: %s still works`, async (_n, cmd, expected) => {
      const bash = sharedBash();
      const c =
        era === "modern"
          ? await connect(bash, "modern")
          : await legacy(bash, "sid-h");
      if (era === "modern") open.push(c);
      const text = await c.run(cmd);
      expect(text).toContain(expected);
      expect(text).not.toContain("[exit code");
      expect(text).not.toMatch(READ_ONLY);
    });
  }

  // (i) /dev/null and /dev/zero are sinks: writes to them succeed and are
  // discarded, and never reach the shared filesystem. Expected text is
  // computed by the shell, so it never appears in the echoed command line.
  const SINKS: Array<[string, string, string]> = [
    [
      "> /dev/null keeps $?",
      "grep zzz /docs/a.md > /dev/null; echo rc=$?",
      "\nrc=1",
    ],
    ["&> /dev/null", "cat /docs/a.md &> /dev/null; echo $((40+2))", "\n42"],
    [">> /dev/null", "echo x >> /dev/null; echo $((40+2))", "\n42"],
    ["> /dev/zero", "echo x > /dev/zero; echo $((40+2))", "\n42"],
    ["tee /dev/null", "echo $((40+2)) | tee /dev/null", "\n42"],
    [
      "grep -q >/dev/null 2>&1 &&",
      'grep -q ORIGINAL /docs/a.md >/dev/null 2>&1 && echo fo""und',
      "\nfound",
    ],
  ];
  for (const era of ["modern", "legacy"] as const) {
    async function runOnce(bash: Bash, cmd: string, sid: string) {
      if (era === "modern") return modernRequest(bash, cmd);
      return (await legacy(bash, sid)).run(cmd);
    }

    it.each(SINKS)(
      `(i) ${era}: %s succeeds and is discarded`,
      async (_n, cmd, expected) => {
        const bash = sharedBash();
        const text = await runOnce(bash, cmd, "sid-i");
        expect(text).toContain(expected);
        expect(text).not.toContain(ORIGINAL);
        expect(text).not.toContain("[exit code");
        expect(text).not.toMatch(READ_ONLY);
        await docsIntact(bash);
        expect(await bash.fs.readFile("/dev/null")).toBe("");
      },
    );

    it(`(i) ${era}: a write to /dev/null is never visible to another client`, async () => {
      const bash = sharedBash();
      const a = await runOnce(bash, "echo $((40+2)) > /dev/null", "sid-i1");
      expect(a).not.toContain("[exit code");
      expect(a).not.toMatch(READ_ONLY);
      const l = await legacy(bash, "sid-i2");
      for (const b of [
        await modernRequest(bash, "cat /dev/null; echo end"),
        await l.run("cat /dev/null; echo end"),
      ]) {
        expect(b).toContain("\nend");
        expect(b).not.toContain("42");
      }
      expect(await bash.fs.readFile("/dev/null")).toBe("");
    });

    // (j) A refused write does not stop the rest of the command line.
    it(`(j) ${era}: output around a refused redirect is kept`, async () => {
      const bash = sharedBash();
      const text = await runOnce(
        bash,
        "echo $((20+1)); echo b > /docs/x; echo $((30+3))",
        "sid-j1",
      );
      expect(text).toContain("\n21\n33\n");
      expect(text).toMatch(READ_ONLY);
      expect(text).toContain("[exit code 1]");
      expect(await bash.fs.exists("/docs/x")).toBe(false);
      await docsIntact(bash);
    });

    it(`(j) ${era}: a refused touch still fails, so its fallback runs`, async () => {
      const bash = sharedBash();
      const text = await runOnce(
        bash,
        'touch /docs/x 2>/dev/null || echo fall""back',
        "sid-j2",
      );
      expect(text).toContain("\nfallback");
      expect(text).toMatch(READ_ONLY);
      expect(await bash.fs.exists("/docs/x")).toBe(false);
      await docsIntact(bash);
    });
  }

  it("(h) legacy: cd persistence and relative reads still work", async () => {
    const bash = sharedBash();
    const l = await legacy(bash, "sid-h2");
    expect(await l.run("cd /docs")).toBe("$ cd /docs");
    expect(await l.run("cat a.md")).toContain(ORIGINAL);
    expect(await l.run("cd guide")).toBe("$ cd guide");
    expect(await l.run("pwd")).toContain("/docs/guide");
    expect(await l.run("cd /nope")).toContain("No such file or directory");
  });
});
