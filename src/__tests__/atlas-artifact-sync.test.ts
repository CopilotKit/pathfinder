// S17 — approval-artifact sync / enactment.
//
// `syncApprovalArtifact` reads the EDITED Notion approval page back, parses the
// lead's checkbox toggles + the (possibly hand-edited) exclusion-rule bullets,
// runs those rules through the shared exclusion engine (S13 `applyExclusions`),
// and enacts the result against the live ratification endpoints via the Atlas
// HTTP client (S15): a candidate the lead CHECKED and that NO rule excludes is
// approved; everything else (unchecked, or checked-but-excluded) is rejected.
// The run's final rule-set is persisted back into the run manifest (S2) so the
// NEXT run seeds its Exclusion-Rules section from it (§11.5).
//
// Mocking policy (org rule): Notion (`@notionhq/client`) and the Atlas HTTP
// endpoints are NON-LLM externals, so the Notion client + the AtlasHttpClient
// are mocked with vi.fn. The ONE LLM touchpoint — the english-rule judgment
// that `applyExclusions` routes through `llm.evaluateEnglishExclusionRule` — is
// exercised through a real `OpenAIDistiller` pointed at an in-process aimock
// server (mirrors atlas-llm.test.ts), never a vi.fn stub.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock, type Fixture } from "@copilotkit/aimock";
import type {
  Client,
  BlockObjectResponse,
  ListBlockChildrenResponse,
  PartialBlockObjectResponse,
  ToDoBlockObjectResponse,
  BulletedListItemBlockObjectResponse,
} from "@notionhq/client";

import { syncApprovalArtifact } from "../atlas/artifact/sync.js";
import {
  candidateToDoBlock,
  ruleToBulletText,
  CANONICAL_KEY_OPEN,
  CANONICAL_KEY_CLOSE,
} from "../atlas/artifact/notion-blocks.js";
import { RunStore } from "../atlas/run-store.js";
import { OpenAIDistiller } from "../atlas/llm.js";
import type { AtlasHttpClient } from "../atlas/client.js";
import { type ExclusionRule } from "../atlas/exclude.js";
import {
  CandidateSchema,
  type Candidate,
  type Sensitivity,
  type KnowledgeType,
  type ValidationStatus,
  type Confidence,
} from "../atlas/types.js";

// ── Candidate builder (mirrors atlas-artifact-generate.test.ts) ──────────────

interface CandidateOverrides {
  subsystem?: string;
  title?: string;
  content?: string;
  canonical_key?: string;
  sensitivity?: Sensitivity;
  knowledge_type?: KnowledgeType;
  validation_status?: ValidationStatus;
  confidence?: Confidence;
}

function makeCandidate(o: CandidateOverrides = {}): Candidate {
  const subsystem = o.subsystem ?? "cpk-runtime";
  const title = o.title ?? "Some distilled claim about the runtime";
  const date = "2026-06-08";
  return CandidateSchema.parse({
    sourcetype: "github-pr",
    subsystem,
    source_name: "github-pr",
    repo_url: "https://github.com/CopilotKit/CopilotKit",
    ref: "main",
    title,
    content: o.content ?? "why/how prose explaining the decision",
    provenance: {
      source: "github-pr",
      url: "https://github.com/CopilotKit/CopilotKit/pull/1746",
      date,
      classification: {
        sensitivity: o.sensitivity ?? "internal",
        knowledge_type: o.knowledge_type ?? "architecture",
        audience: "all-staff",
        validation_status: o.validation_status ?? "source-verified",
        confidence: o.confidence ?? "high",
        provenance_class: "primary",
        freshness: { as_of: date },
      },
    },
    evidence: [],
    needsReview: false,
    validationTargets: [],
    canonical_key:
      o.canonical_key ?? `github-pr:${subsystem}:some-distilled-claim`,
    rankScore: 10,
    approvable: true,
  });
}

// ── Notion response-block fixtures ───────────────────────────────────────────
//
// We render each candidate through S16's BUILD side (`candidateToDoBlock`) and
// echo its plain text back as a fetched `to_do` response, so the round-trip the
// real page goes through (build → human edit → fetch → parse) is exercised
// end-to-end. The lead's "edit" is just flipping `checked`.

function plainTextOfRequest(block: unknown): string {
  const b = block as Record<
    string,
    { rich_text?: Array<{ text?: { content?: string } }> }
  >;
  const key = (block as { type?: string }).type as string;
  const rt = b[key]?.rich_text ?? [];
  return rt.map((r) => r.text?.content ?? "").join("");
}

function toDoResponse(
  plainText: string,
  checked: boolean,
  opts: { id?: string; hasChildren?: boolean } = {},
): ToDoBlockObjectResponse {
  return {
    type: "to_do",
    to_do: {
      rich_text: [
        {
          type: "text",
          plain_text: plainText,
          href: null,
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
          text: { content: plainText, link: null },
        },
      ],
      color: "default",
      checked,
    },
    parent: { type: "page_id", page_id: "p" },
    object: "block",
    id: opts.id ?? `todo-${Math.random().toString(36).slice(2)}`,
    created_time: "2026-06-08T00:00:00.000Z",
    created_by: { object: "user", id: "u" },
    last_edited_time: "2026-06-08T00:00:00.000Z",
    last_edited_by: { object: "user", id: "u" },
    has_children: opts.hasChildren ?? false,
    in_trash: false,
    archived: false,
  } as ToDoBlockObjectResponse;
}

function bulletResponse(
  plainText: string,
): BulletedListItemBlockObjectResponse {
  return {
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [
        {
          type: "text",
          plain_text: plainText,
          href: null,
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
          text: { content: plainText, link: null },
        },
      ],
      color: "default",
    },
    parent: { type: "page_id", page_id: "p" },
    object: "block",
    id: `bullet-${Math.random().toString(36).slice(2)}`,
    created_time: "2026-06-08T00:00:00.000Z",
    created_by: { object: "user", id: "u" },
    last_edited_time: "2026-06-08T00:00:00.000Z",
    last_edited_by: { object: "user", id: "u" },
    has_children: false,
    in_trash: false,
    archived: false,
  } as BulletedListItemBlockObjectResponse;
}

// A fetched CALLOUT response (the shape S16's unverifiedNoteBlock / provenance
// callout comes back as) — used to prove marker-bearing NON-to_do children are
// filtered out of the english-rule prose.
function calloutResponse(plainText: string): BlockObjectResponse {
  return {
    type: "callout",
    callout: {
      rich_text: [
        {
          type: "text",
          plain_text: plainText,
          href: null,
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
          text: { content: plainText, link: null },
        },
      ],
      color: "default",
      icon: { type: "emoji", emoji: "⚠️" },
    },
    parent: { type: "page_id", page_id: "p" },
    object: "block",
    id: `callout-${Math.random().toString(36).slice(2)}`,
    created_time: "2026-06-08T00:00:00.000Z",
    created_by: { object: "user", id: "u" },
    last_edited_time: "2026-06-08T00:00:00.000Z",
    last_edited_by: { object: "user", id: "u" },
    has_children: false,
    in_trash: false,
    archived: false,
  } as unknown as BlockObjectResponse;
}

// Render a candidate's checkbox text the way S16 builds it, then echo it back as
// a fetched to_do response with the lead's `checked` choice applied.
function candidateAsFetchedToDo(
  c: Candidate,
  checked: boolean,
  opts: { id?: string; hasChildren?: boolean } = {},
): ToDoBlockObjectResponse {
  const text = plainTextOfRequest(candidateToDoBlock(c));
  return toDoResponse(text, checked, opts);
}

// A generic fetched-block response of any text-bearing type — every such block
// carries its rich_text under its own type key (paragraph, toggle, callout, …),
// which is exactly the shape `blockPlainText`/`fetchChildProse` read back.
function textBlockResponse(
  type: string,
  plainText: string,
  opts: { id?: string; hasChildren?: boolean } = {},
): BlockObjectResponse {
  return {
    type,
    [type]: {
      rich_text: [
        {
          type: "text",
          plain_text: plainText,
          href: null,
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
          text: { content: plainText, link: null },
        },
      ],
      color: "default",
    },
    parent: { type: "page_id", page_id: "p" },
    object: "block",
    id: opts.id ?? `${type}-${Math.random().toString(36).slice(2)}`,
    created_time: "2026-06-08T00:00:00.000Z",
    created_by: { object: "user", id: "u" },
    last_edited_time: "2026-06-08T00:00:00.000Z",
    last_edited_by: { object: "user", id: "u" },
    has_children: opts.hasChildren ?? false,
    in_trash: false,
    archived: false,
  } as unknown as BlockObjectResponse;
}

