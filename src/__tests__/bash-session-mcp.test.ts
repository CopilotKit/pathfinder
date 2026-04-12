import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
    expect(getText(result)).toContain("/docs");
  });

  it("cd to nonexistent directory returns error", async () => {
    const result = await callBash("cd /nonexistent");
    const text = getText(result);
    expect(text).toContain("No such file or directory");
  });
});
