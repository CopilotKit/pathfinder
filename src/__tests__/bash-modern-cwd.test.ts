import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { Bash } from "just-bash";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  registerBashTool,
  DEADLINE_ERROR,
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
  bash: Bash = new Bash({ files, cwd: "/" }),
): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
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

/**
 * Aborts `deadline` once a `sleep` in the call is waiting on it. A sleep
 * waits for the signal with a `{ once: true }` abort listener, so the first
 * such listener means the sleep has started.
 */
function abortWhenSleepStarts(deadline: AbortController): void {
  const signal = deadline.signal;
  const add = signal.addEventListener.bind(signal);
  let armed = true;
  vi.spyOn(signal, "addEventListener").mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      add(type, listener, options);
      if (
        armed &&
        type === "abort" &&
        typeof options === "object" &&
        options.once === true
      ) {
        armed = false;
        setTimeout(() => deadline.abort(), 0);
      }
    },
  );
}

/**
 * Aborts `deadline` while a command is reading `file` from `bash`'s
 * filesystem: the read starts, the deadline fires, then the read finishes.
 * Only the first read of `file` aborts.
 */
function abortDuringRead(
  bash: Bash,
  deadline: AbortController,
  file: string,
): void {
  let armed = true;
  const hit = (p: string) => {
    if (armed && p === file) {
      armed = false;
      deadline.abort();
    }
  };
  const fsys = bash.fs;
  const readFile = fsys.readFile.bind(fsys);
  vi.spyOn(fsys, "readFile").mockImplementation((p, options) => {
    const pending = readFile(p, options);
    hit(p);
    return pending;
  });
  const readFileBuffer = fsys.readFileBuffer.bind(fsys);
  vi.spyOn(fsys, "readFileBuffer").mockImplementation((p) => {
    const pending = readFileBuffer(p);
    hit(p);
    return pending;
  });
}

