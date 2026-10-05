import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response } from "express";
import {
  CLIENT_INFO_META_KEY,
  MissingRequiredClientCapabilityError,
  PROTOCOL_VERSION_META_KEY,
  UnsupportedProtocolVersionError,
  classifyInboundRequest,
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  type McpServer,
} from "@modelcontextprotocol/server";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import {
  cleanClientString,
  requestContext,
  safeLogToken,
  type PathfinderRequestContext,
} from "./request-context.js";
import { REQUEST_CONTEXT_FIELD_MAX_LEN } from "./db/analytics.js";
import type { AuthContext } from "./oauth/handlers.js";

/**
 * Per-request context for a 2026-07-28 (stateless) request. protocolVersion
 * and clientName come from the request's `params._meta`, cleaned with
 * {@link cleanClientString}; null when absent.
 */
export type ModernServerContext = PathfinderRequestContext & {
  protocolVersion: string | null;
  clientName: string | null;
  /**
   * Report tool work started for this request. handle() does not return
   * until every reported promise settles, so a caller that holds a resource
   * for the life of handle() (the in-flight ceiling) holds it until the tool
   * finishes, also when the client aborted and the response closed first.
   */
  trackWork: (work: Promise<unknown>) => void;
  /**
   * Aborts when the request passes its deadline (see `requestTimeoutMs` on
   * {@link createModernMcpRoute}). Tools that can stop early (bash exec)
   * listen to it, so their work ends soon after handle() lets go of it.
   */
  signal: AbortSignal;
};

export interface ModernMcpRoute {
  /** True when the request is a 2026-07-28 request (not a legacy one). */
  isModern(req: Request): Promise<boolean>;
  /** Serve one modern request with a per-request server. */
  handle(req: Request & { auth?: AuthContext }, res: Response): Promise<void>;
}

/** The `params._meta` record of a JSON-RPC body, or undefined. */
function metaOf(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const params: unknown = Reflect.get(body, "params");
  if (typeof params !== "object" || params === null) return undefined;
  const meta: unknown = Reflect.get(params, "_meta");
  if (typeof meta !== "object" || meta === null) return undefined;
  return Object.fromEntries(Object.entries(meta));
}

/** The JSON-RPC method of a body, for the log line; "unknown" otherwise. */
function methodOf(body: unknown): string {
  if (typeof body !== "object" || body === null) return "unknown";
  const method: unknown = Reflect.get(body, "method");
  return typeof method === "string" && method !== "" ? method : "unknown";
}

/** The tool name of a tools/call body, for the deadline log line; "none" otherwise. */
function toolNameOf(body: unknown): string {
  if (typeof body !== "object" || body === null) return "none";
  const params: unknown = Reflect.get(body, "params");
  if (typeof params !== "object" || params === null) return "none";
  const name: unknown = Reflect.get(params, "name");
  return typeof name === "string" && name !== "" ? name : "none";
}

/** The first protocol revision the SDK serves on its modern path. */
const FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * True when the SDK sends `body` to the modern leg only to reject it as not
 * one JSON-RPC message ({}, [], a scalar, an empty body that express.json
 * turned into {}), and nothing in the request claims the 2026-07-28
 * revision. The legacy leg answers such a body with the switch off, so it
 * must answer it with the switch on too. A batch with a modern element, or a
 * modern MCP-Protocol-Version header, is a modern claim and stays modern.
 */
function isUnclaimedShapeRejection(req: Request, body: unknown): boolean {
  const outcome = classifyInboundRequest({ httpMethod: "POST", body });
  if (outcome.kind !== "reject" || outcome.rung !== "jsonrpc-shape") {
    return false;
  }
  if (outcome.cell === "batch-with-modern-element") return false;
  // Same test as the SDK's isModernProtocolVersion (date strings compare).
  const header = req.headers["mcp-protocol-version"];
  return (
    typeof header !== "string" || header.trim() < FIRST_MODERN_PROTOCOL_VERSION
  );
}

/** SDK error messages for a request the client got wrong (answered 4xx). */
const CLIENT_REJECTION_PREFIXES = [
  "Rejected inbound request",
  "Rejected 2025-era request",
  "Unsupported Media Type",
];

/**
 * Log one error that the SDK caught on the modern leg. The SDK answers the
 * request itself (500 or a 4xx) and reports the error only through
 * `onerror`, so without this the failure leaves no log line. A client
 * rejection (header mismatch, wrong Content-Type, unsupported version,
 * missing client capability) logs one warn line. Anything else is a server
 * failure and logs at error with the stack.
 */
export function logModernMcpError(e: Error): void {
  if (
    e instanceof UnsupportedProtocolVersionError ||
    e instanceof MissingRequiredClientCapabilityError ||
    CLIENT_REJECTION_PREFIXES.some((p) => e.message.startsWith(p))
  ) {
    console.warn(`[mcp] modern request rejected: ${safeLogToken(e.message)}`);
    return;
  }
  console.error("[mcp] modern handler error:", e.stack ?? e.message);
}

