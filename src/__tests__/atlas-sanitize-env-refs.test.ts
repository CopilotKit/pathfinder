import { describe, expect, it } from "vitest";

import { sanitizeEnvRefs } from "../atlas/adapters/sanitize-env-refs.js";

// The sanitizer is a pure deterministic pass (§3.1 E1-E6). Each describe below
// is one detection category; the final blocks cover the criterion-7 no-op
// harness and the whole-corpus red-green anchor from §8.
//
// Convenience: most category tests only care about `content`, so this helper
// runs the sanitizer with an empty provenanceSource and returns the sanitized
// content.
function clean(content: string): string {
  return sanitizeEnvRefs(content, "").content;
}

describe("sanitizeEnvRefs — E1 machine-local absolute paths", () => {
  it("keeps the repo-relative tail from the first recognized top-level segment", () => {
    expect(
      clean("see /Users/x/proj/cpk/pathfinder/src/atlas/distillation-gate.ts"),
    ).toBe("see src/atlas/distillation-gate.ts");
  });

  it("infers repo-relative from /proj/ paths (bin/ root)", () => {
    expect(clean("run /proj/cpk/pathfinder/bin/showcase now")).toBe(
      "run bin/showcase now",
    );
  });

  it("infers repo-relative from ~/ paths (tests/ root)", () => {
    expect(clean("edit ~/proj/cpk/pathfinder/tests/foo.ts")).toBe(
      "edit tests/foo.ts",
    );
  });

  it("replaces the whole path with <local-path> when no recognized root is present", () => {
    expect(clean("open /Users/x/random-notes.md")).toBe("open <local-path>");
  });

  it("keeps from the FIRST recognized root on nested cases", () => {
    expect(clean("path /a/src/b/src/c.ts here")).toBe(
      "path src/b/src/c.ts here",
    );
  });

  it("F7 truncation guard: matches the WHOLE path with no leftover tail", () => {
    // The path token runs to end-of-path (whitespace/quote/paren/backtick/EOS),
    // NOT the next slash — so there is no leftover `/pathfinder/...` fragment.
    const out = clean("at /proj/cpk/pathfinder/src/atlas/x.ts:12");
    expect(out).toBe("at src/atlas/x.ts:12");
    expect(out).not.toContain("/proj");
    expect(out).not.toContain("pathfinder/");
  });

  it("terminates the path token at a closing paren", () => {
    expect(clean("(see /Users/x/random-notes.md) done")).toBe(
      "(see <local-path>) done",
    );
  });

  it("terminates the path token at a backtick", () => {
    expect(clean("`/proj/cpk/pathfinder/src/atlas/x.ts`")).toBe(
      "`src/atlas/x.ts`",
    );
  });

  it("sanitizes /home/ paths with no recognized root to <local-path>", () => {
    expect(clean("cd /home/alice/random/notes.md")).toBe("cd <local-path>");
  });

  it("does NOT anchor on a user/home segment named like a repo dir (CR finding 1)", () => {
    // The home/user segment happens to be literally named an anchor dir. It is
    // machine-local structure, NOT a repo-relative tail — must collapse fully.
    expect(clean("open /Users/deploy/proj/app.ts")).toBe("open <local-path>");
    expect(clean("cd /home/src/x/notes.md")).toBe("cd <local-path>");
  });

  it("sanitizes a home-root file with no interior slash (round-3 finding 3)", () => {
    // A `~/`-rooted file with no interior slash (`~/secret.env`) is still a
    // machine-local reference and must collapse to <local-path> — the comment
    // advertised `~/…` handling but the interior-slash requirement missed it.
    expect(clean("cat ~/secret.env")).toBe("cat <local-path>");
    expect(clean("edit ~/.npmrc now")).toBe("edit <local-path> now");
  });

  it("keeps the portable tail for a path rooted at a top-level anchor dir (round-3 finding 4)", () => {
    // A path rooted directly at a repo top-level dir (`/src/x.ts`, `/bin/y`) is
    // portable — keep the tail from that anchor, do NOT collapse to <local-path>.
    expect(clean("see /src/x.ts here")).toBe("see src/x.ts here");
    expect(clean("run /bin/y now")).toBe("run bin/y now");
    // Guard the round-1 fix: a home/user root must STILL collapse fully and must
    // NOT emit the username segment.
    expect(clean("open /Users/deploy/proj/app.ts")).toBe("open <local-path>");
    // Guard the §8 nested anchor still resolves from the first genuine src/.
    expect(clean("path /a/src/b/src/c.ts here")).toBe(
      "path src/b/src/c.ts here",
    );
  });

  it("stops the path at trailing prose punctuation (CR finding 2)", () => {
    // A trailing comma / period is prose, not part of the path tail. It must
    // not be absorbed into the sanitized path.
    expect(clean("see /Users/x/random-notes.md, then continue")).toBe(
      "see <local-path>, then continue",
    );
    expect(clean("look at /Users/x/notes.md.")).toBe("look at <local-path>.");
    expect(clean("path /proj/cpk/pathfinder/src/atlas/x.ts; next")).toBe(
      "path src/atlas/x.ts; next",
    );
  });

  it("sanitizes machine-local paths in provenanceSource too", () => {
    const { source } = sanitizeEnvRefs(
      "",
      "/Users/x/proj/cpk/pathfinder/src/atlas/memory.ts",
    );
    expect(source).toBe("src/atlas/memory.ts");
  });

  it("is idempotent", () => {
    const x =
      "see /Users/x/proj/cpk/pathfinder/src/atlas/x.ts and /Users/x/z.md";
    expect(clean(clean(x))).toBe(clean(x));
  });
});