// Convert the REAL request-block subtree S16 builds (`candidateToDoBlock`'s
// children — a `toggle` whose paragraph grandchildren hold the distilled body,
// plus the provenance callout / evidence bullets) into the fetched-back Notion
// response tree, wiring each block's own children into a `children` map keyed by
// a synthesized id. This mirrors EXACTLY how the page round-trips: build →
// (human edit) → fetch, so `fetchChildProse` sees the same toggle→paragraph
// indirection it must descend through. Returns the top-level response blocks and
// the id→children map to feed `makeMockNotion`.
function requestChildrenAsFetched(
  requestChildren: unknown[],
  idPrefix: string,
): {
  blocks: BlockObjectResponse[];
  childrenMap: Record<string, BlockObjectResponse[]>;
} {
  const childrenMap: Record<string, BlockObjectResponse[]> = {};
  let counter = 0;
  const convert = (req: unknown): BlockObjectResponse => {
    const b = req as Record<string, unknown> & { type: string };
    const type = b.type;
    const data = b[type] as {
      rich_text?: Array<{ text?: { content?: string } }>;
      children?: unknown[];
    };
    const plainText = (data.rich_text ?? [])
      .map((r) => r.text?.content ?? "")
      .join("");
    const id = `${idPrefix}-${type}-${counter++}`;
    const grandchildren = data.children ?? [];
    const response = textBlockResponse(type, plainText, {
      id,
      hasChildren: grandchildren.length > 0,
    });
    if (grandchildren.length > 0) {
      childrenMap[id] = grandchildren.map(convert);
    }
    return response;
  };
  return { blocks: requestChildren.map(convert), childrenMap };
}

// ── Mock Notion client whose blocks.children.list returns a fixed page ───────

interface MockNotion {
  client: Client;
  listCalls: Array<Record<string, unknown>>;
}

function makeMockNotion(
  blocks: Array<BlockObjectResponse | PartialBlockObjectResponse>,
  opts: {
    paginate?: boolean;
    // Child blocks served when blocks.children.list is called with one of these
    // block ids (the per-to_do provenance/evidence prose sync fetches for
    // english-rule judgment). Any other block_id gets the page-level sequence.
    children?: Record<string, BlockObjectResponse[]>;
  } = {},
): MockNotion {
  const listCalls: Array<Record<string, unknown>> = [];
  // Optionally split the blocks across two pages to prove pagination is honored.
  const pages: Array<Array<BlockObjectResponse | PartialBlockObjectResponse>> =
    opts.paginate && blocks.length > 1
      ? [blocks.slice(0, 1), blocks.slice(1)]
      : [blocks];

  const list = vi.fn(
    async (
      args: Record<string, unknown>,
    ): Promise<ListBlockChildrenResponse> => {
      listCalls.push(args);
      const childBlocks = opts.children?.[args.block_id as string];
      if (childBlocks) {
        return {
          type: "block",
          block: {},
          object: "list",
          next_cursor: null,
          has_more: false,
          results: childBlocks,
        } as ListBlockChildrenResponse;
      }
      const cursor = args.start_cursor as string | undefined;
      const pageIndex = cursor === undefined ? 0 : Number(cursor);
      const results = pages[pageIndex] ?? [];
      const hasMore = pageIndex < pages.length - 1;
      return {
        type: "block",
        block: {},
        object: "list",
        next_cursor: hasMore ? String(pageIndex + 1) : null,
        has_more: hasMore,
        results,
      } as ListBlockChildrenResponse;
    },
  );

  const client = { blocks: { children: { list } } } as unknown as Client;
  return { client, listCalls };
}

// ── Mock AtlasHttpClient (HTTP — vi.fn) ──────────────────────────────────────

interface MockHttp {
  client: AtlasHttpClient;
  approve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
}

function makeMockHttpClient(overrides?: {
  approve?: (
    input: { canonicalKey: string },
    actor: string,
  ) => Promise<boolean>;
  reject?: (input: { canonicalKey: string }, actor: string) => Promise<boolean>;
}): MockHttp {
  // The real client resolves `true` when the server enacted the ratification
  // and `false` when it swallowed the idempotent not-pending 409.
  const approve = vi.fn(overrides?.approve ?? (async () => true));
  const reject = vi.fn(overrides?.reject ?? (async () => true));
  const client = { approve, reject } as unknown as AtlasHttpClient;
  return { client, approve, reject };
}

// ── aimock for the english-rule judgment (the ONE LLM touchpoint) ────────────

const EXCLUSION_SYSTEM_MARKER = "exclusion-rule judge";

// The english rule the lead leaves on the page; the "model" excludes a candidate
// whose text matches the Athena marker and keeps everything else.
const ATHENA_RULE: ExclusionRule = {
  kind: "english",
  text: "Exclude anything about the Athena engagement.",
};

