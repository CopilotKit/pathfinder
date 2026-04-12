import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBashTool } from "../mcp/tools/bash.js";
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

const SESSION_ID = "test-session-123";

describe("workspace command interception", () => {
  let client: Client;
  let server: McpServer;
  let workspace: WorkspaceManager;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pathfinder-ws-test-"));
    workspace = new WorkspaceManager(tmpDir, 1024); // 1KB quota for tests

    server = new McpServer({ name: "test", version: "1.0.0" });
    const bash = new Bash({ files: {}, cwd: "/" });
    const sessionState = new BashSessionState();
    registerBashTool(server, toolConfig, bash, {
      sessionState,
      workspace,
      getSessionId: () => SESSION_ID,
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function callBash(command: string) {
    return client.callTool({ name: "explore-docs", arguments: { command } });
  }
  function getText(result: Awaited<ReturnType<typeof callBash>>): string {
    return (result.content as Array<{ type: string; text: string }>)[0].text;
  }

  it("echo > /workspace/file writes file and returns confirmation", async () => {
    const text = getText(
      await callBash('echo "hello world" > /workspace/notes.txt'),
    );
    expect(text).toContain("Written to /workspace/notes.txt");
  });

  it("cat /workspace/file reads file content", async () => {
    // Write first, then read
    await callBash('echo "cat content" > /workspace/cat-test.txt');
    const text = getText(await callBash("cat /workspace/cat-test.txt"));
    expect(text).toContain("cat content");
  });

  it("head /workspace/file reads file content", async () => {
    await callBash('echo "head content" > /workspace/head-test.txt');
    const text = getText(await callBash("head /workspace/head-test.txt"));
    expect(text).toContain("head content");
  });

  it("tail /workspace/file reads file content", async () => {
    await callBash('echo "tail content" > /workspace/tail-test.txt');
    const text = getText(await callBash("tail /workspace/tail-test.txt"));
    expect(text).toContain("tail content");
  });

  it("ls /workspace/ lists files in workspace", async () => {
    // Ensure at least one file exists from previous tests
    await callBash('echo "ls test" > /workspace/ls-test.txt');
    const text = getText(await callBash("ls /workspace/"));
    expect(text).toContain("ls-test.txt");
  });

  it("ls -la /workspace/ lists files with flags", async () => {
    await callBash('echo "flag test" > /workspace/flag-test.txt');
    const text = getText(await callBash("ls -la /workspace/"));
    expect(text).toContain("flag-test.txt");
  });

  it("rm /workspace/file returns supported operations error", async () => {
    const text = getText(await callBash("rm /workspace/file.txt"));
    expect(text).toContain("supported operations");
    expect(text).toContain("[exit code 1]");
  });

  it("cat /workspace/../../../etc/passwd is blocked by path traversal protection", async () => {
    const text = getText(await callBash("cat /workspace/../../../etc/passwd"));
    expect(text).toContain("No such file");
  });

  it("cat /workspace/missing.txt returns No such file", async () => {
    const text = getText(await callBash("cat /workspace/missing.txt"));
    expect(text).toContain("No such file");
  });
});

describe("workspace quota enforcement", () => {
  let client: Client;
  let server: McpServer;
  let workspace: WorkspaceManager;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pathfinder-ws-quota-"));
    // Tiny 50-byte quota to make exceeding easy
    workspace = new WorkspaceManager(tmpDir, 50);

    server = new McpServer({ name: "test", version: "1.0.0" });
    const bash = new Bash({ files: {}, cwd: "/" });
    const sessionState = new BashSessionState();
    registerBashTool(server, toolConfig, bash, {
      sessionState,
      workspace,
      getSessionId: () => "quota-session",
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function callBash(command: string) {
    return client.callTool({ name: "explore-docs", arguments: { command } });
  }
  function getText(result: Awaited<ReturnType<typeof callBash>>): string {
    return (result.content as Array<{ type: string; text: string }>)[0].text;
  }

  it("write exceeding quota returns quota exceeded error", async () => {
    // First write a small file to partially consume quota
    await callBash('echo "small" > /workspace/first.txt');
    // Now write a large file that exceeds the remaining quota
    const largeContent = "x".repeat(100);
    const text = getText(
      await callBash(`echo "${largeContent}" > /workspace/big.txt`),
    );
    expect(text).toContain("quota exceeded");
    expect(text).toContain("[exit code 1]");
  });
});