describe("sanitizeEnvRefs — E2 session UUIDs", () => {
  const UUID = "e654541f-dcb7-4152-8ee8-f669848555ee";

  it("strips a session UUID clause from content", () => {
    const out = clean(`built as memory:foo.md (session ${UUID})`);
    expect(out).toBe("built as memory:foo.md");
    expect(out).not.toContain(UUID);
  });

  it("strips a session UUID from provenanceSource", () => {
    const { source } = sanitizeEnvRefs("", `memory:foo.md (session ${UUID})`);
    expect(source).not.toContain(UUID);
  });

  it("is idempotent", () => {
    const x = `note (session ${UUID}) tail`;
    expect(clean(clean(x))).toBe(clean(x));
  });
});

describe("sanitizeEnvRefs — E3 Notion page ids/URLs", () => {
  it("replaces a notion.so URL in content with <notion-page-link>", () => {
    const out = clean(
      "see https://www.notion.so/copilotkit/Some-Page-3963aa38185281db80b8e4bf73de0ea5",
    );
    expect(out).toBe("see <notion-page-link>");
    expect(out).not.toContain("3963aa38185281db80b8e4bf73de0ea5");
  });

  it("replaces a bare 32-hex in notion.so context", () => {
    const out = clean("notion.so/3963aa38185281db80b8e4bf73de0ea5 here");
    expect(out).toBe("<notion-page-link> here");
  });

  it("replaces a 32-hex in /p/ context", () => {
    const out = clean("app.notion.com/p/3963aa38185281db80b8e4bf73de0ea5");
    expect(out).toBe("<notion-page-link>");
  });

  it("replaces a dashed-UUID notion.so link with <notion-page-link> (CR finding 3)", () => {
    const out = clean(
      "see https://www.notion.so/copilotkit/Some-Page-3963aa38-1852-81db-80b8-e4bf73de0ea5 tail",
    );
    expect(out).toBe("see <notion-page-link> tail");
    expect(out).not.toContain("notion.so");
    expect(out).not.toContain("3963aa38-1852-81db-80b8-e4bf73de0ea5");
  });

  it("replaces a single-segment notion.so/<hex> URL cleanly (CR finding 4)", () => {
    const out = clean(
      "open https://notion.so/3963aa38185281db80b8e4bf73de0ea5 now",
    );
    expect(out).toBe("open <notion-page-link> now");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("notion.so");
  });

  it("collapses a multi-segment scheme-less notion.so link whole (round-3 finding 2)", () => {
    // A scheme-less notion.so link with 2+ intermediate path segments must
    // collapse WHOLE — no leaked internal page id, no dangling prefix.
    const out = clean(
      "see notion.so/team/space/Page-3963aa38185281db80b8e4bf73de0ea5 tail",
    );
    expect(out).toBe("see <notion-page-link> tail");
    expect(out).not.toContain("3963aa38185281db80b8e4bf73de0ea5");
    expect(out).not.toContain("notion.so");
    expect(out).not.toContain("team/space");
  });

  it("does NOT strip a bare 32-hex commit SHA in code context", () => {
    const sha = "6a10cc2f8d3e4b1a9c7f2e5d8b0a3c6f9e1d4b7a";
    // A commit-SHA-shaped 40-hex must survive; and a bare 32-hex outside notion
    // context must survive too.
    const hex32 = "3963aa38185281db80b8e4bf73de0ea5";
    expect(clean(`git checkout ${sha}`)).toBe(`git checkout ${sha}`);
    expect(clean(`blob hash ${hex32} in tree`)).toBe(
      `blob hash ${hex32} in tree`,
    );
  });

  it("collapses a genuine /p/<id> Notion link (with same-string notion context) to <notion-page-link>, not <local-path> (crfix3 finding: ordering + context anchor)", () => {
    // A bare leading-slash `/p/<id>` looks like a machine-local absolute path to
    // E1, so today it wrongly collapses to <local-path>. When Notion context is
    // present in the same string, it is a genuine Notion page link and must
    // collapse to <notion-page-link>. The reconciliation anchors the /p/ arm on
    // Notion context AND orders the context-anchored Notion arms before E1.
    const hex = "3963aa38185281db80b8e4bf73de0ea5";
    const out = clean(`the notion page /p/${hex} (see notion.so)`);
    expect(out).toContain("<notion-page-link>");
    expect(out).not.toContain("<local-path>");
    expect(out).not.toContain(hex);
  });

  it("does NOT turn a context-free /p/<hex> (no notion anywhere) into <notion-page-link>, and does not leak the raw id (spec OQ5: no context-free strip)", () => {
    // No Notion host/marker in the string => no justification for the Notion
    // label. It must NOT become <notion-page-link>. It falls through to E1,
    // which collapses the whole machine-local path to <local-path> — so the raw
    // id does not leak either. Best of both: no false Notion label, no id leak.
    const hex = "3963aa38185281db80b8e4bf73de0ea5";
    const out = clean(`see the route /p/${hex} for details`);
    expect(out).not.toContain("<notion-page-link>");
    expect(out).not.toContain(hex);
    expect(out).toBe("see the route <local-path> for details");
  });

  it("fires the /p/<id> arm when Notion context existed anywhere pre-replacement, so a notion.so URL AND a /p/<id> in the SAME string both collapse (round-4 finding: marker must be tested pre-replacement)", () => {
    // A string carrying BOTH a notion.so URL AND a bare /p/<id> link: both are
    // genuine Notion page links and must become <notion-page-link>. The /p/ arm
    // is gated on the presence of a Notion marker; that gate must be evaluated
    // against the PRE-replacement (original) content, not the already-partially-
    // replaced output — otherwise the gate's correctness accidentally depends on
    // the replacement placeholder happening to still contain the word "notion".
    const hex1 = "3963aa38185281db80b8e4bf73de0ea5";
    const hex2 = "1111aa38185281db80b8e4bf73de0ea5";
    const out = clean(
      `see https://www.notion.so/copilotkit/Page-${hex1} and /p/${hex2}`,
    );
    expect(out).toBe("see <notion-page-link> and <notion-page-link>");
    expect(out).not.toContain("<local-path>");
    expect(out).not.toContain(hex1);
    expect(out).not.toContain(hex2);
  });

  it("collapses a Notion host carrying leading subdomain labels WHOLE, leaking no leading label (round-4 host hardening)", () => {
    // `notion.so` / `notion.com` matched as a bare host leaves any leading
    // subdomain label dangling (`foo.notion.so/<id>` => `foo.<notion-page-link>`).
    // The host arms must consume ANY number of leading labels (and the scheme, if
    // present) so the whole reference collapses.
    const hex = "3963aa38185281db80b8e4bf73de0ea5";

    const ctx = clean(`see foo.notion.so/${hex} tail`);
    expect(ctx).toBe("see <notion-page-link> tail");
    expect(ctx).not.toContain("foo.");

    const ctxCom = clean(`see app.notion.com/${hex} tail`);
    expect(ctxCom).toBe("see <notion-page-link> tail");
    expect(ctxCom).not.toContain("app.");

    const url = clean(`open https://foo.notion.so/Page-${hex} now`);
    expect(url).toBe("open <notion-page-link> now");
    expect(url).not.toContain("foo.");
    expect(url).not.toContain("https://");
  });

  it("leaves provenanceSource / url untouched by E3", () => {
    const url =
      "https://www.notion.so/copilotkit/Some-Page-3963aa38185281db80b8e4bf73de0ea5";
    const { source } = sanitizeEnvRefs("", url);
    expect(source).toBe(url);
  });

  it("is idempotent", () => {
    const x =
      "see https://www.notion.so/copilotkit/Some-Page-3963aa38185281db80b8e4bf73de0ea5 tail";
    expect(clean(clean(x))).toBe(clean(x));
  });
});

