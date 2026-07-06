# Atlas Harvest — per-leaf agent prompt template

This is the prompt TEMPLATE for ONE Tier-1 leaf miner. A leaf is handed exactly
ONE small unit and produces exactly ONE `CandidateFragment` JSON file. Fill the
`<...>` placeholders per leaf (the shard supplies them — see `blitz-manifest.md`).

> A leaf does NOT skim, summarize loosely, or batch multiple units. One unit in,
> one fragment out, full provenance attached. If the unit yields nothing
> harvestable (e.g. a `feedback_` memory file with no operational substance), the
> adapter WOULD return `[]` and the leaf writes NO file — that is a valid outcome.

---

## PROMPT TEMPLATE (copy, fill placeholders, dispatch)

```
You are a Tier-1 Atlas harvest leaf. You mine ONE unit into ONE knowledge
fragment. Do NOT skim — read the whole unit and capture the actual why/how.

RUN
  RUN_ID:        <run-id>
  FRAGMENTS_DIR: <abs path to runs/<run-id>/fragments>
  AS_OF:         <YYYY-MM-DD harvest date>

YOUR UNIT
  Source family: <memory | github-pr | github-issue | notion-doc | linear-doc | episodic | agent-doc | derived(showcase)>
  Adapter:       <memoryAdapter | githubAdapter | notionAdapter | linearAdapter | episodicAdapter | sourceCommentAdapter | showcaseAdapter>  (src/atlas/adapters/<file>.ts)
  Unit locator:  <PR url / memory file path / Notion page id / Linear doc url / transcript window / file:line span / showcase manifest path>
  Fragment id:   <stable filesystem-safe stem, e.g. github-pr-pathfinder-1746>

STEPS
  1. ACQUIRE the unit in full:
     - memory:        read the .md file (frontmatter + body).
     - github-pr/issue: fetch the PR/issue + its changed files + linked issues + resolved review threads (gh / GitHub API).
     - notion-doc:    fetch the page via the Notion MCP; capture title + every section {heading, body}.
     - linear-doc:    fetch the doc/project via the Linear MCP; capture problem / why / non-goals / cited files / any cross-linked Notion ADR.
     - episodic:      read the transcript WINDOW via the episodic-memory MCP (one bounded window only).
     - agent-doc:     slice the design-block comment AND the code region it annotates (1-based inclusive line span).
     - derived(showcase): parse the integration manifest.yaml AND showcase/shared/feature-registry.json.

  2. SHAPE the unit into the adapter's `*Unit` input (exact field names below).

  3. PRODUCE the fragment:
     - For every family EXCEPT episodic: build the `CandidateFragment` directly,
       matching `CandidateFragmentSchema` (src/atlas/types.ts) — the schema and
       per-family conventions are reproduced below. (The adapters are pure
       functions and define these shapes; produce output that matches what the
       adapter would emit.)
     - For episodic ONLY: use the LLM distill path (`distillEpisodicWindow`) to
       turn the window into the fragment, then HARD-SET the episodic invariants:
       `needsReview: true`, `validation_status: "unverified"`,
       `provenance_class: "derived"`, `confidence: "low"` (clamped — a stronger
       distiller signal is an unsafe escalation), and `sensitivity` floored at
       `"internal"` (preserve any stronger distiller signal — e.g. `"secret"`/
       `"proprietary"` stays; only absent/weaker values become `"internal"`).

  4. WRITE exactly ONE file: `<FRAGMENTS_DIR>/<Fragment id>.json` containing the
     single `CandidateFragment` object (pretty-printed JSON). Create it
     EXCLUSIVELY — if the file already exists, STOP and report BLOCKED (stem
     collision); never overwrite. Do NOT write more
     than one fragment per leaf. EXCEPTION: a single Notion page that records
     multiple ratified decisions splits into one fragment PER decision — in that
     case write `<Fragment id>-1.json`, `-2.json`, … (still one page = one leaf).

  5. ATTACH FULL PROVENANCE + FIRST-PASS CLASSIFICATION (do not leave these
     blank — the reviewer and the validation gate depend on them):
     - provenance.source / url / date / commit (as available),
     - the 7-dimension classification (sensitivity, knowledge_type, audience,
       validation_status, confidence, provenance_class, freshness.as_of),
     - evidence[] (kind-discriminated — see below),
     - validationTargets[] (symbols/paths the validation gate will grep).

  6. DO NOT touch the DB, DO NOT call the `atlas harvest` driver, DO NOT read other
     leaves' fragments. Your only output is the one JSON file.

REPORT
  DONE: wrote <Fragment id>.json (sourcetype=<...>, subsystem=<...>), or
  SKIP: unit carried no harvestable company knowledge (no file written), or
  BLOCKED: <why> (e.g. MCP unreachable).
```