describe("syncApprovalArtifact (S17)", () => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  let llm: OpenAIDistiller;
  let runsDir: string;

  const ACTOR = "atlas-harvest-bot";

  beforeAll(async () => {
    // NOTE: the rule TEXT ("…Athena engagement…") rides in the userMessage of
    // EVERY english-rule eval (the payload is {rule, candidate}), so we must gate
    // the EXCLUDE fixture on a token that appears ONLY in the EXCLUDED candidate's
    // reconstructed title — "kickoff" — never on a token shared with the rule.
    const fixtures: Fixture[] = [
      // EXCLUDE: only the Athena-kickoff candidate carries "kickoff".
      {
        match: {
          systemMessage: EXCLUSION_SYSTEM_MARKER,
          userMessage: "kickoff",
        },
        response: {
          content: JSON.stringify({
            excluded: true,
            reason:
              "Candidate is about the Athena engagement, which the rule forbids.",
          }),
        },
      },
      // EXCLUDE: the "credszzz" token rides ONLY in the child-block prose of the
      // body-credential candidate (its title is clean) — so this fixture firing
      // proves the english rule judged the fetched child-block content, not just
      // the title.
      {
        match: {
          systemMessage: EXCLUSION_SYSTEM_MARKER,
          userMessage: "credszzz",
        },
        response: {
          content: JSON.stringify({
            excluded: true,
            reason: "Candidate body reveals a credential value.",
          }),
        },
      },
      // EXCLUDE: "gtmzone" appears ONLY as the subsystem recovered from the
      // canonical_key (never in any title, content, or rule text) — so this
      // fixture firing proves the reconstructed candidate carried the REAL
      // subsystem into the LLM payload.
      {
        match: {
          systemMessage: EXCLUSION_SYSTEM_MARKER,
          userMessage: "gtmzone",
        },
        response: {
          content: JSON.stringify({
            excluded: true,
            reason: "Candidate belongs to the excluded go-to-market subsystem.",
          }),
        },
      },
      // EXCLUDE: the canonical-key OPEN marker leaking into a candidate's
      // title/content means extractTitle mis-sliced — no correctly-parsed
      // payload ever carries it (the rule texts below avoid the token too).
      {
        match: {
          systemMessage: EXCLUSION_SYSTEM_MARKER,
          userMessage: CANONICAL_KEY_OPEN,
        },
        response: {
          content: JSON.stringify({
            excluded: true,
            reason: "Candidate text still carries a machine marker.",
          }),
        },
      },
      // KEEP: every other candidate the english rule sees.
      {
        match: { systemMessage: EXCLUSION_SYSTEM_MARKER },
        response: {
          content: JSON.stringify({
            excluded: false,
            reason: "Candidate is unrelated to the Athena engagement.",
          }),
        },
      },
    ];
    for (const f of fixtures) mock.addFixture(f);
    await mock.start();
    llm = new OpenAIDistiller({ baseURL: `${mock.url}/v1`, apiKey: "mock" });
  });

  afterAll(async () => {
    await mock.stop();
  });

  beforeEach(() => {
    mock.resetMatchCounts();
    runsDir = mkdtempSync(join(tmpdir(), "atlas-sync-"));
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("approves checked & non-excluded candidates, rejects unchecked ones (with actor)", async () => {
    const approved = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:approved-claim",
      title: "A claim the lead approved",
    });
    const unchecked = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:unchecked-claim",
      title: "A claim the lead left unchecked",
    });

    const { client: notion } = makeMockNotion([
      candidateAsFetchedToDo(approved, true),
      candidateAsFetchedToDo(unchecked, false),
    ]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-1",
      client,
      actor: ACTOR,
      llm,
    });

    // Checked & not-excluded → approve(actor).
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(
      { canonicalKey: "github-pr:cpk-runtime:approved-claim" },
      ACTOR,
    );
    // Unchecked → reject(actor).
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0][0].canonicalKey).toBe(
      "github-pr:cpk-runtime:unchecked-claim",
    );
    expect(reject.mock.calls[0][1]).toBe(ACTOR);

    expect(result.approved).toEqual(["github-pr:cpk-runtime:approved-claim"]);
    expect(result.rejected).toContain("github-pr:cpk-runtime:unchecked-claim");
    expect(result.excluded).toEqual([]);
  });

  it("rejects a checked candidate that an english exclusion rule drops (via aimock)", async () => {
    const checkedKept = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:keep-me",
      title: "A generic runtime architecture claim",
    });
    const checkedExcluded = makeCandidate({
      canonical_key: "github-pr:gtm:athena-deal",
      subsystem: "gtm",
      title: "Notes from the Athena engagement kickoff",
    });

    const { client: notion } = makeMockNotion([
      // The exclusion-rule bullet the lead left on the page.
      bulletResponse(ruleToBulletText(ATHENA_RULE)),
      candidateAsFetchedToDo(checkedKept, true),
      candidateAsFetchedToDo(checkedExcluded, true),
    ]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-2",
      client,
      actor: ACTOR,
      llm,
    });

    // The Athena candidate was checked but the english rule excludes it → reject.
    expect(result.excluded).toEqual(["github-pr:gtm:athena-deal"]);
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalKey: "github-pr:gtm:athena-deal" }),
      ACTOR,
    );
    // The other checked candidate survives the rule → approve.
    expect(result.approved).toEqual(["github-pr:cpk-runtime:keep-me"]);
    expect(approve).toHaveBeenCalledWith(
      { canonicalKey: "github-pr:cpk-runtime:keep-me" },
      ACTOR,
    );
    // Excluded keys are NOT also reported as plain rejected.
    expect(result.rejected).not.toContain("github-pr:gtm:athena-deal");
  });

  it("feeds a checked candidate's CHILD-BLOCK prose to english rules (clean title, dirty body → excluded)", async () => {
    // The english exclusion pass must judge real candidate content, not just the
    // checkbox title: the why/how prose lives in the to_do's CHILD blocks
    // (provenance + evidence, rendered by provenanceAndEvidenceChildren). Here the
    // TITLE is clean, but the child-block evidence prose carries a credential
    // token ("credszzz") that the credential rule must catch. If sync judged
    // title-only, the catch-all KEEP fixture would match and the candidate would
    // be wrongly approved — a §11 gate bypass.
    const bodyDirty = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:body-credential",
      title: "Rotate the deploy pipeline settings",
    });

    const credentialRule: ExclusionRule = {
      kind: "english",
      text: "Exclude anything that contains or reveals secret values.",
    };

    const todoId = "todo-body-credential";
    const { client: notion } = makeMockNotion(
      [
        bulletResponse(ruleToBulletText(credentialRule)),
        candidateAsFetchedToDo(bodyDirty, true, {
          id: todoId,
          hasChildren: true,
        }),
      ],
      {
        children: {
          [todoId]: [
            bulletResponse(
              "thread: deploy token credszzz=sk-live-bbb pasted in logs",
            ),
          ],
        },
      },
    );
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-body-credential",
      client,
      actor: ACTOR,
      llm,
    });

    // Checked, clean title — but the child-block prose trips the rule → EXCLUDED.
    expect(result.excluded).toEqual(["github-pr:cpk-runtime:body-credential"]);
    expect(result.approved).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalKey: "github-pr:cpk-runtime:body-credential",
      }),
      ACTOR,
    );
  });

  it("descends into the 'Content (why/how)' toggle so a body-only credential is caught (real round-trip, §11)", async () => {
    // The REAL round-trip: S16 renders the distilled body inside a `toggle`
    // ("Content (why/how)") whose PARAGRAPH grandchildren carry the prose
    // (candidateToDoBlock → toggle → paragraphs), NOT as a direct child of the
    // to_do. The title here is clean, but the body paragraph carries a GitHub
    // PAT-shaped token (ghp_ + 36 alnum) the deterministic credential floor must
    // catch. `fetchChildProse` must DESCEND into the toggle to reach it — a
    // depth-1-only read would capture the toggle's static "Content (why/how)"
    // label and MISS the body, wrongly approving a leaked-credential row.
    const bodyToken = `ghp_${"a1b2c3d4e5".repeat(4).slice(0, 36)}`;
    expect(bodyToken).toMatch(/^ghp_[A-Za-z0-9]{36}$/);
    const bodyDirty = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:toggle-body-credential",
      title: "Rotate the deploy pipeline settings",
      content: `The deploy runbook pasted a live token: ${bodyToken} into the log stream.`,
    });

    // The SHIPPED credential english rule (fail-restrictive deterministic floor;
    // no LLM needed for the credential shape) — mirrors DEFAULT_EXCLUSION_RULES.
    const credentialRule: ExclusionRule = {
      kind: "english",
      text: "Exclude anything that contains or reveals credentials, secret API keys, access tokens, passwords, or other sensitive secret values.",
    };

    // Build the candidate's REAL child tree and echo it back as the fetched
    // toggle→paragraph response tree, wired into the children map.
    const todoId = "todo-toggle-body-credential";
    const requestBlock = candidateToDoBlock(bodyDirty) as unknown as Record<
      string,
      { children?: unknown[] }
    >;
    const requestChildren = requestBlock.to_do?.children ?? [];
    const { blocks: childBlocks, childrenMap } = requestChildrenAsFetched(
      requestChildren,
      todoId,
    );

    const { client: notion } = makeMockNotion(
      [
        bulletResponse(ruleToBulletText(credentialRule)),
        candidateAsFetchedToDo(bodyDirty, true, {
          id: todoId,
          hasChildren: true,
        }),
      ],
      {
        children: {
          [todoId]: childBlocks,
          ...childrenMap,
        },
      },
    );
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-toggle-body-credential",
      client,
      actor: ACTOR,
      llm,
    });

    // The body credential is caught → candidate EXCLUDED (never approved).
    expect(result.excluded).toEqual([
      "github-pr:cpk-runtime:toggle-body-credential",
    ]);
    expect(result.approved).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalKey: "github-pr:cpk-runtime:toggle-body-credential",
      }),
      ACTOR,
    );
  });

  it("does NOT leak the 'Content (why/how)' toggle LABEL into the reconstructed content", async () => {
    // The toggle's own rich_text is a static UI label — it must never enter the
    // english-rule payload (it would pollute every judgment and could even
    // accidentally match a rule). The extractor folds the toggle's PARAGRAPH
    // grandchildren, skipping the toggle label itself. Observed via the aimock
    // journal: the reconstructed content carries the body prose ("bodyzzz") but
    // NOT the "Content (why/how)" label.
    mock.clearRequests();
    const c = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:toggle-label-leak",
      title: "A clean claim about bodyzzz retention",
      content: "why/how prose about bodyzzz that should ride, label should not",
    });
    const keepRule: ExclusionRule = {
      kind: "english",
      text: "Exclude rows that reveal customer contract values.",
    };

    const todoId = "todo-toggle-label-leak";
    const requestBlock = candidateToDoBlock(c) as unknown as Record<
      string,
      { children?: unknown[] }
    >;
    const requestChildren = requestBlock.to_do?.children ?? [];
    const { blocks: childBlocks, childrenMap } = requestChildrenAsFetched(
      requestChildren,
      todoId,
    );

    const { client: notion } = makeMockNotion(
      [
        bulletResponse(ruleToBulletText(keepRule)),
        candidateAsFetchedToDo(c, true, { id: todoId, hasChildren: true }),
      ],
      { children: { [todoId]: childBlocks, ...childrenMap } },
    );
    const { client } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-toggle-label-leak",
      client,
      actor: ACTOR,
      llm,
    });

    expect(result.approved).toEqual([
      "github-pr:cpk-runtime:toggle-label-leak",
    ]);
    const entry = mock
      .getRequests()
      .find((r) => JSON.stringify(r.body ?? {}).includes("bodyzzz"));
    expect(entry).toBeDefined();
    const userMessage = String(
      entry!.body!.messages.find((m) => m.role === "user")?.content ?? "",
    );
    const payload = JSON.parse(userMessage) as {
      candidate: { content: string };
    };
    expect(payload.candidate.content).toContain("bodyzzz");
    expect(payload.candidate.content).not.toContain("Content (why/how)");
  });

  it("falls back to title-only content for a checked row with no child blocks", async () => {
    // A hand-typed checkbox has no children; its title is the only judgeable
    // text. A clean-titled childless row must survive the same english rule that
    // excluded the dirty-bodied row above.
    const childless = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:childless-clean",
      title: "Document the retry policy defaults",
    });
    const credentialRule: ExclusionRule = {
      kind: "english",
      text: "Exclude anything that contains or reveals secret values.",
    };

    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(credentialRule)),
      candidateAsFetchedToDo(childless, true),
    ]);
    const { client, approve } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-childless",
      client,
      actor: ACTOR,
      llm,
    });

    expect(result.approved).toEqual(["github-pr:cpk-runtime:childless-clean"]);
    expect(result.excluded).toEqual([]);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("does NOT enact a to_do whose marker is MID-PROSE (a hand-typed note quoting a key, Y6)", async () => {
    // The marker must be FIRST (after leading whitespace) — the lead's
    // hand-typed unchecked note `"follow up on ⟦atlas:…⟧ tomorrow"` quotes a
    // key mid-prose. Under an anywhere-offset match it parsed AND enacted —
    // the unchecked note REJECTED that candidate. It must simply stop being a
    // candidate: no approve, no reject, no bucket.
    const quotedKey = "github-pr:auth:x";
    const noteText = `follow up on ${CANONICAL_KEY_OPEN}${quotedKey}${CANONICAL_KEY_CLOSE} tomorrow`;

    const { client: notion } = makeMockNotion([toDoResponse(noteText, false)]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-mid-prose-marker",
      client,
      actor: ACTOR,
      llm,
    });

    expect(approve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    expect(result.approved).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.excluded).toEqual([]);
  });

  it("still enacts a marker preceded ONLY by leading whitespace", async () => {
    const key = "github-pr:cpk-runtime:leading-whitespace";
    const text = `  ${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} A row with leading whitespace  [internal · operational · unverified · low]`;

    const { client: notion } = makeMockNotion([toDoResponse(text, true)]);
    const { client, approve } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-leading-whitespace",
      client,
      actor: ACTOR,
      llm,
    });

    expect(result.approved).toEqual([key]);
    expect(approve).toHaveBeenCalledWith({ canonicalKey: key }, ACTOR);
  });

  it("skips (warn, left PENDING) a hand-typed checked row the schema cannot represent — the sync still completes and persists the rule-set (Y8)", async () => {
    // A hand-typed key can retain an interior `⟦` (extractCanonicalKey slices
    // at the first `⟧`): `⟦atlas:a:b⟦c:d⟧` → key `a:b⟦c:d` → recovered
    // subsystem `b⟦c` → the subsystem delimiter refine fails BOTH the
    // badge-path safeParse and the fallback. A throwing fallback would unwind
    // the whole sync mid-reconstruction: NOTHING enacted, §11.5 rule
    // persistence skipped — one corrupt row taking down the page. The row must
    // instead be warned and SKIPPED (left pending), the clean row enacted, and
    // the rule-set persisted.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new RunStore(runsDir);
    const corruptKey = `a:b${CANONICAL_KEY_OPEN.slice(0, 1)}c:d`; // a:b⟦c:d
    const corruptText = `${CANONICAL_KEY_OPEN}${corruptKey}${CANONICAL_KEY_CLOSE} A corrupt hand-typed row`;
    const clean = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:clean-sibling",
      title: "A clean row on the same page",
    });

    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(ATHENA_RULE)),
      toDoResponse(corruptText, true),
      candidateAsFetchedToDo(clean, true),
    ]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-corrupt-handtyped",
      client,
      actor: ACTOR,
      llm,
      runStore: store,
      runId: "run-sync-corrupt-row",
    });

    // The clean row is enacted; the corrupt row lands in NO bucket (pending).
    expect(result.approved).toEqual(["github-pr:cpk-runtime:clean-sibling"]);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(result.rejected).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.conflicted).toEqual([]);
    // The warn names the corrupt key and the left-pending outcome.
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toContain(corruptKey);
    expect(logged).toMatch(/skipped|left pending/);
    // §11.5: the rule-set persisted despite the corrupt row.
    const manifest = store.readManifest("run-sync-corrupt-row");
    expect(manifest?.ruleSet).toEqual([ATHENA_RULE]);
  });

  it("tallies a non-enacted approve (swallowed idempotent 409) into `conflicted`, not `approved`", async () => {
    // The client swallows the not-pending 409 and resolves FALSE: the server
    // refused the enactment (the row is already settled — e.g. previously
    // rejected). Counting that key as "approved" would report an enactment that
    // never happened; it must land in the additive `conflicted` bucket instead,
    // with a warn naming the key. The sync still completes (idempotent re-run).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:already-settled",
      title: "Already settled on a prior run",
    });
    const { client: notion } = makeMockNotion([
      candidateAsFetchedToDo(c, true),
    ]);
    const { client, approve } = makeMockHttpClient({
      approve: async () => false, // 409 swallowed → not enacted
    });

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-3",
      client,
      actor: ACTOR,
      llm,
    });

    expect(approve).toHaveBeenCalledTimes(1);
    expect(result.conflicted).toEqual([
      "github-pr:cpk-runtime:already-settled",
    ]);
    expect(result.approved).toEqual([]);
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(/github-pr:cpk-runtime:already-settled/);
  });

  it("tallies a non-enacted reject (swallowed idempotent 409) into `conflicted`, not `rejected`", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:already-settled-reject",
      title: "Unchecked row whose reject the server refused",
    });
    const { client: notion } = makeMockNotion([
      candidateAsFetchedToDo(c, false),
    ]);
    const { client, reject } = makeMockHttpClient({
      reject: async () => false, // 409 swallowed → not enacted
    });

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-3b",
      client,
      actor: ACTOR,
      llm,
    });

    expect(reject).toHaveBeenCalledTimes(1);
    expect(result.conflicted).toEqual([
      "github-pr:cpk-runtime:already-settled-reject",
    ]);
    expect(result.rejected).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("persists the final rule-set into the run manifest when runStore + runId are given", async () => {
    const store = new RunStore(runsDir);
    const c = makeCandidate({ canonical_key: "github-pr:cpk-runtime:x" });
    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(ATHENA_RULE)),
      bulletResponse(
        ruleToBulletText({
          kind: "flag",
          dimension: "sensitivity",
          equals: "secret",
        }),
      ),
      candidateAsFetchedToDo(c, false),
    ]);
    const { client } = makeMockHttpClient();

    await syncApprovalArtifact({
      notion,
      pageId: "page-4",
      client,
      actor: ACTOR,
      llm,
      runStore: store,
      runId: "run-sync-1",
    });

    const manifest = store.readManifest("run-sync-1");
    expect(manifest).toBeDefined();
    // The manifest's ruleSet is exactly the rules parsed off the edited page.
    expect(manifest?.ruleSet).toEqual([
      ATHENA_RULE,
      { kind: "flag", dimension: "sensitivity", equals: "secret" },
    ]);
  });

  it("drops (and warns on) an EMPTY-text english rule bullet — never persisted into the rule-set", async () => {
    // A hand-edited `atlas-rule: {"kind":"english","text":""}` bullet carries
    // NO instruction: enforced, it would bill an LLM call per candidate with
    // undefined judgment, and §11.5 would re-seed it into every next run's
    // artifact. coerceExclusionRule must warn-reject it at the parse seam.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new RunStore(runsDir);
    const c = makeCandidate({ canonical_key: "github-pr:cpk-runtime:z" });
    const { client: notion } = makeMockNotion([
      bulletResponse('atlas-rule: {"kind":"english","text":""}'),
      candidateAsFetchedToDo(c, false),
    ]);
    const { client } = makeMockHttpClient();

    await syncApprovalArtifact({
      notion,
      pageId: "page-empty-english-rule",
      client,
      actor: ACTOR,
      llm,
      runStore: store,
      runId: "run-sync-empty-english-rule",
    });

    // The empty rule is dropped — NOT enforced, NOT re-seeded via §11.5…
    const manifest = store.readManifest("run-sync-empty-english-rule");
    expect(manifest?.ruleSet).toEqual([]);
    // …and the drop is warned, naming the no-instruction rationale.
    const logged = warn.mock.calls
      .map((w) => w.map(String).join(" "))
      .join("\n");
    expect(logged).toContain("no instruction to evaluate");
  });

  it("preserves the prior manifest's fragmentCount when persisting the rule-set", async () => {
    const store = new RunStore(runsDir);
    // A prior pipeline write recorded the fragment count for this run.
    store.writeManifest("run-sync-2", { fragmentCount: 7, ruleSet: [] });

    const c = makeCandidate({ canonical_key: "github-pr:cpk-runtime:y" });
    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(ATHENA_RULE)),
      candidateAsFetchedToDo(c, false),
    ]);
    const { client } = makeMockHttpClient();

    await syncApprovalArtifact({
      notion,
      pageId: "page-5",
      client,
      actor: ACTOR,
      llm,
      runStore: store,
      runId: "run-sync-2",
    });

    const manifest = store.readManifest("run-sync-2");
    expect(manifest?.fragmentCount).toBe(7);
    expect(manifest?.ruleSet).toEqual([ATHENA_RULE]);
  });

  it("treats a CORRUPT prior manifest as 'no prior' at step 4 (warn + repaired write) instead of aborting after enactment", async () => {
    // The step-4 readManifest happens AFTER approvals/rejections have been
    // enacted. If a corrupt on-disk manifest made it throw, the run's final
    // rule-set (§11.5) would be LOST even though the enactment already
    // happened. It must instead warn, treat the corruption as "no prior
    // manifest", and let writeManifest's own repair path persist the rule-set.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new RunStore(runsDir);
    const runId = "run-sync-corrupt";
    mkdirSync(join(runsDir, runId), { recursive: true });
    writeFileSync(
      join(runsDir, runId, "manifest.json"),
      "{ not valid json",
      "utf-8",
    );

    const c = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:corrupt-prior",
    });
    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(ATHENA_RULE)),
      candidateAsFetchedToDo(c, false),
    ]);
    const { client } = makeMockHttpClient();

    await expect(
      syncApprovalArtifact({
        notion,
        pageId: "page-corrupt-manifest",
        client,
        actor: ACTOR,
        llm,
        runStore: store,
        runId,
      }),
    ).resolves.toBeDefined();

    // The repaired manifest carries the page's rule-set; the unreadable prior
    // fragmentCount degrades to 0.
    const manifest = store.readManifest(runId);
    expect(manifest?.ruleSet).toEqual([ATHENA_RULE]);
    expect(manifest?.fragmentCount).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("does not touch the run-store when no runStore/runId is provided", async () => {
    const c = makeCandidate({ canonical_key: "github-pr:cpk-runtime:z" });
    const { client: notion } = makeMockNotion([
      candidateAsFetchedToDo(c, true),
    ]);
    const { client } = makeMockHttpClient();
    // No runStore — must simply not throw and still enact.
    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-6",
      client,
      actor: ACTOR,
      llm,
    });
    expect(result.approved).toEqual(["github-pr:cpk-runtime:z"]);
  });

  it("recovers the real classification when the title contains [ ] brackets (badge end-anchored)", async () => {
    // A title carrying its own brackets (e.g. "[bugfix] …") must NOT confuse the
    // badge locator. The candidate is `secret`; a `sensitivity=secret` flag rule
    // MUST exclude it — which only works if the badge round-trips correctly. A
    // naive lastIndexOf("[") would slice the title's bracket and silently fall
    // back to the `internal` default, letting the secret candidate get approved.
    const bracketed = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:bracket-claim",
      title: "[bugfix] handle [a] and [b] edge cases",
      sensitivity: "secret",
    });

    const secretRule: ExclusionRule = {
      kind: "flag",
      dimension: "sensitivity",
      equals: "secret",
    };

    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(secretRule)),
      candidateAsFetchedToDo(bracketed, true),
    ]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-bracket",
      client,
      actor: ACTOR,
      llm,
    });

    // The secret candidate is checked, but the flag rule must exclude it —
    // proving the badge (and thus the `secret` sensitivity) was parsed back
    // despite the brackets in the title.
    expect(result.excluded).toEqual(["github-pr:cpk-runtime:bracket-claim"]);
    expect(result.approved).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalKey: "github-pr:cpk-runtime:bracket-claim",
      }),
      ACTOR,
    );
  });

  it("recovers the candidate's subsystem from its canonical_key (not 'unknown')", async () => {
    // The "gtmzone" token appears ONLY inside the canonical_key's subsystem
    // segment — never in the title, content, or rule text. The aimock EXCLUDE
    // fixture gated on "gtmzone" can therefore only fire if the reconstructed
    // candidate carried the REAL subsystem (recovered from the canonical_key)
    // into the LLM payload. If subsystem were hardcoded "unknown", the catch-all
    // KEEP fixture would match instead and the candidate would be approved.
    const c = makeCandidate({
      canonical_key: "github-pr:gtmzone:subsystem-recovery",
      subsystem: "gtmzone",
      title: "A claim whose subsystem must be recovered",
    });

    const subsystemRule: ExclusionRule = {
      kind: "english",
      text: "Exclude anything in the go-to-market subsystem.",
    };

    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(subsystemRule)),
      candidateAsFetchedToDo(c, true),
    ]);
    const { client, approve } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-subsystem",
      client,
      actor: ACTOR,
      llm,
    });

    // Excluded via the subsystem-gated fixture → the exclusion engine saw the
    // REAL subsystem from the canonical_key, not "unknown".
    expect(result.excluded).toEqual(["github-pr:gtmzone:subsystem-recovery"]);
    expect(result.approved).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
  });

  it("warns (naming the canonical_key) when a malformed key degrades the subsystem to 'unknown'", async () => {
    // A hand-pasted marker whose key lacks the two structural colons cannot
    // yield a real subsystem — reconstructCandidate tolerates it and degrades
    // to "unknown" (kept behavior), but the degrade must be NAMED: a
    // subsystem-targeted english rule will silently never match this row, and
    // a silent catch hides that from the lead.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = "malformed-key-no-colons";
    const text = `${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} A row with a malformed key  [internal · operational · unverified · low]`;

    const { client: notion } = makeMockNotion([toDoResponse(text, true)]);
    const { client, approve } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-malformed-key",
      client,
      actor: ACTOR,
      llm,
    });

    // The tolerate-and-degrade behavior is unchanged: the row still enacts.
    expect(result.approved).toEqual([key]);
    expect(approve).toHaveBeenCalledWith({ canonicalKey: key }, ACTOR);
    // The warn names the malformed canonical_key and the "unknown" fallback.
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(new RegExp(key));
    expect(logged).toMatch(/unknown/);
  });

  it("warns when persisting the rule-set with NO prior manifest (dry-run-only run), stamping fragmentCount 0", async () => {
    // runHarvest writes the manifest only on a non-dry-run, so a dry-run-only
    // run has NO prior manifest at sync time. The ruleSet write must still
    // proceed (degrading fragmentCount to 0), but fabricating that 0 silently
    // would mislead the next reader — the missing prior is warned, naming the
    // run id.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new RunStore(runsDir);
    const c = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:no-prior",
    });
    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(ATHENA_RULE)),
      candidateAsFetchedToDo(c, false),
    ]);
    const { client } = makeMockHttpClient();

    await syncApprovalArtifact({
      notion,
      pageId: "page-no-prior",
      client,
      actor: ACTOR,
      llm,
      runStore: store,
      runId: "run-sync-no-prior",
    });

    // The ruleSet write proceeded with the degraded count…
    const manifest = store.readManifest("run-sync-no-prior");
    expect(manifest?.ruleSet).toEqual([ATHENA_RULE]);
    expect(manifest?.fragmentCount).toBe(0);
    // …and the missing prior was warned, naming the run.
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(/run-sync-no-prior/);
    expect(logged).toMatch(/fragmentCount/);
  });

  it("collapses a canonical_key that is both checked and unchecked into ONE decision", async () => {
    // A lead duplicates a row (checks it in one place, leaves the dup unchecked).
    // We must NOT both approve and reject the same key. A checked-anywhere key is
    // approved; the unchecked dup must not also trigger a reject for that key.
    const c = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:dup-claim",
      title: "Duplicated row",
    });

    const { client: notion } = makeMockNotion([
      candidateAsFetchedToDo(c, true),
      candidateAsFetchedToDo(c, false),
    ]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-dup",
      client,
      actor: ACTOR,
      llm,
    });

    expect(result.approved).toEqual(["github-pr:cpk-runtime:dup-claim"]);
    expect(result.rejected).not.toContain("github-pr:cpk-runtime:dup-claim");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
  });

  it("collapses a duplicated key in [unchecked, checked] order — the checked row supersedes the earlier unchecked one", async () => {
    // Order-mutation pin for the dedupe's supersede branch: the test above puts
    // the CHECKED occurrence FIRST (first-seen wins trivially). Here the
    // unchecked dup is seen FIRST, so only the explicit checked-supersedes-
    // unchecked branch makes the checked block win. Without that branch the
    // first-seen unchecked entry would survive and the key would be REJECTED.
    const c = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:dup-claim-reversed",
      title: "Duplicated row, unchecked first",
    });

    const { client: notion } = makeMockNotion([
      candidateAsFetchedToDo(c, false),
      candidateAsFetchedToDo(c, true),
    ]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-dup-reversed",
      client,
      actor: ACTOR,
      llm,
    });

    expect(result.approved).toEqual([
      "github-pr:cpk-runtime:dup-claim-reversed",
    ]);
    expect(result.rejected).not.toContain(
      "github-pr:cpk-runtime:dup-claim-reversed",
    );
    expect(approve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
  });

  it("rejects (never approves) a CHECKED row that reconstructs to an unverified behavior fact (§7 gate)", async () => {
    // A lead hand-pastes a checkbox row for an UNVERIFIED architecture fact — the
    // generate-time gate renders such facts as non-checkable notes, but a pasted
    // to_do bypasses that render gate. Its badge round-trips to
    // knowledge_type=architecture + validation_status=unverified, so the
    // reconstructed candidate is approvable=false. Even though it is CHECKED, the
    // §7 binding gate must reject it at enactment — never approve.
    const unverifiedBehavior = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:unverified-behavior",
      title: "CopilotNext does X (behavior, unproven)",
      knowledge_type: "architecture",
      validation_status: "unverified",
    });

    const { client: notion } = makeMockNotion([
      candidateAsFetchedToDo(unverifiedBehavior, true),
    ]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-unverified",
      client,
      actor: ACTOR,
      llm,
    });

    // Checked, but the §7 gate rejects it — NEVER approved.
    expect(approve).not.toHaveBeenCalled();
    expect(result.approved).toEqual([]);
    expect(result.rejected).toContain(
      "github-pr:cpk-runtime:unverified-behavior",
    );
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalKey: "github-pr:cpk-runtime:unverified-behavior",
      }),
      ACTOR,
    );
  });

  it("approves a CHECKED badge-less row (degrades gracefully to an approvable default)", async () => {
    // A lead hand-types a checkbox with the canonical-key marker + title but NO
    // flag badge. With no badge, the reconstructed classification must degrade to
    // a NON-behavior default so the §7 gate does not silently reject a row the
    // lead deliberately checked.
    const key = "github-pr:cpk-runtime:badge-less-row";
    const badgeLessText = `${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} A row the lead hand-typed`;

    const { client: notion } = makeMockNotion([
      toDoResponse(badgeLessText, true),
    ]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-badge-less",
      client,
      actor: ACTOR,
      llm,
    });

    // Badge-less checked row degrades gracefully and is approved.
    expect(result.approved).toEqual([key]);
    expect(approve).toHaveBeenCalledWith({ canonicalKey: key }, ACTOR);
    expect(reject).not.toHaveBeenCalled();
  });

  it("excludes a checked row whose badge has ONE invalid field — the valid `secret` sensitivity is KEPT, not laundered (per-field coercion)", async () => {
    // THE laundering bug: a badge with a single typo'd field (`LOWish` is not a
    // legal confidence) must NOT reset the ENTIRE classification to the neutral
    // default. Under whole-badge fallback, this `secret` row silently becomes
    // `internal` and dodges the default `sensitivity=secret` flag rule — a
    // checked secret row gets APPROVED. Per-field coercion keeps the three
    // valid fields (secret/operational/unverified), defaults ONLY the invalid
    // confidence, and warns naming the canonical_key + the discarded value.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = "github-pr:cpk-runtime:secret-lowish";
    const badgeText = `${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} A secret row with a typo'd confidence  [secret · operational · unverified · LOWish]`;

    const secretRule: ExclusionRule = {
      kind: "flag",
      dimension: "sensitivity",
      equals: "secret",
    };

    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(secretRule)),
      toDoResponse(badgeText, true),
    ]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-secret-lowish",
      client,
      actor: ACTOR,
      llm,
    });

    // The kept `secret` sensitivity trips the default flag rule → EXCLUDED.
    expect(result.excluded).toEqual([key]);
    expect(result.approved).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalKey: key }),
      ACTOR,
    );
    // The warn names the canonical_key and the discarded field/value.
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(new RegExp(key));
    expect(logged).toMatch(/confidence/);
    expect(logged).toMatch(/LOWish/);
  });

  it("rejects (§7 gate) a checked row whose badge keeps architecture+unverified after only the invalid sensitivity is defaulted", async () => {
    // Per-field semantics: a bogus `sensitivity` defaults ONLY that field — the
    // VALID architecture/unverified pair is kept, so the reconstructed candidate
    // is approvable:false and the §7 binding gate rejects it at enactment.
    // (Under the old whole-badge fallback, the entire classification reset to
    // operational/unverified and the row was approved.) `approvable` is always
    // derived from the FINAL shipped classification, never a discarded value.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = "github-pr:cpk-runtime:zod-invalid-badge";
    const badgeText = `${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} A hand-edited row  [bogus-sensitivity · architecture · unverified · high]`;

    const { client: notion } = makeMockNotion([toDoResponse(badgeText, true)]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-zod-invalid",
      client,
      actor: ACTOR,
      llm,
    });

    // Kept architecture+unverified → approvable:false → §7 gate REJECTS.
    expect(result.approved).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
    expect(result.rejected).toContain(key);
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalKey: key }),
      ACTOR,
    );
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(/sensitivity/);
    expect(logged).toMatch(/bogus-sensitivity/);
  });

  it("approves a checked row whose only invalid badge field is defaulted to a still-approvable value (per-field mirror)", async () => {
    // Mirror: the valid fields (operational/unverified/high) are kept; the
    // bogus sensitivity is defaulted to `internal`. operational/unverified is
    // approvable, so the checked row is approved — and the warn names exactly
    // the one discarded field/value.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = "github-pr:cpk-runtime:zod-invalid-badge-mirror";
    const badgeText = `${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} Another hand-edited row  [bogus-sensitivity · operational · unverified · high]`;

    const { client: notion } = makeMockNotion([toDoResponse(badgeText, true)]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-zod-invalid-mirror",
      client,
      actor: ACTOR,
      llm,
    });

    expect(result.approved).toEqual([key]);
    expect(approve).toHaveBeenCalledWith({ canonicalKey: key }, ACTOR);
    expect(reject).not.toHaveBeenCalled();
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(/sensitivity/);
    expect(logged).toMatch(/bogus-sensitivity/);
  });

  it("parses a badge that is NOT end-anchored (trailing lead annotation) instead of laundering it — the secret row is EXCLUDED, with a warn", async () => {
    // X3: the lead appends an annotation AFTER the badge ("— confirmed with
    // Bob"). The end-anchored primary regex misses, but the fallback scan must
    // locate the badge-shaped group and PARSE it — silently discarding it would
    // reset the row to the neutral `internal` default, dodging the
    // `sensitivity=secret` flag rule and APPROVING a checked secret row.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = "github-pr:cpk-runtime:trailing-badge-secret";
    const text = `${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} A secret row the lead annotated  [secret · operational · unverified · low] — confirmed with Bob`;

    const secretRule: ExclusionRule = {
      kind: "flag",
      dimension: "sensitivity",
      equals: "secret",
    };

    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(secretRule)),
      toDoResponse(text, true),
    ]);
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-trailing-badge",
      client,
      actor: ACTOR,
      llm,
    });

    // The parsed `secret` sensitivity trips the flag rule → EXCLUDED, never
    // approved.
    expect(result.excluded).toEqual([key]);
    expect(result.approved).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalKey: key }),
      ACTOR,
    );
    // The fallback parse is warned, naming the canonical_key.
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(/not end-anchored/);
    expect(logged).toMatch(new RegExp(key));
  });

  it("strips a non-end-anchored badge from the title, preserving the surrounding text (english-rule payload carries no badge text)", async () => {
    // X3 title side: when the badge is located mid-string by the fallback scan,
    // extractTitle must strip exactly the located group — the lead's trailing
    // annotation stays in the title, the badge text does NOT leak into the
    // content the english rule judges. Observed via the aimock journal (the
    // {rule, candidate} payload rides in the user message).
    mock.clearRequests();
    const key = "github-pr:cpk-runtime:trailing-badge-title";
    const text = `${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} Document the retrypolicyzzz defaults  [internal · operational · unverified · low] — confirmed with Bob`;

    const keepRule: ExclusionRule = {
      kind: "english",
      text: "Exclude rows that reveal customer contract values.",
    };

    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(keepRule)),
      toDoResponse(text, true),
    ]);
    const { client } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-trailing-badge-title",
      client,
      actor: ACTOR,
      llm,
    });

    expect(result.approved).toEqual([key]);
    const entry = mock
      .getRequests()
      .find((r) => JSON.stringify(r.body ?? {}).includes("retrypolicyzzz"));
    expect(entry).toBeDefined();
    const userMessage = String(
      entry!.body!.messages.find((m) => m.role === "user")?.content ?? "",
    );
    const payload = JSON.parse(userMessage) as {
      candidate: { title: string; content: string };
    };
    // Badge stripped; lead's trailing annotation preserved.
    expect(payload.candidate.title).not.toContain("[");
    expect(payload.candidate.title).not.toContain("·");
    expect(payload.candidate.title).toContain("retrypolicyzzz");
    expect(payload.candidate.title).toContain("confirmed with Bob");
    expect(payload.candidate.content).not.toContain("·");
  });

  it("degrades a mid-title badge-shaped group (no real badge) to the neutral default via per-field coercion — warns, never crashes", async () => {
    // X3 worst case: a legit title containing `[a · b · c · d]` and NO real
    // badge. The fallback scan locates the group, every field fails enum
    // coercion, and the row lands on the same neutral classification as a
    // badge-less row today — plus warns (noise, never a regression).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = "github-pr:cpk-runtime:mid-title-group";
    const text = `${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} compare [a · b · c · d] tuples in the parser`;

    const { client: notion } = makeMockNotion([toDoResponse(text, true)]);
    const { client, approve } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-mid-title-group",
      client,
      actor: ACTOR,
      llm,
    });

    // Neutral default is approvable → the checked row is approved.
    expect(result.approved).toEqual([key]);
    expect(approve).toHaveBeenCalledWith({ canonicalKey: key }, ACTOR);
    // Each bogus field was discarded by per-field coercion, with warns.
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(/sensitivity="a"/);
    expect(logged).toMatch(/confidence="d"/);
  });

  it("emits NO badge warn for a clean end-anchored badge (primary path unchanged)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:clean-anchored-badge",
      title: "A clean row with an end-anchored badge",
    });
    const { client: notion } = makeMockNotion([
      candidateAsFetchedToDo(c, true),
    ]);
    const { client } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-clean-badge",
      client,
      actor: ACTOR,
      llm,
    });

    expect(result.approved).toEqual([
      "github-pr:cpk-runtime:clean-anchored-badge",
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("discovers an INDENTED (nested) candidate to_do and enacts it, with a warn (X4)", async () => {
    // In Notion, Tab indents a row under the previous sibling — for the
    // candidates list that sibling is another to_do, so an accidentally
    // indented candidate row is a CHILD block a flat top-level scan never
    // sees: not approved, not rejected → pending forever, silently. The
    // recursive discovery must find the nested marker-bearing to_do, enact it
    // (rejected here: it is unchecked), and warn the lead to un-indent it.
    // Evidence callouts/bullets under to_dos remain non-candidates.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parent = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:nested-parent",
      title: "Top-level checked row",
    });
    const nestedKey = "github-pr:cpk-runtime:nested-child";
    const nestedText = `${CANONICAL_KEY_OPEN}${nestedKey}${CANONICAL_KEY_CLOSE} An accidentally indented row  [internal · operational · unverified · low]`;
    const parentId = "todo-nested-parent";

    const { client: notion } = makeMockNotion(
      [
        candidateAsFetchedToDo(parent, true, {
          id: parentId,
          hasChildren: true,
        }),
      ],
      {
        children: {
          [parentId]: [
            toDoResponse(nestedText, false),
            bulletResponse("evidence: some prose under the parent"),
          ],
        },
      },
    );
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-nested-todo",
      client,
      actor: ACTOR,
      llm,
    });

    // The nested unchecked row is DISCOVERED and enacted (rejected).
    expect(result.rejected).toEqual([nestedKey]);
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalKey: nestedKey }),
      ACTOR,
    );
    // The top-level checked parent still approves; the evidence bullet under
    // it did NOT become a candidate.
    expect(result.approved).toEqual(["github-pr:cpk-runtime:nested-parent"]);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledTimes(1);
    // The warn names the nested key and asks the lead to un-indent the row.
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(new RegExp(nestedKey));
    expect(logged).toMatch(/un-indent/);
  });

  it("warns on an INDENTED atlas-rule bullet (not parsed — rules must stay top-level, Y12)", async () => {
    // The recursive walk already visits nested bullets; a nested
    // `atlas-rule:` bullet is skipped by design (rules must remain
    // TOP-LEVEL), but skipping it with no signal makes the lead's rule vanish
    // from enforcement AND §11.5 seeding silently.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new RunStore(runsDir);
    const parent = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:rule-bullet-parent",
      title: "Row the lead indented a rule under",
    });
    const parentId = "todo-rule-bullet-parent";

    const { client: notion } = makeMockNotion(
      [
        candidateAsFetchedToDo(parent, false, {
          id: parentId,
          hasChildren: true,
        }),
      ],
      {
        children: {
          [parentId]: [bulletResponse(ruleToBulletText(ATHENA_RULE))],
        },
      },
    );
    const { client } = makeMockHttpClient();

    await syncApprovalArtifact({
      notion,
      pageId: "page-nested-rule-bullet",
      client,
      actor: ACTOR,
      llm,
      runStore: store,
      runId: "run-sync-nested-rule",
    });

    // The nested rule is NOT parsed into the rule-set (kept behavior)…
    const manifest = store.readManifest("run-sync-nested-rule");
    expect(manifest?.ruleSet).toEqual([]);
    // …but the drop is WARNED, asking the lead to un-indent the bullet.
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(/atlas-rule/);
    expect(logged).toMatch(/un-indent/);
  });

  it("warns on an INDENTED rule bullet Notion auto-capitalized (`Atlas-rule:`) too (Z9)", async () => {
    // Notion auto-capitalizes the first letter of a typed line, so a lead's
    // hand-typed indented rule arrives as `Atlas-rule: {…}`. The rule-intent
    // detection (isRuleBulletText) must be case-insensitive, or the Y12 warn
    // is blind to exactly the hand-typed bullets it exists for.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new RunStore(runsDir);
    const parent = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:capitalized-rule-parent",
      title: "Row the lead indented a capitalized rule under",
    });
    const parentId = "todo-capitalized-rule-parent";

    const capitalized = `A${ruleToBulletText(ATHENA_RULE).slice(1)}`; // "Atlas-rule: {…}"
    const { client: notion } = makeMockNotion(
      [
        candidateAsFetchedToDo(parent, false, {
          id: parentId,
          hasChildren: true,
        }),
      ],
      {
        children: {
          [parentId]: [bulletResponse(capitalized)],
        },
      },
    );
    const { client } = makeMockHttpClient();

    await syncApprovalArtifact({
      notion,
      pageId: "page-nested-capitalized-rule",
      client,
      actor: ACTOR,
      llm,
      runStore: store,
      runId: "run-sync-nested-capitalized-rule",
    });

    // Still NOT parsed into the rule-set (rules must stay top-level)…
    const manifest = store.readManifest("run-sync-nested-capitalized-rule");
    expect(manifest?.ruleSet).toEqual([]);
    // …but the drop IS warned despite the auto-capitalized prefix.
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(/atlas-rule/i);
    expect(logged).toMatch(/un-indent/);
  });

  it("filters a marker-bearing CALLOUT child out of the english-rule prose, retaining plain prose children (Y13)", async () => {
    // An unverified-note callout (or any hand-pasted marker block) nested
    // under a checked row is a MACHINE record, not prose: folding its
    // `⟦atlas:…⟧` text into the parent's content leaks the machine marker
    // into the LLM payload — the marker-gated EXCLUDE fixture would fire and
    // wrongly exclude the row. The plain prose sibling must still be judged.
    mock.clearRequests();
    const parent = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:callout-parent",
      title: "Row with a marker-bearing callout child",
    });
    const parentId = "todo-callout-parent";
    const noteText = `${CANONICAL_KEY_OPEN}github-pr:cpk-runtime:unverified-sibling${CANONICAL_KEY_CLOSE} An unverified note  [internal · architecture · unverified · low] — unverified (not approvable)`;

    const keepRule: ExclusionRule = {
      kind: "english",
      text: "Exclude rows that reveal customer contract values.",
    };

    const { client: notion } = makeMockNotion(
      [
        bulletResponse(ruleToBulletText(keepRule)),
        candidateAsFetchedToDo(parent, true, {
          id: parentId,
          hasChildren: true,
        }),
      ],
      {
        children: {
          [parentId]: [
            calloutResponse(noteText),
            bulletResponse("evidence: plain prose retainzzz under the row"),
          ],
        },
      },
    );
    const { client, approve } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-marker-callout-child",
      client,
      actor: ACTOR,
      llm,
    });

    // No marker leaked into the payload → the marker-gated EXCLUDE fixture did
    // NOT fire → the row is approved.
    expect(result.approved).toEqual(["github-pr:cpk-runtime:callout-parent"]);
    expect(result.excluded).toEqual([]);
    expect(approve).toHaveBeenCalledTimes(1);
    // Journal check: the judged content retains the prose child and carries no
    // machine marker.
    const entry = mock
      .getRequests()
      .find((r) => JSON.stringify(r.body ?? {}).includes("retainzzz"));
    expect(entry).toBeDefined();
    const userMessage = String(
      entry!.body!.messages.find((m) => m.role === "user")?.content ?? "",
    );
    const payload = JSON.parse(userMessage) as {
      candidate: { content: string };
    };
    expect(payload.candidate.content).toContain("retainzzz");
    expect(payload.candidate.content).not.toContain(CANONICAL_KEY_OPEN);
  });

  it("warns at the depth-cap truncation boundary — blocks below the cap are NOT scanned (Y14)", async () => {
    // The recursion's charter says an accidentally-indented candidate row is
    // still found; at the depth cap that stops being true. A depth-4 marker
    // to_do sits pending forever — the truncation must be NAMED, not silent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deepKey = "github-pr:cpk-runtime:depth-four-row";
    const deepText = `${CANONICAL_KEY_OPEN}${deepKey}${CANONICAL_KEY_CLOSE} A row nested too deep  [internal · operational · unverified · low]`;

    const { client: notion } = makeMockNotion(
      [
        toDoResponse("depth-0 plain row", false, {
          id: "d0",
          hasChildren: true,
        }),
      ],
      {
        children: {
          d0: [
            toDoResponse("depth-1 plain row", false, {
              id: "d1",
              hasChildren: true,
            }),
          ],
          d1: [
            toDoResponse("depth-2 plain row", false, {
              id: "d2",
              hasChildren: true,
            }),
          ],
          d2: [
            toDoResponse("depth-3 plain row", false, {
              id: "d3",
              hasChildren: true,
            }),
          ],
          d3: [toDoResponse(deepText, true)], // depth 4 — never fetched
        },
      },
    );
    const { client, approve, reject } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-depth-cap",
      client,
      actor: ACTOR,
      llm,
    });

    // The depth-4 row is undiscovered (kept behavior — the cap stands)…
    expect(approve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    expect(result.approved).toEqual([]);
    expect(result.rejected).toEqual([]);
    // …and the truncation boundary is WARNED.
    const logged = warn.mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(/not scanned/i);
    expect(logged).toMatch(/depth/i);
  });

  it("pins the badge-less default knowledge_type to 'operational' (load-bearing for the §7 gate)", async () => {
    // §7-comment pin: defaultClassification MUST stay a NON-behavior type — a
    // drive-by change to a behavior type (e.g. design-rationale) would make
    // every badge-less checked row reconstruct unverified-behavior →
    // approvable:false → silently rejected. Observed via the aimock journal
    // (the reconstructed classification rides in the english-rule payload).
    mock.clearRequests();
    const key = "github-pr:cpk-runtime:default-ktype-pin";
    const text = `${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} A badge-less row about ktypezzz`;

    const keepRule: ExclusionRule = {
      kind: "english",
      text: "Exclude rows that reveal customer contract values.",
    };

    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(keepRule)),
      toDoResponse(text, true),
    ]);
    const { client } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-ktype-pin",
      client,
      actor: ACTOR,
      llm,
    });

    expect(result.approved).toEqual([key]);
    const entry = mock
      .getRequests()
      .find((r) => JSON.stringify(r.body ?? {}).includes("ktypezzz"));
    expect(entry).toBeDefined();
    const userMessage = String(
      entry!.body!.messages.find((m) => m.role === "user")?.content ?? "",
    );
    const payload = JSON.parse(userMessage) as {
      candidate: { classification: { knowledge_type: string } };
    };
    expect(payload.candidate.classification.knowledge_type).toBe("operational");
  });

  it("stamps a DATE-ONLY freshness.as_of on a reconstructed badge-less row (fleet convention, X24)", async () => {
    // Every adapter stamps date-only as_of values (isoDate); sync's
    // defaultClassification must follow the same convention rather than a full
    // ISO timestamp. Observed via the aimock journal: the reconstructed
    // candidate's classification rides in the english-rule payload.
    mock.clearRequests();
    const key = "github-pr:cpk-runtime:asof-dateonly";
    const text = `${CANONICAL_KEY_OPEN}${key}${CANONICAL_KEY_CLOSE} A hand-typed row about asofzzz`;

    const keepRule: ExclusionRule = {
      kind: "english",
      text: "Exclude rows that reveal customer contract values.",
    };

    const { client: notion } = makeMockNotion([
      bulletResponse(ruleToBulletText(keepRule)),
      toDoResponse(text, true),
    ]);
    const { client } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-asof-dateonly",
      client,
      actor: ACTOR,
      llm,
    });

    expect(result.approved).toEqual([key]);
    const entry = mock
      .getRequests()
      .find((r) => JSON.stringify(r.body ?? {}).includes("asofzzz"));
    expect(entry).toBeDefined();
    const userMessage = String(
      entry!.body!.messages.find((m) => m.role === "user")?.content ?? "",
    );
    const payload = JSON.parse(userMessage) as {
      candidate: { classification: { freshness: { as_of: string } } };
    };
    expect(payload.candidate.classification.freshness.as_of).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("paginates blocks.children.list to read every block on the page", async () => {
    const a = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:page-a",
      title: "first page block",
    });
    const b = makeCandidate({
      canonical_key: "github-pr:cpk-runtime:page-b",
      title: "second page block",
    });
    const { client: notion, listCalls } = makeMockNotion(
      [candidateAsFetchedToDo(a, true), candidateAsFetchedToDo(b, true)],
      { paginate: true },
    );
    const { client, approve } = makeMockHttpClient();

    const result = await syncApprovalArtifact({
      notion,
      pageId: "page-7",
      client,
      actor: ACTOR,
      llm,
    });

    // Two list calls (page 1 + the cursor-followed page 2).
    expect(listCalls.length).toBe(2);
    expect(listCalls[1].start_cursor).toBeDefined();
    // Both candidates (one per page) were enacted.
    expect(approve).toHaveBeenCalledTimes(2);
    expect(result.approved).toEqual([
      "github-pr:cpk-runtime:page-a",
      "github-pr:cpk-runtime:page-b",
    ]);
  });
});