describe("sanitizeEnvRefs — E4 internal Slack channels (closed allowlist)", () => {
  it("replaces #engr with <internal-channel>", () => {
    expect(clean("ping #engr about it")).toBe(
      "ping <internal-channel> about it",
    );
  });

  it("replaces #oss-alerts with <internal-channel>", () => {
    expect(clean("see #oss-alerts")).toBe("see <internal-channel>");
  });

  it("replaces #deploys with <internal-channel>", () => {
    expect(clean("watch #deploys")).toBe("watch <internal-channel>");
  });

  it("does NOT touch #teamwork (F5 negative)", () => {
    expect(clean("the #teamwork tag")).toBe("the #teamwork tag");
  });

  it("does NOT touch #teams (F5 negative)", () => {
    expect(clean("join #teams")).toBe("join #teams");
  });

  it("does NOT touch a Markdown heading '# Infra' (F5 negative)", () => {
    expect(clean("# Infra\nbody")).toBe("# Infra\nbody");
  });

  it("does NOT touch 'see the #infra section' (F5 negative)", () => {
    expect(clean("see the #infra section")).toBe("see the #infra section");
  });

  it("does NOT match #deploys inside #deployserver (word boundary)", () => {
    expect(clean("the #deployserver host")).toBe("the #deployserver host");
  });

  it("is idempotent", () => {
    const x = "ping #engr and #oss-alerts";
    expect(clean(clean(x))).toBe(clean(x));
  });
});