---

## The fragment contract (`CandidateFragmentSchema`, `src/atlas/types.ts`)

Every fragment file is ONE object of this shape:

```jsonc
{
  "sourcetype": "memory | episodic | github-pr | github-issue | notion-doc | linear-doc | agent-doc | derived",
  "subsystem": "<subsystem/saga slug>", // required — must NOT contain ':' (canonical-key delimiter) or '⟦'/'⟧' (approval-marker delimiters); the schema hard-rejects all three
  "claimSlugHint": "<optional claim slug>", // optional
  "source_name": "<logical source name>", // required
  "repo_url": "<optional>",
  "ref": "<optional branch/ref>",
  "title": "<DISTILLED claim — NOT a raw source title>", // required
  "content": "<why/how prose>", // required
  "provenance": {
    // required
    "source": "<source label>", // required
    "url": "<optional>",
    "date": "<optional YYYY-MM-DD>",
    "commit": "<optional>",
    "version": "<optional>",
    "validated_against": "<optional free-text>",
    "classification": {
      // required — all 7 dims
      "sensitivity": "public | internal | proprietary | secret",
      "knowledge_type": "architecture | design-rationale | root-cause | ownership | operational | protocol | security | process | product | gtm | org-culture",
      "audience": "<free string, e.g. all-staff | engineering | gtm>", // defaults to "all-staff"
      "validation_status": "unverified | source-verified | showcase-verified",
      "confidence": "high | medium | low",
      "provenance_class": "primary | derived",
      "freshness": {
        "as_of": "YYYY-MM-DD",
        "re_verify_by": "YYYY-MM-DD (optional)",
      },
    },
  },
  "evidence": [/* zero or more, kind-discriminated — see below */],
  "needsReview": false, // episodic ⇒ true
  "validationTargets": ["<symbol-or-repo-relative-path>", "..."],
}
```

**Evidence items** are a discriminated union on `kind` (exactly one shape each):

```jsonc
{ "kind": "changed_file", "path": "<repo-relative path, or file:line span>" }
{ "kind": "linked_issue", "url": "<issue/PR url, or #123>" }
{ "kind": "thread",       "body": "<free-text: a review thread, a page/decision trace, a source note>" }
{ "kind": "fused_from",   "ref": "<a ref the claim was fused from, e.g. feature-registry:<pill> or source-comment:<file:line>>" }
```

Rules the leaf must honor (the adapters enforce these — match them):

- `title` is the **distilled claim**, never the raw `PR #N: <title>` /
  `Decision N:` heading. State the fact.
- `content` is the **why/how prose**. For a derived fragment (agent-doc,
  showcase) it is a synthesized claim, NOT a verbatim copy of the comment / file.
- A first-pass leaf NEVER claims verification it cannot back: default
  `validation_status` to `unverified` and let the driver's validation gate
  promote it. (Exceptions baked into specific adapters: `agent-doc` is
  `source-verified` because the comment lives at a real `file:line`; `derived`
  showcase is `showcase-verified` only when every declared pill is `green`.)