export function createModernMcpRoute(deps: {
  buildServer: (ctx: ModernServerContext) => McpServer;
  /**
   * Receives every failure the SDK catches: factory throws, serving throws,
   * ladder rejections, and adapter-level failures. Required: the SDK logs
   * none of them itself. Production passes {@link logModernMcpError}.
   */
  onerror: (e: Error) => void;
  /**
   * Wall-clock deadline for one request, in ms. When it passes, handle()
   * aborts the request's `signal`, logs one warn line and returns, even if
   * a tool call has not settled. Without it, a tool that never settles
   * would keep handle() (and the in-flight ceiling slot held around it)
   * busy until restart. A subscriptions/listen stream is not subject to
   * it: the stream stays open by design and holds no slot.
   */
  requestTimeoutMs: number;
}): ModernMcpRoute {
  const als = new AsyncLocalStorage<ModernServerContext>();

  const modernHandler = createMcpHandler(
    () => {
      const ctx = als.getStore();
      if (ctx === undefined) {
        throw new Error(
          "modern MCP factory ran outside handle(): no request context in AsyncLocalStorage",
        );
      }
      return deps.buildServer(ctx);
    },
    {
      legacy: "reject",
      responseMode: "auto",
      onerror: deps.onerror,
    },
  );

  // The spread order is load-bearing. toNodeHandler passes Pathfinder's raw
  // req.auth ({sub, client_id}) as `o.authInfo`; spreading `o` first lets the
  // SDK-shaped sdkAuthInfo from the ALS win, so the factory and every tool
  // see {token, clientId, scopes, extra}. The reverse order hands them the
  // raw req.auth.
  // The second argument reports adapter-level failures (request conversion,
  // or a throw out of fetch) before toNodeHandler writes its own 500.
  const nodeModern = toNodeHandler(
    {
      fetch: (r, o) =>
        modernHandler.fetch(r, { ...o, authInfo: als.getStore()?.sdkAuthInfo }),
    },
    { onerror: deps.onerror },
  );

  return {
    async isModern(req: Request): Promise<boolean> {
      // Upcast with no cast: the SDK's node request type types `auth` as
      // AuthInfo, which Pathfinder's AuthContext is not.
      const plain: Request = req;
      if (req.body !== undefined) {
        // Both awaits are required: toWebRequest returns a Promise, and a
        // missing outer await compiles and always yields "legacy".
        if (
          await isLegacyRequest(await toWebRequest(plain, req.body), req.body)
        ) {
          return false;
        }
        return !isUnclaimedShapeRejection(req, req.body);
      }
      // express.json did not parse the body (a non-JSON or missing
      // Content-Type, or a JSON one it does not accept, such as
      // "application/json; charset"). toWebRequest reads the Node stream to
      // the end, so neither leg can read it again: read the text from the
      // probe once, as the SDK's toWebRequest docstring says. When the SDK
      // treats the Content-Type as JSON, both legs would read and parse that
      // body themselves, so hand them the parsed value as req.body.
      const probe = await toWebRequest(plain);
      const text = await probe.text();
      let parsed: unknown;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // Not JSON: the SDK classifies it as legacy (no JSON body).
        }
      }
      if (parsed === undefined) return false;
      if (isJsonContentType(req.headers["content-type"])) req.body = parsed;
      if (await isLegacyRequest(probe, parsed)) return false;
      return !isUnclaimedShapeRejection(req, parsed);
    },

    async handle(
      req: Request & { auth?: AuthContext },
      res: Response,
    ): Promise<void> {
      const plain: Request = req;
      // The factory gets no client identity from the SDK (it is seeded only
      // after the factory returns), so read it from the envelope here.
      const meta = metaOf(req.body);
      const clientInfo: unknown = meta?.[CLIENT_INFO_META_KEY];
      const pending = new Set<Promise<unknown>>();
      const deadline = new AbortController();
      const ctx: ModernServerContext = {
        ...requestContext(req),
        trackWork: (work) => {
          // Settled work leaves the set; a rejection is the tool's to report.
          const settled = work.then(
            () => undefined,
            () => undefined,
          );
          pending.add(settled);
          void settled.then(() => pending.delete(settled));
        },
        signal: deadline.signal,
        protocolVersion: cleanClientString(
          meta?.[PROTOCOL_VERSION_META_KEY],
          REQUEST_CONTEXT_FIELD_MAX_LEN,
        ),
        clientName: cleanClientString(
          typeof clientInfo === "object" && clientInfo !== null
            ? Reflect.get(clientInfo, "name")
            : undefined,
          REQUEST_CONTEXT_FIELD_MAX_LEN,
        ),
      };
      console.log(
        `[mcp] modern ${safeLogToken(methodOf(req.body))} protocol=${
          ctx.protocolVersion ? safeLogToken(ctx.protocolVersion) : "none"
        } client=${
          ctx.clientName ? safeLogToken(ctx.clientName) : "none"
        } [${safeLogToken(String(ctx.ip))}]`,
      );
      const started = Date.now();
      const work = (async () => {
        try {
          await als.run(ctx, () => nodeModern(plain, res, req.body));
        } finally {
          // On a client abort the SDK answers and returns while the tool
          // still runs. Wait for that work, so handle() returns only once it
          // is done (or the deadline below passes).
          while (pending.size > 0) await Promise.all(pending);
        }
      })();
      // A subscriptions/listen stream stays open by design, holds no
      // in-flight slot and runs no tool, so the deadline does not apply.
      if (methodOf(req.body) === "subscriptions/listen") {
        await work;
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), deps.requestTimeoutMs);
      });
      try {
        if ((await Promise.race([work, expired])) !== "expired") return;
      } finally {
        clearTimeout(timer);
      }
      // Deadline passed: stop what can stop, and let go of the rest. A late
      // failure of the abandoned work still reaches onerror.
      deadline.abort();
      work.catch((e: unknown) =>
        deps.onerror(e instanceof Error ? e : new Error(String(e))),
      );
      console.warn(
        `[mcp] modern ${safeLogToken(methodOf(req.body))} tool=${safeLogToken(
          toolNameOf(req.body),
        )} exceeded the ${deps.requestTimeoutMs}ms deadline after ${
          Date.now() - started
        }ms, releasing its slot [${safeLogToken(String(ctx.ip))}]`,
      );
    },
  };
}
