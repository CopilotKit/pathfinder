/**
 * The modern bash tool runs three exec calls: the bare-`cd` directory check,
 * the `related` file read, and the command itself. All three must receive the
 * request's deadline signal, and the two internal ones must pass their path to
 * the shell as a literal, so `$(...)`, backticks and quotes in it never run.
 *
 * A real just-bash instance and a real McpServer are used. Only the embedding
 * client and searchChunks (no database) are test doubles.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerBashTool, MODERN_CD_HINT } from "../mcp/tools/bash.js";
import type { BashToolOptions } from "../mcp/tools/bash.js";
import type { EmbeddingProvider } from "../indexing/embeddings.js";
import { WorkspaceManager } from "../workspace.js";
import type { BashToolConfig } from "../types.js";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/queries.js")>()),
  searchChunks: vi.fn(async () => []),
}));

const toolConfig: BashToolConfig = {
  name: "explore-docs",
  type: "bash",
  description: "Explore docs",
  sources: ["docs"],
};

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function getText(result: ToolResult): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

for (const withWorkspace of [false, true]) {
  describe(`modern bash exec calls (workspace ${withWorkspace ? "on" : "off"})`, () => {
    let bash: Bash;
    let client: Client;
    let server: McpServer;
    let tmpDir: string | undefined;
    let embed: ReturnType<typeof vi.fn<(text: string) => Promise<number[]>>>;

    async function connect(signal?: AbortSignal): Promise<void> {
      server = new McpServer({ name: "test", version: "1.0.0" });
      bash = new Bash({
        files: {
          "/docs/a.md": "# A\nAlpha.",
          "/docs/guides/b.md": "# B\nBeta.",
          "/tmp/.keep": "",
        },
        cwd: "/",
      });
      embed = vi.fn(async () => [0.1, 0.2, 0.3]);
      const embeddingClient: EmbeddingProvider = {
        embed,
        embedBatch: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
      };
      const options: BashToolOptions = {
        era: "modern",
        embeddingClient,
        ...(signal ? { signal } : {}),
        ...(tmpDir ? { workspace: new WorkspaceManager(tmpDir, 1024) } : {}),
      };
      registerBashTool(server, toolConfig, bash, options);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(clientTransport);
    }

    function callBash(command: string) {
      return client.callTool({ name: "explore-docs", arguments: { command } });
    }

    beforeEach(() => {
      tmpDir = withWorkspace
        ? fs.mkdtempSync(path.join(os.tmpdir(), "bash-exec-signal-"))
        : undefined;
    });

    afterEach(async () => {
      await client.close();
      await server.close();
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe("paths are literal", () => {
      beforeEach(() => connect());

      // Each command runs over a read-only shared filesystem with its own
      // /tmp, so a substitution's write is never visible here. Instead the
      // substitution prints "/": when it runs, the checked path becomes "//",
      // which exists, and cd answers with the hint instead of an error.
      it("bare cd does not run a $(...) in its target", async () => {
        // Positive control: the substitution does produce an existing
        // directory when the shell runs it.
        const control = await callBash("test -d /$(pwd) && echo yes");
        expect(getText(control)).toContain("yes");

        const result = await callBash("cd /$(pwd)");
        expect(getText(result)).not.toContain(MODERN_CD_HINT);
        expect(getText(result)).toContain("No such file or directory");
      });

      it("bare cd does not run a backtick substitution or break out of quotes", async () => {
        for (const target of ["/`pwd`", `/"$(pwd)"`, "/'$(pwd)'"]) {
          const text = getText(await callBash(`cd ${target}`));
          expect(text, target).not.toContain(MODERN_CD_HINT);
          expect(text, target).toContain("No such file or directory");
        }
      });

      it("bare cd accepts a quoted existing directory", async () => {
        for (const target of ["'/docs'", '"/docs"', "/docs", "docs/guides"]) {
          const result = await callBash(`cd ${target}`);
          expect(getText(result), target).toBe(
            `$ cd ${target}\n${MODERN_CD_HINT}`,
          );
        }
      });

      it("related does not run a $(...) in its path", async () => {
        // When the substitution runs, it prints nothing and the path becomes
        // /docs/a.md, which exists and is embedded.
        const result = await callBash("related /docs/a$(echo).md");
        expect(embed).not.toHaveBeenCalledWith("# A\nAlpha.");
        expect(getText(result)).toContain("No such file");
      });

      it("related still reads an existing file (positive control)", async () => {
        await callBash("related /docs/a.md");
        expect(embed).toHaveBeenCalledWith("# A\nAlpha.");
      });
    });

    describe("the deadline signal reaches the internal exec calls", () => {
      // An already-aborted signal: just-bash stops before the first
      // statement and returns exit 124, so a call that received the signal
      // runs nothing.
      beforeEach(() => connect(AbortSignal.abort()));

      it("bare cd: the directory check is aborted, not answered as found", async () => {
        const text = getText(await callBash("cd /docs"));
        expect(text).not.toContain(MODERN_CD_HINT);
        expect(text).toContain("[exit code 124]");
      });

      it("bare cd: an aborted check with a substitution in its target is not answered", async () => {
        const text = getText(await callBash("cd /$(pwd)"));
        expect(text).not.toContain(MODERN_CD_HINT);
        expect(text).toContain("[exit code 124]");
      });

      it("related: the file read is aborted, so nothing is embedded", async () => {
        await callBash("related /docs/a.md");
        expect(embed).not.toHaveBeenCalled();
      });
    });
  });
}