describe("sanitizeEnvRefs — E5 railway hosts", () => {
  it("replaces railway.app/project/<id> with <internal-service>", () => {
    const out = clean(
      "deployed to railway.app/project/6a10cc2f-8d3e-4b1a-9c7f-2e5d8b0a3c6f",
    );
    expect(out).toBe("deployed to <internal-service>");
    expect(out).not.toContain("railway.app/project");
  });

  it("replaces <name>.up.railway.app with <internal-service>", () => {
    const out = clean("host pathfinder-web.up.railway.app is up");
    expect(out).toBe("host <internal-service> is up");
    expect(out).not.toContain("up.railway.app");
  });

  it("replaces an uppercase-labelled railway host case-insensitively (round-3 finding 1)", () => {
    // The host label may contain uppercase (`MyApp.up.railway.app`); the arm
    // must still strip it or the internal host leaks unsanitized.
    const out = clean("host MyApp.up.railway.app is up");
    expect(out).toBe("host <internal-service> is up");
    expect(out).not.toMatch(/railway\.app/i);
  });

  it("replaces an uppercase-domain railway project link case-insensitively (round-3 finding 1)", () => {
    // The literal `railway.app` host label can appear with uppercase (e.g. a
    // copy-pasted `Railway.app/project/…`); the arm must strip it too.
    const out = clean("deployed to Railway.app/project/MyProject-123");
    expect(out).toBe("deployed to <internal-service>");
    expect(out).not.toMatch(/railway\.app/i);
  });

  it("collapses a MULTI-LABEL railway host whole, leaking no leading label (round-4 finding: multi-label leak)", () => {
    // `\b[a-z0-9-]+\.up\.railway\.app` captures only the single label before
    // `.up`, so a multi-label host leaks its leading subdomains
    // (`pr-42.myapp.up.railway.app` => `pr-42.<internal-service>`). The arm must
    // consume ANY number of leading labels and collapse the whole host.
    const out1 = clean("host pr-42.myapp.up.railway.app is up");
    expect(out1).toBe("host <internal-service> is up");
    expect(out1).not.toContain("pr-42");
    expect(out1).not.toMatch(/railway\.app/i);

    const out2 = clean("host svc.myapp.up.railway.app is up");
    expect(out2).toBe("host <internal-service> is up");
    expect(out2).not.toContain("svc.");
    expect(out2).not.toMatch(/railway\.app/i);
  });

  it("collapses an uppercase MULTI-LABEL railway host whole (case-insensitive, no leading-label leak)", () => {
    const out = clean("host PR-42.MyApp.up.railway.app is up");
    expect(out).toBe("host <internal-service> is up");
    expect(out).not.toContain("PR-42");
    expect(out).not.toMatch(/railway\.app/i);
  });

  it("is idempotent", () => {
    const x =
      "host pathfinder-web.up.railway.app and railway.app/project/abc-123";
    expect(clean(clean(x))).toBe(clean(x));
  });
});

