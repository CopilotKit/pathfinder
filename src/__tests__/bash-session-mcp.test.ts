import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerBashTool } from "../mcp/tools/bash.js";
import { BashSessionState } from "../mcp/tools/bash-session.js";
import type { BashToolConfig } from "../types.js";

const files: Record<string, string> = {
  "/docs/quickstart.mdx": "# Quickstart\nGet started.",
  "/docs/guides/streaming.mdx": "# Streaming\nHow to stream.",
  "/code/src/index.ts": "export function main() {}",
};

const toolConfig: BashToolConfig = {
  name: "explore-docs",
  type: "bash",
  description: "Explore docs",
  sources: ["docs"],
  bash: { session_state: true },
};

describe("bash tool with session CWD tracking", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    const bash = new Bash({ files, cwd: "/" });
    const sessionState = new BashSessionState();
    registerBashTool(server, toolConfig, bash, { sessionState });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  function callBash(command: string) {
    return client.callTool({ name: "explore-docs", arguments: { command } });
  }
  function getText(result: Awaited<ReturnType<typeof callBash>>): string {
    return (result.content as Array<{ type: string; text: string }>)[0].text;
  }

  it("cd persists CWD across calls", async () => {
    await callBash("cd /docs");
    const result = await callBash("pwd");
    expect(getText(result)).toContain("/docs");
  });

  it("ls uses persistent CWD", async () => {
    await callBash("cd /docs");
    const result = await callBash("ls");
    const text = getText(result);
    expect(text).toContain("quickstart.mdx");
    expect(text).toContain("guides");
  });

  it("cd with relative path works", async () => {
    await callBash("cd /docs");
    await callBash("cd guides");
    const result = await callBash("pwd");
    expect(getText(result)).toContain("/docs/guides");
  });

  it("cd .. goes up one level", async () => {
    await callBash("cd /docs/guides");
    await callBash("cd ..");
    const result = await callBash("pwd");
    expect(getText(result)).toBe("$ pwd\n/docs\n");
  });

  it("cd to nonexistent directory returns error", async () => {
    const result = await callBash("cd /nonexistent");
    const text = getText(result);
    expect(text).toContain("No such file or directory");
  });
});

describe("bash tool, legacy bare cd target is literal", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    const bash = new Bash({ files, cwd: "/" });
    registerBashTool(server, toolConfig, bash, {
      sessionState: new BashSessionState(),
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
  });

  async function run(command: string): Promise<string> {
    const result = await client.callTool({
      name: "explore-docs",
      arguments: { command },
    });
    return (result.content as Array<{ type: string; text: string }>)[0].text;
  }

  it("does not run a $(...) in the target", async () => {
    // Positive control: when the shell runs the substitution, the path
    // becomes "//", which exists.
    expect(await run("test -d /$(pwd) && echo yes")).toContain("yes");

    const text = await run("cd /$(pwd)");
    expect(text).toContain("No such file or directory");
    expect(await run("pwd")).toBe("$ pwd\n/\n");
  });

  it("does not run a side effect hidden in the target", async () => {
    // This session's /tmp persists across calls, so a write made by the
    // substitution would be visible to the next call.
    const text = await run("cd /tmp$(echo>/tmp/cd-marker)");
    expect(await run("ls /tmp")).not.toContain("cd-marker");
    expect(text).toContain("No such file or directory");
    // Positive control: the same write from a normal command is visible.
    await run("echo>/tmp/control-marker");
    expect(await run("ls /tmp")).toContain("control-marker");
  });

  it("does not run a backtick substitution in the target", async () => {
    const text = await run("cd /`pwd`");
    expect(text).toContain("No such file or directory");
  });

  it("still changes to an existing directory", async () => {
    expect(await run("cd /docs/guides")).toBe("$ cd /docs/guides");
    expect(await run("pwd")).toBe("$ pwd\n/docs/guides\n");
    await run("cd /");
  });

  it("removes outer double quotes from the target", async () => {
    expect(await run('cd "/docs"')).toBe('$ cd "/docs"');
    expect(await run("pwd")).toBe("$ pwd\n/docs\n");
    await run("cd /");
  });

  it("removes outer single quotes from the target", async () => {
    expect(await run("cd '/docs'")).toBe("$ cd '/docs'");
    expect(await run("pwd")).toBe("$ pwd\n/docs\n");
    await run("cd /");
  });

  it("does not run a $(...) inside a double-quoted target", async () => {
    const text = await run('cd "/tmp$(echo>/tmp/cd-quoted-marker)"');
    expect(text).toContain("No such file or directory");
    expect(await run("ls /tmp")).not.toContain("cd-quoted-marker");
    expect(await run("pwd")).toBe("$ pwd\n/\n");
  });
});
