import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  registerBashTool,
  MODERN_CD_HINT,
  MODERN_FS_NOTE,
} from "../mcp/tools/bash.js";
import type { BashToolOptions } from "../mcp/tools/bash.js";
import { BashSessionState } from "../mcp/tools/bash-session.js";
import { WorkspaceManager } from "../workspace.js";
import type { BashToolConfig } from "../types.js";
import fs from "fs";
import os from "os";
import path from "path";

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

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function getText(result: ToolResult): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

async function connect(
  options: BashToolOptions,
): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const bash = new Bash({ files, cwd: "/" });
  registerBashTool(server, toolConfig, bash, options);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

describe("MODERN_CD_HINT", () => {
  it("has the shared-names wording", () => {
    expect(MODERN_CD_HINT).toBe(
      "cd does not persist between calls on this connection; use absolute paths or `cd X && <cmd>`",
    );
  });
});

describe("bash tool, modern era (stateless cwd)", () => {
  let client: Client;
  let server: McpServer;
  // A session state is passed on purpose: modern must never use it.
  const sessionState = new BashSessionState();

  beforeAll(async () => {
    ({ client, server } = await connect({ sessionState, era: "modern" }));
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  function callBash(command: string) {
    return client.callTool({ name: "explore-docs", arguments: { command } });
  }

  it("bare cd to an existing dir returns the hint and does not persist", async () => {
    const cd = await callBash("cd /docs");
    expect(cd.isError).not.toBe(true);
    expect(getText(cd)).toBe(`$ cd /docs\n${MODERN_CD_HINT}`);
    expect(sessionState.getCwd()).toBe("/");

    const ls = await callBash("ls");
    const text = getText(ls);
    expect(text).toContain("docs");
    expect(text).toContain("code");
    expect(text).not.toContain("quickstart.mdx");

    const pwd = await callBash("pwd");
    expect(getText(pwd)).toBe("$ pwd\n/\n");
  });

  it("relative bare cd resolves from /", async () => {
    const cd = await callBash("cd docs/guides");
    expect(getText(cd)).toBe(`$ cd docs/guides\n${MODERN_CD_HINT}`);
    const missing = await callBash("cd guides");
    expect(getText(missing)).toContain("cd: guides: No such file or directory");
  });

  it("cd X && ls lists X", async () => {
    const result = await callBash("cd /docs && ls");
    const text = getText(result);
    expect(text).toContain("quickstart.mdx");
    expect(text).toContain("guides");
  });

  it("bare cd to a missing dir returns the existing error", async () => {
    const result = await callBash("cd /nonexistent");
    expect(getText(result)).toBe(
      "$ cd /nonexistent\ncd: /nonexistent: No such file or directory\n\n[exit code 1]",
    );
  });

  it("description ends with the cd hint and the filesystem note", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "explore-docs");
    expect(tool?.description).toBe(
      `Explore docs\n\n${MODERN_CD_HINT}\n\n${MODERN_FS_NOTE}`,
    );
  });
});

describe("bash tool, legacy era (unchanged)", () => {
  for (const era of [undefined, "legacy"] as const) {
    describe(`era=${String(era)}`, () => {
      let client: Client;
      let server: McpServer;

      beforeAll(async () => {
        ({ client, server } = await connect({
          sessionState: new BashSessionState(),
          era,
        }));
      });

      afterAll(async () => {
        await client.close();
        await server.close();
      });

      function callBash(command: string) {
        return client.callTool({
          name: "explore-docs",
          arguments: { command },
        });
      }

      it("cd persists and returns empty output", async () => {
        const cd = await callBash("cd /docs");
        expect(getText(cd)).toBe("$ cd /docs");
        const pwd = await callBash("pwd");
        expect(getText(pwd)).toBe("$ pwd\n/docs\n");
      });

      it("description is byte-identical to the config", async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "explore-docs");
        expect(tool?.description).toBe("Explore docs");
      });
    });
  }
});

describe("bash tool, deadline signal", () => {
  // With a workspace, the modern leg runs the command in a Bash over the
  // /workspace-refusing filesystem wrapper. The signal must reach that Bash
  // too, or the deadline cannot stop a command there.
  for (const withWorkspace of [false, true]) {
    it(`stops a running command when the signal aborts (workspace ${
      withWorkspace ? "on" : "off"
    })`, async () => {
      const deadline = new AbortController();
      const tmpDir = withWorkspace
        ? fs.mkdtempSync(path.join(os.tmpdir(), "bash-deadline-"))
        : undefined;
      const { client, server } = await connect({
        era: "modern",
        signal: deadline.signal,
        ...(tmpDir ? { workspace: new WorkspaceManager(tmpDir, 1024) } : {}),
      });
      try {
        const started = Date.now();
        const call = client.callTool({
          name: "explore-docs",
          arguments: { command: "sleep 100000; echo after-sleep" },
        });
        setTimeout(() => deadline.abort(), 100);
        const result = await call;
        // The 100000 s sleep returned on the abort, and the next statement
        // did not run. The first line echoes the command itself.
        expect(Date.now() - started).toBeLessThan(5000);
        const output = getText(result).split("\n").slice(1);
        expect(output).not.toContain("after-sleep");
        expect(output).toContain("[exit code 124]");
      } finally {
        await client.close();
        await server.close();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }
});
