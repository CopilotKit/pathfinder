import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import {
  buildFeedbackArguments,
  isAtlasCliEntrypoint,
  runAtlasCli,
} from "../atlas-cli.js";
import { runAtlasHarvestCli } from "../atlas/harvest-cli.js";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function jsonResponse(
  body: unknown,
  init?: ResponseInit & { sessionId?: string },
): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (init?.sessionId) {
    headers.set("mcp-session-id", init.sessionId);
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function sseResponse(
  body: string,
  init?: ResponseInit & { sessionId?: string },
): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "text/event-stream");
  if (init?.sessionId) {
    headers.set("mcp-session-id", init.sessionId);
  }
  return new Response(body, { ...init, headers });
}

describe("atlas CLI", () => {
  const originalEnv = { ...process.env };
  let stdout = "";
  let stderr = "";

  beforeEach(() => {
    // Run against a known-clean env so the default-URL/token assertions do not
    // go red on a machine/CI that exports ATLAS_MCP_URL / ATLAS_TOKEN. Tests
    // that exercise the env fallback set these explicitly.
    delete process.env.ATLAS_MCP_URL;
    delete process.env.ATLAS_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    stdout = "";
    stderr = "";
  });

  it("exposes a first-party atlas bin", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
    ) as { bin?: Record<string, string> };

    expect(packageJson.bin?.atlas).toBe("dist/atlas-cli.js");
  });

  it("uses env fallbacks and calls the configured MCP search tool", async () => {
    process.env.ATLAS_MCP_URL = "https://atlas.example.test/mcp";
    process.env.ATLAS_TOKEN = "secret-token";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: "Atlas says: use the provider boundary." },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Atlas says: use the provider boundary.");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [initUrl, initRequest] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(initUrl).toBe("https://atlas.example.test/mcp");
    expect(initRequest.headers).toMatchObject({
      Authorization: "Bearer secret-token",
      Accept: "application/json, text/event-stream",
    });
    expect(JSON.parse(initRequest.body as string)).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      id: 0,
    });

    const [, notifyRequest] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(notifyRequest.headers).toMatchObject({
      "Mcp-Session-Id": "session-1",
    });
    expect(JSON.parse(notifyRequest.body as string)).toMatchObject({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const [, callRequest] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(callRequest.headers).toMatchObject({
      "Mcp-Session-Id": "session-1",
    });
    expect(JSON.parse(callRequest.body as string)).toEqual({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 1,
      params: {
        name: "atlas-search",
        arguments: {
          query: "provider boundary",
        },
      },
    });
  });

  it("terminates the MCP session after a successful search", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "result before close" }],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(
      ["search", "provider boundary", "--token", "secret-token"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("result before close");
    expect(stderr).toBe("");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [closeUrl, closeRequest] = fetchMock.mock.calls[3] as [
      string,
      RequestInit,
    ];
    expect(closeUrl).toBe("https://mcp.pathfinder.copilotkit.dev/mcp");
    expect(closeRequest.method).toBe("DELETE");
    expect(closeRequest.headers).toMatchObject({
      "Mcp-Session-Id": "session-1",
      Authorization: "Bearer secret-token",
    });
    expect(closeRequest.body).toBeUndefined();
  });

  it("terminates the MCP session after a tool call error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { message: "tool failed" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("tool failed");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, closeRequest] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(closeRequest.method).toBe("DELETE");
    expect(closeRequest.headers).toMatchObject({
      "Mcp-Session-Id": "session-1",
    });
  });

  it("fails immediately when MCP initialize returns a JSON-RPC error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            error: { message: "initialize rejected" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("initialize rejected");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, closeRequest] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(closeRequest.method).toBe("DELETE");
  });

  it("terminates the MCP session when initialize returns invalid JSON with a session header", async () => {
    const headers = new Headers({
      "content-type": "application/json",
      "mcp-session-id": "session-1",
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not json", { headers }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unparseable response");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, closeRequest] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(closeRequest.method).toBe("DELETE");
    expect(closeRequest.headers).toMatchObject({
      "Mcp-Session-Id": "session-1",
    });
  });

  it("terminates the MCP session when initialize returns an HTTP error with a session header", async () => {
    const headers = new Headers({
      "mcp-session-id": "session-1",
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("initialize failed", { status: 500, headers }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("HTTP 500: initialize failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, closeRequest] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(closeRequest.method).toBe("DELETE");
    expect(closeRequest.headers).toMatchObject({
      "Mcp-Session-Id": "session-1",
    });
  });

  it("handles a tools/call result of null without reporting No response.", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: null,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toContain("No response.");
    expect(stdout).not.toContain("no response from server");
    expect(stdout).toContain("No results.");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("treats a tool result with isError as a failure on stderr with exit 1", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: true,
            content: [{ type: "text", text: "boom" }],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("boom");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [, closeRequest] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(closeRequest.method).toBe("DELETE");
  });

  it("renders gracefully when a tools/call result carries non-array content", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { content: "oops" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stderr).not.toContain("content.map is not a function");
    expect(stdout).toContain("No results.");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("selects the tools/call response by id across a multi-frame SSE stream", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        sseResponse(
          [
            'data:{"jsonrpc":"2.0","method":"notifications/message","params":{"data":"unrelated"}}',
            "",
            'data:{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"the real answer"}]}}',
            "",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("the real answer");
    expect(stdout).not.toContain("No response.");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("selects the tools/call response when the server echoes a string id", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: "1",
          result: {
            content: [{ type: "text", text: "string id answer" }],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("string id answer");
    expect(stdout).not.toContain("No response.");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("surfaces a JSON-RPC error frame carrying a null id instead of the generic no-response error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: null,
          error: { message: "rate limited, retry later" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("rate limited, retry later");
    expect(stderr).not.toContain("no response from server");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [, closeRequest] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(closeRequest.method).toBe("DELETE");
  });

  it("fails with exit 1 when no tools/call response frame carries id 1", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        sseResponse(
          [
            'data:{"jsonrpc":"2.0","method":"notifications/message","params":{"data":"only a notification, never answered id 1"}}',
            "",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("no response from server for tools/call");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [, closeRequest] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(closeRequest.method).toBe("DELETE");
  });

  it("renders a sole tools/call result frame whose id was omitted", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          result: {
            content: [{ type: "text", text: "answer with no id" }],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("answer with no id");
    expect(stdout).not.toContain("no response from server");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fails with no-response when the only frame bears a different explicit id", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [{ type: "text", text: "answer for a different request" }],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stdout).not.toContain("answer for a different request");
    expect(stderr).toContain("no response from server for tools/call");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [, closeRequest] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(closeRequest.method).toBe("DELETE");
  });

  it("requires --for when building feedback arguments", () => {
    expect(() =>
      buildFeedbackArguments("provider boundary", {
        for: undefined,
        rating: "helpful",
        comment: "Exactly what I needed.",
      }),
    ).toThrow("atlas: --for is required");
  });

  it("honors CLI options and prints raw JSON when requested", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { jsonrpc: "2.0", id: 0, result: {} },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "json result" }],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(
      [
        "search",
        "ratification queue",
        "--url",
        "http://localhost:3001/mcp",
        "--tool",
        "atlas_search",
        "--limit",
        "4",
        "--min-score",
        "0.62",
        "--json",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "json result" }],
      },
    });

    const [, callRequest] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(callRequest.body as string)).toEqual({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 1,
      params: {
        name: "atlas_search",
        arguments: {
          query: "ratification queue",
          limit: 4,
          min_score: 0.62,
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, closeRequest] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(closeRequest.method).toBe("DELETE");
  });

  it.each([
    ["--limit", "not-a-number", "limit must be a positive integer"],
    ["--limit", "10abc", "limit must be a positive integer"],
    ["--limit", "-1", "limit must be a positive integer"],
    ["--limit", "0", "limit must be a positive integer"],
    ["--limit", "NaN", "limit must be a positive integer"],
    [
      "--min-score",
      "not-a-score",
      "min-score must be a finite number in [0, 1]",
    ],
    ["--min-score", "0.5abc", "min-score must be a finite number in [0, 1]"],
    ["--min-score", "2", "min-score must be a finite number in [0, 1]"],
    ["--min-score", "-0.1", "min-score must be a finite number in [0, 1]"],
    ["--min-score", "NaN", "min-score must be a finite number in [0, 1]"],
  ])(
    "rejects invalid %s value %s before calling MCP",
    async (option, value, expectedMessage) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);

      const exitCode = await runAtlasCli(
        ["search", "provider boundary", option, value],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(expectedMessage);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("parses SSE events without a space after data and with multiline data", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse('data:{"jsonrpc":"2.0","id":0,"result":{}}\n\n', {
          sessionId: "session-1",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        sseResponse(
          [
            'data:{"jsonrpc":"2.0","id":1,"result":{"content":[',
            'data:{"type":"text","text":"multiline SSE result"}',
            "data:]}}",
            "",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("multiline SSE result");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("skips empty SSE data frames without crashing", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse('data:{"jsonrpc":"2.0","id":0,"result":{}}\n\n', {
          sessionId: "session-1",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        sseResponse(
          [
            ": keepalive comment",
            "data:",
            "",
            'data:{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"survived the keepalive"}]}}',
            "",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("survived the keepalive");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("defaults to the Atlas search tool configured in pathfinder.example.yaml", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "default tool result" }],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["search", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const [, callRequest] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(callRequest.body as string)).toMatchObject({
      method: "tools/call",
      params: {
        name: "atlas-search",
      },
    });
  });

  it("returns an existing-style error for missing search query", async () => {
    const exitCode = await runAtlasCli(["search"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("error: missing required argument 'query'");
  });

  it("submits feedback through the configured MCP feedback tool", async () => {
    process.env.ATLAS_MCP_URL = "https://atlas.example.test/mcp";
    process.env.ATLAS_TOKEN = "secret-token";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "Feedback recorded. Thank you." }],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(
      [
        "feedback",
        "provider boundary",
        "--rating",
        "helpful",
        "--comment",
        "Exactly what I needed.",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Feedback recorded. Thank you.");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [, callRequest] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(callRequest.body as string)).toEqual({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 1,
      params: {
        name: "submit-feedback",
        arguments: {
          tool_name: "atlas-search",
          query: "provider boundary",
          rating: "helpful",
          comment: "Exactly what I needed.",
        },
      },
    });
  });

  it("maps --for to tool_name and honors --tool for the feedback tool name", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "Feedback recorded. Thank you." }],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(
      [
        "feedback",
        "ratification queue",
        "--rating",
        "not_helpful",
        "--comment",
        "Wrong section.",
        "--for",
        "atlas-deep-search",
        "--tool",
        "collect-feedback",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const [, callRequest] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(callRequest.body as string)).toEqual({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 1,
      params: {
        name: "collect-feedback",
        arguments: {
          tool_name: "atlas-deep-search",
          query: "ratification queue",
          rating: "not_helpful",
          comment: "Wrong section.",
        },
      },
    });
  });

  it.each([["sometimes"], ["yes"], ["HELPFUL"], [""]])(
    "rejects invalid feedback rating %s before calling MCP",
    async (rating) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);

      const exitCode = await runAtlasCli(
        [
          "feedback",
          "provider boundary",
          "--rating",
          rating,
          "--comment",
          "Some comment.",
        ],
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("rating must be one of: helpful, not_helpful");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an empty feedback comment before calling MCP", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(
      [
        "feedback",
        "provider boundary",
        "--rating",
        "helpful",
        "--comment",
        "   ",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("comment must not be empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a feedback tool-call error as exit 1", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 0,
            result: { protocolVersion: "2025-03-26" },
          },
          { sessionId: "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { message: "feedback rejected" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(
      [
        "feedback",
        "provider boundary",
        "--rating",
        "helpful",
        "--comment",
        "Helpful answer.",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("feedback rejected");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [, closeRequest] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(closeRequest.method).toBe("DELETE");
  });

  it("requires the rating and comment options for feedback", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const exitCode = await runAtlasCli(["feedback", "provider boundary"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("required option");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ships a prepublishOnly build guard", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.prepublishOnly).toBe("npm run build");
  });

  it("recognizes URL-escaped CLI entrypoint paths", () => {
    const entrypointPath = path.join(PROJECT_ROOT, "dist", "atlas cli.js");
    const nonNormalizedArgvPath = path.join(
      PROJECT_ROOT,
      "dist",
      "..",
      "dist",
      "atlas cli.js",
    );

    expect(
      isAtlasCliEntrypoint(
        pathToFileURL(entrypointPath).href,
        nonNormalizedArgvPath,
      ),
    ).toBe(true);
  });

  it("recognizes symlinked CLI entrypoint paths", () => {
    const tempDir = fs.mkdtempSync(path.join(PROJECT_ROOT, ".atlas-cli-"));

    try {
      const realEntrypointPath = path.join(tempDir, "dist", "atlas-cli.js");
      const symlinkPath = path.join(tempDir, "node_modules", ".bin", "atlas");
      fs.mkdirSync(path.dirname(realEntrypointPath), { recursive: true });
      fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
      fs.writeFileSync(realEntrypointPath, "", "utf-8");
      fs.symlinkSync(realEntrypointPath, symlinkPath);

      expect(
        isAtlasCliEntrypoint(
          pathToFileURL(realEntrypointPath).href,
          symlinkPath,
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("atlas CLI — harvest verb (driver mount)", () => {
  // The harvest driver (src/atlas/harvest-cli.ts) mounts as the `atlas harvest`
  // subcommand: the remaining argv is forwarded verbatim to
  // `runAtlasHarvestCli`, so `atlas harvest run --run-id ...` behaves exactly
  // like the old standalone driver invocation (exit codes, stderr via
  // formatCliError). These tests reach the harvest machinery through a cheap
  // observable — its own commander/validation error text surfacing through the
  // atlas binary — with no DB or network.
  let stdout = "";
  let stderr = "";
  const io = {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  };

  afterEach(() => {
    stdout = "";
    stderr = "";
  });

  it("lists the harvest verb in the top-level help", async () => {
    const exitCode = await runAtlasCli(["--help"], io);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("harvest");
  });

  it("forwards argv to the harvest driver — its missing --run-id error surfaces through atlas", async () => {
    const exitCode = await runAtlasCli(["harvest", "run"], io);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--run-id");
  });

  it("forwards option values intact — a parsed --run-id reaches the run command's own validation", async () => {
    const exitCode = await runAtlasCli(
      ["harvest", "run", "--run-id", "run-x"],
      io,
    );

    // --run-id parsed by the harvest driver (its commander requiredOption is
    // satisfied), so the failure is the NEXT gate: runCommand's own --checkout
    // requirement, proving the forwarded argv ordering survived the mount.
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("--run-id <id>");
    expect(stderr).toContain("--checkout");
  });

  describe("mount fidelity — mounted tail matches the standalone driver byte-for-byte", () => {
    // Parity harness: the SAME argv tail is fed to the mounted form
    // (`atlas harvest <tail>`) and to the standalone driver
    // (`runAtlasHarvestCli(<tail>)`); exit code, stdout, and stderr must all
    // be identical. This pins the mount contract: nothing in atlas-cli may
    // consume or reorder ANY token of the tail — including a LEADING `--`,
    // which a commander variadic `[args...]` would otherwise eat.
    async function runBoth(tail: string[]) {
      let mountedOut = "";
      let mountedErr = "";
      const mountedExit = await runAtlasCli(["harvest", ...tail], {
        stdout: (text: string) => {
          mountedOut += text;
        },
        stderr: (text: string) => {
          mountedErr += text;
        },
      });

      let standaloneOut = "";
      let standaloneErr = "";
      const standaloneExit = await runAtlasHarvestCli(tail, {
        stdout: (text: string) => {
          standaloneOut += text;
        },
        stderr: (text: string) => {
          standaloneErr += text;
        },
      });

      expect(mountedExit).toBe(standaloneExit);
      expect(mountedOut).toBe(standaloneOut);
      expect(mountedErr).toBe(standaloneErr);
      return {
        exitCode: standaloneExit,
        stdout: standaloneOut,
        stderr: standaloneErr,
      };
    }

    it("preserves a LEADING `--` — `harvest -- --help` is an unknown command, not help", async () => {
      const { exitCode, stderr } = await runBoth(["--", "--help"]);

      // Standalone, post-`--` tokens are operands: `--help` is an unknown
      // command (exit 1), NOT a help request.
      expect(exitCode).toBe(1);
      expect(stderr).toContain("unknown command");
    });

    it("preserves a LEADING `--` — `harvest -- run --run-id x` does NOT execute the run", async () => {
      const { exitCode, stderr } = await runBoth([
        "--",
        "run",
        "--run-id",
        "x",
      ]);

      // Standalone, `--run-id x` after `--` are inert operands, so the run
      // subcommand's requiredOption fails — the pipeline must NOT execute
      // (no `--checkout` gate is ever reached).
      expect(exitCode).toBe(1);
      expect(stderr).toContain("--run-id <id>");
      expect(stderr).not.toContain("--checkout");
    });

    it("preserves a post-verb `--` — `harvest run -- --run-id x` keeps the operands inert", async () => {
      const { exitCode, stderr } = await runBoth([
        "run",
        "--",
        "--run-id",
        "x",
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("--run-id <id>");
    });

    it("forwards a value-bearing pre-verb flag — `harvest --runs-dir /x run …` matches standalone", async () => {
      const { exitCode, stderr } = await runBoth([
        "--runs-dir",
        "/x",
        "run",
        "--run-id",
        "y",
      ]);

      // The driver's program level declares no --runs-dir option, so both
      // forms reject it identically.
      expect(exitCode).toBe(1);
      expect(stderr).toContain("--runs-dir");
    });

    it("shows the driver's own help — `harvest --help` exits 0 with the atlas-harvest usage", async () => {
      const { exitCode, stdout } = await runBoth(["--help"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: atlas-harvest");
    });
  });
});
