import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  registerBashTool,
  MODERN_WORKSPACE_REFUSAL,
  READ_ONLY_ERROR,
} from "../mcp/tools/bash.js";
import { BashSessionState } from "../mcp/tools/bash-session.js";
import { WorkspaceManager } from "../workspace.js";
import type { BashToolConfig } from "../types.js";
import fs from "fs";
import os from "os";
import path from "path";

const toolConfig: BashToolConfig = {
  name: "explore-docs",
  type: "bash",
  description: "Explore docs",
  sources: ["docs"],
  bash: { session_state: true },
};

const SESSION_ID = "test-session-456";
const WORKSPACE_NOTE =
  "/workspace is available only on 2025-era (session) connections.";
// Content of a file at /workspace in the shared virtual filesystem. Only a
// source tree with a top-level workspace/ dir can put it there (no client can
// write the shared filesystem), so it is ordinary docs content.
const SEED = "SEED-CONTENT-7f3a notes";

interface Harness {
  client: Client;
  server: McpServer;
  workspace: WorkspaceManager;
  bash: Bash;
}

/**
 * `sid` is what getSessionId returns. A real modern connection has no
 * session id (src/server.ts passes `() => undefined` to the modern
 * createMcpServer). The `modern` + SESSION_ID harness exists so that the
 * WorkspaceManager spies can fire: without the refusal, a modern command with
 * a session id reaches the legacy workspace interception.
 */