describe("sanitizeEnvRefs — E6 internal emails", () => {
  it("replaces an @copilotkit.ai email with <team-member>", () => {
    expect(clean("ask alice@copilotkit.ai for help")).toBe(
      "ask <team-member> for help",
    );
  });

  it("does NOT touch @copilotkit/react-core (F6 negative)", () => {
    expect(clean("import @copilotkit/react-core")).toBe(
      "import @copilotkit/react-core",
    );
  });

  it("does NOT touch @types/node (F6 negative)", () => {
    expect(clean("add @types/node dep")).toBe("add @types/node dep");
  });

  it("does NOT touch @Injectable (F6 negative)", () => {
    expect(clean("use @Injectable() here")).toBe("use @Injectable() here");
  });

  it("does NOT touch @copilotkit handle (F6 negative)", () => {
    expect(clean("follow @copilotkit on X")).toBe("follow @copilotkit on X");
  });

  it("is idempotent", () => {
    const x = "ask alice@copilotkit.ai and bob@copilotkit.ai";
    expect(clean(clean(x))).toBe(clean(x));
  });
});

describe("sanitizeEnvRefs — round-5 uniform host-boundary findings", () => {
  const HEX = "3963aa38185281db80b8e4bf73de0ea5";

  // Finding 1: RAILWAY_PROJECT was never hardened for leading subdomain labels
  // (round-5 hardened RAILWAY_HOST but skipped the project arm). A subdomained
  // host in front of `railway.app/project/<id>` leaks the leading label.
  it("collapses a subdomained railway.app/project/<id> WHOLE, leaking no leading label (finding 1)", () => {
    const out1 = clean("deployed to pr-1.railway.app/project/xyz here");
    expect(out1).toBe("deployed to <internal-service> here");
    expect(out1).not.toContain("pr-1");
    expect(out1).not.toMatch(/railway\.app/i);

    const out2 = clean("deployed to foo.railway.app/project/my-id here");
    expect(out2).toBe("deployed to <internal-service> here");
    expect(out2).not.toContain("foo.");
    expect(out2).not.toMatch(/railway\.app/i);
  });

  // Finding 2: NOTION_CONTEXT_ID had no left boundary, so it matched
  // `notion.so`/`notion.com` MID-LABEL: `evilnotion.so/<hex>` corrupted to
  // `evil<notion-page-link>`.
  it("does NOT match notion.so mid-label — evilnotion.so must not be corrupted (finding 2)", () => {
    const out = clean(`see evilnotion.so/${HEX} here`);
    expect(out).not.toBe(`see evil<notion-page-link> here`);
    expect(out).not.toContain("<notion-page-link>");
    // The genuine (non-Notion) host is left intact; only its bare id would ever
    // be a concern, but `evilnotion.so` is not a Notion host at all.
    expect(out).toContain("evilnotion.so");
  });

  // Finding 3 (round-5) → REVISED by crfix7 F1: the round-5 fix forbade `>` in
  // E1's LEADING_BOUNDARY so a placeholder's trailing `>` could not be an E1
  // anchor. But because the boundary is a ZERO-WIDTH lookbehind (it never
  // consumes the `>`), that `>`-exclusion was the WRONG remedy: it caused a
  // GENUINE machine-local path abutting an emitted placeholder's `>` (e.g.
  // `notion.so/<hex>/Users/jpr5/x.ts` → E3 → `<notion-page-link>/Users/jpr5/x.ts`)
  // to be SKIPPED by E1 — leaking the username verbatim (crfix7 F1). Removing
  // `>` from the forbidden set re-anchors E1 after the placeholder's `>` WITHOUT
  // deleting the `>` (zero-width), so the placeholder stays intact AND the
  // following genuine path is sanitized. Consequently a `/`-rooted interior-slash
  // path immediately after a placeholder is now correctly collapsed: `/foo/bar`
  // has no recognized repo top-level segment (segment 1 `foo` is not a HOME_ROOT
  // and firstAnchorable=1 finds no REPO_TOP_LEVEL match), so it becomes
  // <local-path>. The placeholder's `>` is preserved (never consumed); no `/` is
  // deleted; and the result is idempotent (the emitted <local-path>/<notion-page-link>
  // contain no re-anchorable `/`-rooted path).
  it("sanitizes a genuine path abutting a placeholder's '>' without consuming the '>' (crfix7 F1; revises round-5 finding 3)", () => {
    const input = "<notion-page-link>/foo/bar and more";
    const out = clean(input);
    // The genuine absolute path after the placeholder is sanitized (no leak, no
    // corruption). `/foo/bar` has no repo top-level anchor → <local-path>.
    expect(out).toBe("<notion-page-link><local-path> and more");
    // The placeholder's own `>` is preserved (zero-width lookbehind never
    // consumed it) — the placeholder is not fused into a malformed `<...><`.
    expect(out).not.toContain("<notion-page-link><notion");
    // Idempotence on the placeholder-adjacent path.
    expect(clean(out)).toBe(out);
  });

  // Boundary: a label-less `up.railway.app` host must still collapse.
  it("collapses a label-less up.railway.app host (boundary)", () => {
    const out = clean("host up.railway.app is up");
    expect(out).toBe("host <internal-service> is up");
    expect(out).not.toMatch(/railway\.app/i);
  });

  // Boundary: a bare-word `notion` marker authorizes the /p/<id> arm.
  it("bare-word notion marker authorizes the /p/<id> arm (boundary)", () => {
    const out = clean(`the notion page /p/${HEX} here`);
    expect(out).toContain("<notion-page-link>");
    expect(out).not.toContain("<local-path>");
    expect(out).not.toContain(HEX);
  });

  // Boundary: a bare dashed-UUID with no Notion/session clause context is a
  // free-standing UUID and is stripped by the E2 bare-UUID arm.
  it("strips a bare dashed-UUID via the non-clause E2 branch (boundary)", () => {
    const uuid = "e654541f-dcb7-4152-8ee8-f669848555ee";
    const out = clean(`ref ${uuid} in prose`);
    expect(out).not.toContain(uuid);
  });
});