describe("bash tool, deadline signal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // With a workspace, the modern leg runs the command in a Bash over the
  // /workspace-refusing filesystem wrapper. The signal must reach that Bash
  // too, or the deadline cannot stop a command there.
  for (const withWorkspace of [false, true]) {
    const label = `workspace ${withWorkspace ? "on" : "off"}`;

    async function connectModern(signal: AbortSignal, bash?: Bash) {
      const tmpDir = withWorkspace
        ? fs.mkdtempSync(path.join(os.tmpdir(), "bash-deadline-"))
        : undefined;
      const { client, server } = await connect(
        {
          era: "modern",
          signal,
          ...(tmpDir ? { workspace: new WorkspaceManager(tmpDir, 1024) } : {}),
        },
        bash,
      );
      return {
        run: async (command: string) =>
          getText(
            await client.callTool({
              name: "explore-docs",
              arguments: { command },
            }),
          ),
        close: async () => {
          await client.close();
          await server.close();
          if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        },
      };
    }

    it(`stops a running command and reports the deadline (${label})`, async () => {
      const deadline = new AbortController();
      const { run, close } = await connectModern(deadline.signal);
      try {
        abortWhenSleepStarts(deadline);
        const started = Date.now();
        const text = await run("sleep 100000; echo after-sleep");
        // The 100000 s sleep returned on the abort, and the next statement
        // did not run.
        expect(Date.now() - started).toBeLessThan(5000);
        expect(text).toBe(
          `$ sleep 100000; echo after-sleep\n${DEADLINE_ERROR}\n\n[exit code 124]`,
        );
      } finally {
        await close();
      }
    });

    // Known limit: just-bash checks the signal only at the start of a
    // statement, and an aborted sleep exits 0, so the rest of an `&&` or
    // `||` list still runs after the deadline. The call still reports the
    // deadline (exit 124), not the list's own status.
    it(`reports the deadline when an and-or list runs on after the abort (${label})`, async () => {
      const deadline = new AbortController();
      const { run, close } = await connectModern(deadline.signal);
      try {
        abortWhenSleepStarts(deadline);
        expect(await run("sleep 100000 && echo after-sleep")).toBe(
          `$ sleep 100000 && echo after-sleep\nafter-sleep\n\n${DEADLINE_ERROR}\n\n[exit code 124]`,
        );
      } finally {
        await close();
      }
    });

    it(`reports the deadline when it fires during a later command of an and-or list (${label})`, async () => {
      const deadline = new AbortController();
      const bash = new Bash({ files, cwd: "/" });
      const { run, close } = await connectModern(deadline.signal, bash);
      try {
        // The deadline fires while `cat` (the second command) reads. The
        // list runs on and exits 0; the call still reports the deadline.
        abortDuringRead(bash, deadline, "/docs/quickstart.mdx");
        const command = "echo first && cat /docs/quickstart.mdx && echo third";
        expect(await run(command)).toBe(
          `$ ${command}\nfirst\n# Quickstart\nGet started.third\n\n${DEADLINE_ERROR}\n\n[exit code 124]`,
        );
      } finally {
        await close();
      }
    });

    it(`reports the deadline when it fires during a grep loop (${label})`, async () => {
      const deadline = new AbortController();
      const bash = new Bash({ files, cwd: "/" });
      const { run, close } = await connectModern(deadline.signal, bash);
      try {
        abortDuringRead(bash, deadline, "/docs/guides/streaming.mdx");
        const command =
          "for i in 1 2 3; do grep -c Stream /docs/guides/streaming.mdx; done; echo after-loop";
        // just-bash stops at the next statement start; the echo never runs.
        expect(await run(command)).toBe(
          `$ ${command}\n${DEADLINE_ERROR}\n\n[exit code 124]`,
        );
      } finally {
        await close();
      }
    });

    it(`reports the deadline when the signal fired before the call (${label})`, async () => {
      const deadline = new AbortController();
      deadline.abort();
      const { run, close } = await connectModern(deadline.signal);
      try {
        expect(await run("echo hi")).toBe(
          `$ echo hi\n${DEADLINE_ERROR}\n\n[exit code 124]`,
        );
      } finally {
        await close();
      }
    });

    it(`keeps a command's own exit 124 when the deadline did not fire (${label})`, async () => {
      const { run, close } = await connectModern(new AbortController().signal);
      try {
        expect(await run("echo out; exit 124")).toBe(
          "$ echo out; exit 124\nout\n\n[exit code 124]",
        );
        expect(await run("timeout 0.01 sleep 5")).toBe(
          "$ timeout 0.01 sleep 5\n[exit code 124]",
        );
      } finally {
        await close();
      }
    });

    // Accepted race: the result depends only on whether the deadline had
    // fired when exec() returned, so a command that finishes just as the
    // deadline fires is reported as a deadline. Its output is kept.
    it(`reports the deadline when it fires as the command finishes (${label})`, async () => {
      const deadline = new AbortController();
      const { run, close } = await connectModern(deadline.signal);
      try {
        // The deadline fires after just-bash has finished the command, before
        // the tool reads the result.
        const realExec = Bash.prototype.exec;
        vi.spyOn(Bash.prototype, "exec").mockImplementation(async function (
          this: Bash,
          ...args: Parameters<Bash["exec"]>
        ) {
          const result = await realExec.apply(this, args);
          deadline.abort();
          return result;
        });
        expect(await run("echo done; false")).toBe(
          `$ echo done; false\ndone\n\n${DEADLINE_ERROR}\n\n[exit code 124]`,
        );
      } finally {
        await close();
      }
    });

    it(`runs the command text unchanged without an abort (${label})`, async () => {
      const { run, close } = await connectModern(new AbortController().signal);
      try {
        expect(await run("true && echo a || echo b")).toBe(
          "$ true && echo a || echo b\na\n",
        );
        expect(await run("false && echo a || ! echo b")).toBe(
          "$ false && echo a || ! echo b\nb\n\n[exit code 1]",
        );
        expect(await run("echo x | cat && echo $?")).toBe(
          "$ echo x | cat && echo $?\nx\n0\n",
        );
      } finally {
        await close();
      }
    });

    it(`keeps set -e semantics inside an and-or list (${label})`, async () => {
      const { run, close } = await connectModern(new AbortController().signal);
      try {
        // set -e ignores a failure that is not the last in an and-or list.
        expect(await run("set -e; true && false && echo x; echo after")).toBe(
          "$ set -e; true && false && echo x; echo after\nafter\n",
        );
      } finally {
        await close();
      }
    });

    it(`runs a long and-or loop within the command limit (${label})`, async () => {
      const { run, close } = await connectModern(new AbortController().signal);
      try {
        // 6000 passes of a two-command list stay under just-bash's
        // 10000-statement limit.
        expect(
          await run("for i in $(seq 1 6000); do true && true; done; echo done"),
        ).toBe(
          "$ for i in $(seq 1 6000); do true && true; done; echo done\ndone\n",
        );
      } finally {
        await close();
      }
    });
  }
});