async function build(
  era: "legacy" | "modern",
  sid: string | undefined,
  tmpDir: string,
  bash: Bash = new Bash({
    files: {
      "/docs/workspace-setup.mdx": "# Workspace setup guide",
      "/docs/guide.md": "Save notes under /workspace on old clients.",
      "/workspaces/readme.md": "plural workspaces dir",
    },
    cwd: "/",
  }),
): Promise<Harness> {
  const workspace = new WorkspaceManager(tmpDir, 1024);
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerBashTool(server, toolConfig, bash, {
    sessionState: new BashSessionState(),
    workspace,
    getSessionId: () => sid,
    era,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server, workspace, bash };
}

function getText(result: { content?: unknown }): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

async function run(h: Harness, command: string): Promise<string> {
  return getText(
    await h.client.callTool({ name: "explore-docs", arguments: { command } }),
  );
}

// Every row names a file operation whose resolved path is /workspace or
// below it. The first block was refused by the A7 regex; the second block
// is the R2-A1 bypass set (glob, brace, //, .., backslash, relative, a
// variable that expands to the path, and cd).
const MUST_REFUSE: Array<[string, string]> = [
  ["bare ls", "ls /workspace"],
  ["quoted path", 'cat "/workspace/a.txt"'],
  ["redirect without space", "echo hi >/workspace/a.txt"],
  ["after a pipe", "ls /docs | tee /workspace/a.txt"],
  ["write", 'echo "hi" > /workspace/a.txt'],
  ["ls with slash", "ls /workspace/"],
  ["cd", "cd /workspace"],
  ["brace", "ls {/workspace,/docs}"],
  ["double slash", "cat //workspace/seed.txt"],
  ["dot-dot", "cat /docs/../workspace/seed.txt"],
  ["backslash", "cat \\/workspace/seed.txt"],
  ["relative from /", "cat workspace/seed.txt"],
  ["variable", 'x=1:/workspace/seed.txt; cat "${x#1:}"'],
  ["cd double slash", "cd //workspace"],
  ["cd relative", "cd workspace"],
  ["double-slash write", "echo hi > //workspace/n"],
  ["error hidden", "cat //workspace/seed.txt 2>/dev/null; echo done"],
];

// Plain text that names /workspace, and paths that only look like it. None of
// these is a file operation on /workspace.
const MUST_NOT_REFUSE: Array<[string, string, string]> = [
  [
    "grep pattern naming /workspace",
    'grep -rn "/workspace" /docs',
    "/docs/guide.md:1:Save notes under /workspace on old clients.",
  ],
  ["echo of the text", "echo /workspace", "/workspace"],
  [
    "path containing workspace-",
    "cat /docs/workspace-setup.mdx",
    "# Workspace setup guide",
  ],
  ["plural /workspaces", "cat /workspaces/readme.md", "plural workspaces dir"],
];

function spyWorkspace(ws: WorkspaceManager) {
  return [
    vi.spyOn(ws, "ensureSession"),
    vi.spyOn(ws, "writeFile"),
    vi.spyOn(ws, "readFile"),
    vi.spyOn(ws, "listFiles"),
  ];
}

describe("modern /workspace refusal", () => {
  let tmpDir: string;
  let modern: Harness;
  let modernSid: Harness;
  let legacy: Harness;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pathfinder-wsm-test-"));
    modern = await build("modern", undefined, path.join(tmpDir, "m"));
    modernSid = await build("modern", SESSION_ID, path.join(tmpDir, "ms"));
    legacy = await build("legacy", SESSION_ID, path.join(tmpDir, "l"));
  });

  afterAll(async () => {
    for (const h of [modern, modernSid, legacy]) {
      await h.client.close();
      await h.server.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exports the refusal text", () => {
    expect(MODERN_WORKSPACE_REFUSAL).toBe(
      "workspace: /workspace is unavailable on 2026-07-28 connections; it works only on 2025-era (session) connections",
    );
  });

  it.each(MUST_REFUSE)("modern refuses a %s: %s", async (_n, cmd) => {
    const text = await run(modern, cmd);
    expect(text).toContain(MODERN_WORKSPACE_REFUSAL);
    expect(text).toContain("[exit code 1]");
    expect(text).not.toContain(SEED);
  });

  it.each(MUST_NOT_REFUSE)(
    "modern does not refuse a %s: %s",
    async (_n, cmd, expected) => {
      const text = await run(modern, cmd);
      expect(text).not.toContain(MODERN_WORKSPACE_REFUSAL);
      expect(text).toContain(expected);
    },
  );

  it("a source tree's top-level workspace/ dir is ordinary read-only docs on modern", async () => {
    const shared = new Bash({
      files: {
        "/docs/guide.md": "Save notes here.",
        "/workspace/seed.txt": SEED,
      },
      cwd: "/",
    });
    const m = await build("modern", undefined, path.join(tmpDir, "sm"), shared);
    try {
      expect(await run(m, "cat /workspace/seed.txt")).toContain(SEED);
      const grep = await run(m, "grep -r notes /");
      expect(grep).toContain("docs/guide.md:Save notes here.");
      expect(grep).toContain(SEED);
      expect(grep).not.toContain(MODERN_WORKSPACE_REFUSAL);
      expect(await run(m, "echo x > /workspace/seed.txt")).toContain(
        READ_ONLY_ERROR,
      );
      expect(await shared.fs.readFile("/workspace/seed.txt")).toBe(SEED);
    } finally {
      await m.client.close();
      await m.server.close();
    }
  });

  it("a 2025-era command can no longer create /workspace in the shared filesystem", async () => {
    const shared = new Bash({
      files: { "/docs/guide.md": "Save notes here." },
      cwd: "/",
    });
    const l = await build(
      "legacy",
      SESSION_ID,
      path.join(tmpDir, "xl"),
      shared,
    );
    const m = await build("modern", undefined, path.join(tmpDir, "xm"), shared);
    try {
      // No "/workspace" substring, so the legacy interception does not
      // catch it and it runs against the read-only shared filesystem.
      expect(
        await run(l, "mkdir workspace && echo legacy-made > workspace/f.txt"),
      ).toContain(READ_ONLY_ERROR);
      expect(await shared.fs.exists("/workspace")).toBe(false);
      expect(await run(m, "cat workspace/f.txt")).toContain(
        MODERN_WORKSPACE_REFUSAL,
      );
    } finally {
      for (const h of [l, m]) {
        await h.client.close();
        await h.server.close();
      }
    }
  });

  it("a refused modern write leaves the shared filesystem unchanged", async () => {
    for (const cmd of [
      "echo hi > //workspace/n1",
      "echo hi > /docs/../workspace/n2",
      "echo hi > workspace/n3",
      "mkdir -p /docs/../workspace/d && echo hi > /workspace/d/n4",
      "cp /docs/guide.md //workspace/n5",
    ]) {
      expect(await run(modern, cmd)).toContain(MODERN_WORKSPACE_REFUSAL);
    }
    for (const p of ["n1", "n2", "n3", "d", "n5"]) {
      expect(await modern.bash.fs.exists(`/workspace/${p}`)).toBe(false);
    }
    expect(await run(modern, "cat /docs/../workspace/n1")).not.toContain("hi");
  });

  // R2-A4: with a real session id, a modern command would reach the legacy
  // WorkspaceManager interception if the refusal did not stop it first.
  it.each([
    ["write", 'echo "hi" > /workspace/a.txt'],
    ["cat", "cat /workspace/a.txt"],
    ["ls", "ls /workspace/"],
    ["catch-all", "wc -l /workspace/a.txt"],
  ])(
    "modern with a session id refuses a %s and never touches WorkspaceManager",
    async (_n, cmd) => {
      const spies = spyWorkspace(modernSid.workspace);
      try {
        const text = await run(modernSid, cmd);
        for (const s of spies) expect(s).not.toHaveBeenCalled();
        expect(text).toContain(MODERN_WORKSPACE_REFUSAL);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    },
  );

  it("modern without a session id never touches WorkspaceManager", async () => {
    const spies = spyWorkspace(modern.workspace);
    try {
      for (const [, cmd] of MUST_REFUSE) await run(modern, cmd);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it("legacy write/cat/ls round-trip still works", async () => {
    expect(
      await run(legacy, 'echo "round trip" > /workspace/rt.txt'),
    ).toContain("Written to /workspace/rt.txt");
    expect(await run(legacy, "cat /workspace/rt.txt")).toContain("round trip");
    expect(await run(legacy, "ls /workspace/")).toContain("rt.txt");
  });

  it("modern description with workspace ends with the note; legacy is unchanged", async () => {
    const m = (await modern.client.listTools()).tools[0].description;
    const l = (await legacy.client.listTools()).tools[0].description;
    expect(m?.endsWith(`\n\n${WORKSPACE_NOTE}`)).toBe(true);
    expect(l).toBe("Explore docs");
  });
});