describe("sanitizeEnvRefs — crfix6 leading-boundary leak (E1 anchor allowlist)", () => {
  // THE LEAK: E1's leading anchor was a consuming ALLOWLIST char class that
  // omitted common path-preceding separators `=`, `:`, `,` (and `;`). So a
  // machine-local absolute path preceded by any of them was left ENTIRELY
  // UNSANITIZED and leaked the full username-bearing path. The systemic fix
  // replaces the allowlist with a principled zero-width negative lookbehind that
  // forbids only path-continuation chars (so we don't match mid-token) and the
  // placeholder terminator `>` (so E1 stays placeholder-safe / idempotent).

  it("sanitizes a path preceded by `=` (KEY=/Users/... shell/env assignment)", () => {
    // `/Users/jpr5/proj/...` has a username at seg 2; per firstAnchorable the
    // scan lands on the first genuine repo top-level (`src/`).
    const out = clean("CONFIG=/Users/jpr5/proj/src/x.ts");
    expect(out).toBe("CONFIG=src/x.ts");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("jpr5");
  });

  it("sanitizes a path preceded by `=` in a --flag=value form", () => {
    // No recognized repo top-level under the username => collapses to <local-path>.
    const out = clean("--config=/Users/alice/secrets/src/prod.ts");
    expect(out).toBe("--config=src/prod.ts");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("alice");
  });

  it("sanitizes a path preceded by `=` where no repo root follows (cwd=)", () => {
    const out = clean("cwd=/Users/alice/x");
    expect(out).toBe("cwd=<local-path>");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("alice");
  });

  it("sanitizes a path preceded by `: ` (YAML/prose `path: /Users/...`)", () => {
    // Colon-space: the space already anchored, but a colon with no space must
    // ALSO anchor. Guard the colon-space prose form explicitly.
    const out = clean("path: /Users/alice/x");
    expect(out).toBe("path: <local-path>");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("alice");
  });

  it("sanitizes a path preceded by a bare `:` (no space)", () => {
    const out = clean("path:/Users/alice/x");
    expect(out).toBe("path:<local-path>");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("alice");
  });

  it("sanitizes a path preceded by a bare `,` (comma anchor, tail to EOS)", () => {
    // The bare `,` immediately before the path must anchor E1 (it was omitted
    // from the old allowlist and leaked). Tail runs to end-of-string.
    const out = clean("list,/Users/alice/x");
    expect(out).toBe("list,<local-path>");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("alice");
  });

  it("sanitizes a path preceded by a bare `;` (semicolon anchor, tail to EOS)", () => {
    const out = clean("first;/Users/alice/x");
    expect(out).toBe("first;<local-path>");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("alice");
  });

  it("sanitizes a machine-local path preceded by `=` in provenanceSource too", () => {
    const { source } = sanitizeEnvRefs(
      "",
      "CONFIG=/Users/x/proj/cpk/pathfinder/src/atlas/memory.ts",
    );
    expect(source).toBe("CONFIG=src/atlas/memory.ts");
    expect(source).not.toContain("/Users/");
  });

  it("does NOT over-match a `=`-preceded time value (no real path shape)", () => {
    // `time=12:30` has no `/`-rooted or `~/`-rooted absolute-path shape after
    // the boundary, so E1 must leave it entirely alone.
    expect(clean("time=12:30")).toBe("time=12:30");
  });

  it("does NOT over-match a `=`-preceded ratio (single interior slash, no path root)", () => {
    // `ratio=3/4` is a bare `/`-separated token, not a `/`-rooted absolute path
    // (the leading `/` is missing), so it must NOT be mangled into a path.
    expect(clean("ratio=3/4")).toBe("ratio=3/4");
  });

  it("still does NOT anchor mid-token / inside a word (word char before `/`)", () => {
    // A slash immediately preceded by a word char (`abc/def`) is not a
    // machine-local absolute path anchor and must be left alone.
    expect(clean("pkg/subpath/file")).toBe("pkg/subpath/file");
  });

  it("stays idempotent for a `=`-preceded path", () => {
    const x = "CONFIG=/Users/jpr5/proj/src/x.ts and cwd=/Users/alice/z.md";
    expect(clean(clean(x))).toBe(clean(x));
  });
});