- A GTM / customer-identifying Notion page is flagged `proprietary` / `secret`
  (never dropped by the leaf — the driver's exclusion stage handles dropping).

---

## Per-family `*Unit` input shapes (what you assemble in STEP 2)

These are the exact adapter input shapes (from `src/atlas/adapters/*.ts`).

**memory** (`MemoryFileUnit`):

```jsonc
{
  "filename": "memory/feedback_nextjs_bundles_node_modules.md",
  "contents": "<full file: frontmatter + body>",
}
```

**github-pr** (`GitHubPullRequestUnit`):

```jsonc
{
  "kind": "pull_request",
  "sourceName": "github-pr:CopilotKit/pathfinder#1746",
  "repo": {
    "fullName": "CopilotKit/pathfinder",
    "cloneUrl": "https://github.com/CopilotKit/pathfinder.git",
    "defaultBranch": "main",
  },
  "pullRequest": {
    "number": 1746,
    "title": "...",
    "body": "...",
    "htmlUrl": "https://github.com/.../pull/1746",
    "mergeCommitSha": "...",
    "baseRef": "main",
    "headRef": "...",
    "author": "...",
    "mergedBy": "...",
  },
  "changedFiles": ["src/db/atlas.ts"],
  "linkedIssues": ["https://github.com/.../issues/1732"],
  "reviewThreads": ["..."],
}
```

**github-issue** (`GitHubIssueUnit`):

```jsonc
{
  "kind": "issue",
  "sourceName": "github-issue:CopilotKit/pathfinder#1732",
  "repo": { "fullName": "...", "cloneUrl": "...", "defaultBranch": "main" },
  "issue": {
    "number": 1732,
    "title": "...",
    "body": "...",
    "htmlUrl": "...",
    "author": "...",
    "state": "closed",
  },
  "linkedIssues": [],
  "reviewThreads": [],
}
```

**notion-doc** (`NotionPageUnit`):

```jsonc
{
  "url": "https://www.notion.so/...",
  "title": "Interrupts Proposal — Design Decisions",
  "subsystem": "agui-protocol",
  "repo_url": "<optional>",
  "ref": "<optional>",
  "date": "2026-05-20",
  "sections": [
    { "heading": "Decision 1: Resume tokens are opaque", "body": "..." },
    { "heading": "Context", "body": "..." },
  ],
}
```

(The adapter splits on decision headings: `Decision …`, `ADR …`, `N. …`. Non-decision sections like Context are page-level only.)

**linear-doc** (`LinearDocUnit`):

```jsonc
{
  "url": "https://linear.app/...",
  "title": "...",
  "problem": "...",
  "why": "...",
  "nonGoals": ["..."],
  "citedFiles": ["src/..."],
  "notionCrossLink": "<optional Notion url>",
  "subsystem": "runtime",
  "area": "<optional>",
  "updatedAt": "2026-05-30",
  "knowledgeType": "ownership",
}
```

**episodic** (`EpisodicWindowUnit`) — distill via the LLM, then hard-set the
invariants (`needsReview: true`, `validation_status: "unverified"`,
`provenance_class: "derived"`, `confidence: "low"` clamped, `sensitivity`
floored at `"internal"` preserving any stronger signal):

```jsonc
{
  "convPath": "<session jsonl path or link>",
  "date": "2026-06-07",
  "text": "<raw transcript window>",
  "subsystem": "<optional hint>",
}
```

**agent-doc / source-comment** (`SourceCommentUnit`):

```jsonc
{
  "filePath": "packages/react-core/src/use-coagent-state-render-bridge.tsx",
  "lineStart": 24,
  "lineEnd": 45,
  "commentText": "<the design-block comment>",
  "codeRegion": "<the annotated code>",
  "subsystem": "react-core",
  "repoUrl": "<optional>",
  "ref": "<optional>",
  "sourceUrl": "<optional GitHub blob #Lx-Ly>",
}
```

**derived / showcase** (`ShowcaseUnit`):

```jsonc
{
  "manifest": {
    "integration": "langgraph-python",
    "name": "LangGraph (Python)",
    "repo_url": "<optional>",
    "description": "<optional>",
    "features": ["agentic-chat", "gen-ui"],
  },
  "registry": {
    "version": "1",
    "categories": [
      { "id": "...", "pills": [{ "id": "agentic-chat", "status": "green" }] },
    ],
  },
}
```

---

## Worked example — a memory leaf, end to end

Unit: the memory file `memory/feedback_nextjs_bundles_node_modules.md`
(`feedback_` prefix; carries operational why-how → KEEP). Fragment id:
`memory-feedback_nextjs_bundles_node_modules`.

Written to `<FRAGMENTS_DIR>/memory-feedback_nextjs_bundles_node_modules.json`:

```json
{
  "sourcetype": "memory",
  "subsystem": "nextjs-bundles-node-modules",
  "claimSlugHint": "nextjs-bundles-node-modules",
  "source_name": "memory/feedback_nextjs_bundles_node_modules.md",
  "title": "Next.js bundles node_modules into server chunks",
  "content": "Next.js inlines node_modules dependencies into .next/server/chunks/*.js at build time, so a patch applied only to node_modules does not take effect until the chunks are rebuilt or also patched.",
  "provenance": {
    "source": "memory:memory/feedback_nextjs_bundles_node_modules.md",
    "date": "2026-06-08",
    "validated_against": "Next.js bundles node_modules into chunks",
    "classification": {
      "sensitivity": "internal",
      "knowledge_type": "operational",
      "audience": "all-staff",
      "validation_status": "unverified",
      "confidence": "medium",
      "provenance_class": "derived",
      "freshness": { "as_of": "2026-06-08" }
    }
  },
  "evidence": [],
  "needsReview": false,
  "validationTargets": []
}
```

## Worked example — an agent-doc (source-comment) leaf

Unit: a design-block comment + code at
`packages/react-core/src/use-coagent-state-render-bridge.tsx:24-45`. Fragment id:
`agent-doc-react-core-state-render-bridge`. Note the **derived** title/content
(fused, not copied), the `source-verified` status (the comment is at a real
`file:line`), the `changed_file` + `fused_from` evidence pair, and the annotated
symbol as a `validationTarget`:

```json
{
  "sourcetype": "agent-doc",
  "subsystem": "react-core",
  "source_name": "source-comment",
  "title": "useCoagentStateRenderBridge: bind render to messageId",
  "content": "As implemented in `useCoagentStateRenderBridge`, the render callback binds to the message's messageId rather than its array index, so reordering messages does not detach a render from its state. This coupling is intentional, not incidental.",
  "provenance": {
    "source": "source-comment",
    "url": "https://github.com/CopilotKit/CopilotKit/blob/main/packages/react-core/src/use-coagent-state-render-bridge.tsx#L24-L45",
    "date": "2026-06-08",
    "validated_against": "packages/react-core/src/use-coagent-state-render-bridge.tsx:24-45",
    "classification": {
      "sensitivity": "internal",
      "knowledge_type": "architecture",
      "audience": "engineering",
      "validation_status": "source-verified",
      "confidence": "high",
      "provenance_class": "derived",
      "freshness": { "as_of": "2026-06-08", "re_verify_by": "2026-09-08" }
    }
  },
  "evidence": [
    {
      "kind": "changed_file",
      "path": "packages/react-core/src/use-coagent-state-render-bridge.tsx:24-45"
    },
    {
      "kind": "fused_from",
      "ref": "source-comment:packages/react-core/src/use-coagent-state-render-bridge.tsx:24-45"
    }
  ],
  "needsReview": false,
  "validationTargets": ["useCoagentStateRenderBridge"]
}
```

After the whole fleet finishes, the driver reads every such file from
`runs/<run-id>/fragments/` and runs Tiers 2-3 over the corpus (see `README.md`).