describe("sanitizeEnvRefs — criterion 7 no-op harness", () => {
  it("leaves pathfinder.yaml untouched", () => {
    expect(clean("configure pathfinder.yaml keys")).toBe(
      "configure pathfinder.yaml keys",
    );
  });

  it("leaves public API symbols untouched", () => {
    expect(clean("call dedupAgainstRagCorpus() on the corpus")).toBe(
      "call dedupAgainstRagCorpus() on the corpus",
    );
  });

  it("leaves HTTP codes untouched", () => {
    expect(clean("returns 401 on bad token")).toBe("returns 401 on bad token");
  });

  it("leaves @scope/pkg npm specifiers untouched", () => {
    expect(clean("depends on @scope/pkg")).toBe("depends on @scope/pkg");
  });
});

describe("sanitizeEnvRefs — whole-corpus red-green anchor (§8)", () => {
  const UUID = "e654541f-dcb7-4152-8ee8-f669848555ee";

  it("a real memory candidate body has no E1-E6 leak after sanitizing", () => {
    const body = `Built as memory:reference_1password_cli.md (session ${UUID}) at /Users/x/proj/cpk/pathfinder/src/atlas/adapters/memory.ts:341. Ping #engr and see https://www.notion.so/copilotkit/Notes-3963aa38185281db80b8e4bf73de0ea5 or ask alice@copilotkit.ai on pathfinder-web.up.railway.app.`;
    const out = clean(body);

    // E1: no machine-local path prefixes.
    expect(out).not.toMatch(/\/Users\//);
    expect(out).not.toMatch(/\/home\//);
    expect(out).not.toMatch(/\/proj\//);
    // E2: no session UUID.
    expect(out).not.toContain(UUID);
    // E3: no notion page id.
    expect(out).not.toContain("3963aa38185281db80b8e4bf73de0ea5");
    // E4: no internal channel.
    expect(out).not.toMatch(/#(?:engr|oss-alerts|deploys)\b/);
    // E5: no railway host.
    expect(out).not.toMatch(/up\.railway\.app/);
    // E6: no internal email.
    expect(out).not.toMatch(/@copilotkit\.ai\b/);

    // But the product-portable repo-relative path survives.
    expect(out).toContain("src/atlas/adapters/memory.ts");
  });

  it("is idempotent on the whole-corpus body", () => {
    const body = `memory:reference_1password_cli.md (session ${UUID}) at /Users/x/proj/cpk/pathfinder/src/atlas/adapters/memory.ts ping #engr https://www.notion.so/copilotkit/N-3963aa38185281db80b8e4bf73de0ea5 alice@copilotkit.ai pathfinder-web.up.railway.app`;
    expect(clean(clean(body))).toBe(clean(body));
  });
});

describe("sanitizeEnvRefs — crfix7 F1: genuine path abutting an emitted placeholder", () => {
  // THE LEAK (crfix7 F1, regression from the round-5 `>`-exclusion): E3/E5 run
  // BEFORE E1 and emit placeholders (`<notion-page-link>`, `<internal-service>`)
  // that end in `>`. When a GENUINE machine-local absolute path immediately
  // follows such a placeholder's `>` (because the original URL had the path
  // appended to it), E1's `>`-forbidding LEADING_BOUNDARY SKIPPED that path — so
  // the username-bearing prefix leaked verbatim. The fix removes `>` from the
  // forbidden set; the boundary stays a ZERO-WIDTH lookbehind so the `>` is never
  // consumed (placeholder intact, no `/` deleted, still idempotent).

  it("sanitizes a real /Users path appended to a collapsed notion link — no username leak (F1)", () => {
    // notion.so/<32hex>/Users/jpr5/x.ts → E3 → `<notion-page-link>/Users/jpr5/x.ts`
    // → E1 must sanitize the appended machine-local path (previously skipped).
    const hex = "3963aa38185281db80b8e4bf73de0ea5";
    const out = clean(`notion.so/${hex}/Users/jpr5/x.ts`);
    expect(out).not.toContain("jpr5");
    expect(out).not.toContain("/Users/");
    expect(out).toContain("<notion-page-link>");
    // /Users/jpr5/x.ts has a username at seg 2, no repo top-level → <local-path>.
    expect(out).toBe("<notion-page-link><local-path>");
  });

  it("is idempotent for a path appended to a collapsed notion link (F1)", () => {
    const hex = "3963aa38185281db80b8e4bf73de0ea5";
    const x = `notion.so/${hex}/Users/jpr5/x.ts`;
    expect(clean(clean(x))).toBe(clean(x));
  });

  it("sanitizes a real /Users path appended to a collapsed railway host — no username leak (F1)", () => {
    // myapp.up.railway.app/Users/jpr5/x.ts → E5 → `<internal-service>/Users/jpr5/x.ts`
    // → E1 must sanitize the appended machine-local path.
    const out = clean("myapp.up.railway.app/Users/jpr5/x.ts");
    expect(out).not.toContain("jpr5");
    expect(out).not.toContain("/Users/");
    expect(out).toContain("<internal-service>");
    expect(out).toBe("<internal-service><local-path>");
  });

  it("is idempotent for a path appended to a collapsed railway host (F1)", () => {
    const x = "myapp.up.railway.app/Users/jpr5/x.ts";
    expect(clean(clean(x))).toBe(clean(x));
  });
});

describe("sanitizeEnvRefs — crfix7 .com fold (NOTION_URL scheme arm)", () => {
  // FOLD-IN: NOTION_URL hardcoded `notion\.so/` while NOTION_CONTEXT_ID accepts
  // both `.so` and `.com`. So a schemed `https://notion.com/<id>` bypassed the
  // scheme arm; NOTION_CONTEXT_ID then matched only `notion.com/<id>` and left a
  // dangling `https://` in front of the placeholder. NOTION_URL now accepts
  // `notion.com` too so the whole schemed URL (scheme included) collapses.
  it("collapses a schemed https://notion.com/<id> whole with no dangling https://", () => {
    const hex = "3963aa38185281db80b8e4bf73de0ea5";
    const out = clean(`open https://notion.com/${hex} now`);
    expect(out).toBe("open <notion-page-link> now");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("notion.com");
  });
});
