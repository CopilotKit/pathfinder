// Deterministic environment-reference sanitizer (spec §3.1, categories E1-E6).
//
// A pure, regex-only pass with NO I/O and NO LLM. Each adapter that emits
// externally-visible content calls this on the fragment's `content` (and
// `provenance.source` where applicable) before returning from extract(), so
// machine-local / session / private-infra glue never enters the external
// corpus. It is a fragment-production concern, not a pipeline stage — modeled
// structurally on sensitivity-scan.ts (module doctrine: cheap deterministic
// first, hardest safety guarantee).
//
// The discriminator (spec §3.2) is KEEP the product-portable specific, STRIP
// the environment glue: a machine-local prefix is glue, but the repo-relative
// tail (`src/atlas/x.ts`) is a portable specific an external builder can
// correlate with public docs, so E1 rewrites in place rather than dropping.
//
// IDEMPOTENCE is a hard contract: sanitizeEnvRefs(sanitizeEnvRefs(x)) must
// equal sanitizeEnvRefs(x) for every input. Each remediation replaces its
// match with a literal placeholder / a repo-relative tail that no longer
// matches the same pattern, so a second pass is a no-op.

// Repo top-level segments we recognize when inferring a repo-relative tail from
// a machine-local absolute path (E1). Enumerated allowlist per spec §3.1 — kept
// deliberately small; extend by editing this list, not by loosening the match.
const REPO_TOP_LEVEL = ["src", "bin", "tests", "scripts", "deploy"];

// A path token runs from its leading boundary until the FIRST of: whitespace,
// quote, paren/bracket/brace/angle, backtick, or end-of-string — NOT the next
// slash (spec §3.1 E1; the F7 truncation guard depends on consuming the WHOLE
// path). It matches a machine-local absolute path (`/…` — the named
// /Users|home|root and /proj roots plus the general `/a/src/…` nested case the
// §8 anchor pins) or a `~/…` home path.
//
// LEADING BOUNDARY — a PRINCIPLED zero-width negative lookbehind, NOT a consuming
// allowlist (crfix6 systemic fix). The prior anchor was an ALLOWLIST char class
// `(^|[\s(`'"[\]{}])` that enumerated the chars permitted to precede a path. That
// allowlist OMITTED common path-preceding separators — `=`, `:`, `,`, `;` — so a
// machine-local path written as `CONFIG=/Users/jpr5/…`, `cwd=/Users/…`,
// `path: /Users/…`, or in a comma/semicolon list was NOT anchored at all and
// leaked its full username-bearing prefix UNSANITIZED (the exact leak this module
// exists to prevent). Enumerating separators is a losing game: every new
// separator (`|`, `&`, tab-vs-space, …) reopens the hole.
//
// So invert the polarity: instead of allowlisting the FEW chars that may precede a
// path, FORBID only the chars that must NOT — and let everything else (any present
// or FUTURE separator) legitimately precede a detected `/`- or `~/`-rooted path.
// `LEADING_BOUNDARY` forbids exactly ONE class, zero-width: PATH-/WORD-CONTINUATION
// chars `[A-Za-z0-9._~/-]` — a `/` preceded by one of these is MID-token (inside an
// already-formed path/word like `pkg/x` or `a/src/b`), not a fresh path anchor, so
// we must not re-anchor there.
//
// PLACEHOLDER TERMINATOR `>` IS DELIBERATELY NOT FORBIDDEN (crfix7 F1): the round-5
// fix added `>` to this forbidden set so a `<…>` placeholder's trailing `>` could
// not be an E1 anchor. But that was the WRONG remedy and it OPENED A LEAK. E3/E5 run
// BEFORE E1 and emit placeholders (`<notion-page-link>`, `<internal-service>`) that
// end in `>`. A real machine-local path appended to such a placeholder — e.g. the
// original `notion.so/<hex>/Users/jpr5/x.ts` becomes `<notion-page-link>/Users/jpr5/x.ts`
// after E3 — was then preceded by `>`, so E1 SKIPPED it and leaked the username
// verbatim. Because this boundary is a ZERO-WIDTH lookbehind, it never consumes the
// `>`; allowing `>` to precede an anchor re-anchors E1 AFTER the placeholder without
// deleting the `>` — the placeholder stays intact, the appended path is sanitized,
// and idempotence holds (the emitted <local-path>/placeholders contain no
// re-anchorable `/`-rooted path). The round-5 "delete the `/`" concern only applied
// to the round-4 CONSUMING allowlist; a zero-width lookbehind cannot delete anything.
//
// Being zero-width, the boundary neither consumes nor preserves a preceding char —
// there is no `lead` capture to re-emit — and it succeeds at start-of-string, so a
// path at position 0 still matches. A `/` inside a URL scheme (`https://…`) is
// preceded by `s` (a word char), so it is correctly rejected; Notion/Railway URLs
// are handled by E3/E5.
const LEADING_BOUNDARY = "(?<![A-Za-z0-9._~/-])";
//
// PLACEHOLDER-AWARE (crfix7 F1, revising round-5 finding 3): a genuine `/`-rooted
// path immediately following an emitted placeholder's `>` (`<notion-page-link>`,
// `<internal-service>`) IS anchored and sanitized — the zero-width LEADING_BOUNDARY
// no longer forbids `>`, so the appended path is caught (no username leak) while the
// `>` itself is never consumed (placeholder stays intact). Angle brackets REMAIN in
// the trailing terminator char classes so a path still STOPS at a `<` and never
// absorbs a following `<…>` placeholder.
//
// Two rooted forms are recognized (CR round-3 finding 3):
//   - a `/`-rooted absolute path MUST contain at least one interior `/`
//     (a bare `/x` word is not a path) so ordinary prose slashes don't match;
//   - a `~/`-rooted home path is machine-local by construction, so a home-root
//     file with NO interior slash (`~/secret.env`, `~/.npmrc`) still matches and
//     collapses to <local-path> — the comment previously advertised `~/…`
//     handling that the shared interior-slash requirement actually missed.
// Both forms consume the WHOLE path to end-of-token (the F7 truncation guard),
// and both share the same trailing-char rule below.
//
// The path may NOT end on a trailing prose-punctuation char (,.;:!?) — such a
// char is sentence punctuation that follows the path in prose, not part of the
// path tail, and absorbing it corrupts the content (CR finding 2). Interior
// punctuation is preserved: a filename period (`x.ts`) and a line:col suffix
// (`x.ts:12`) both survive because they are followed by more path chars. This
// is enforced by requiring the final matched char to be a non-terminal char
// class that excludes trailing punctuation.
const MACHINE_LOCAL_PATH = new RegExp(
  `${LEADING_BOUNDARY}(\\/[^\\s()\`'"[\\]{}<>:/]+(?:\\/[^\\s()\`'"[\\]{}<>]*[^\\s()\`'"[\\]{}<>.,;:!?])+|~\\/[^\\s()\`'"[\\]{}<>:/]*(?:\\/[^\\s()\`'"[\\]{}<>]*)*[^\\s()\`'"[\\]{}<>.,;:!?])`,
  "g",
);

// A session UUID (UUIDv4 shape). E2 strips the surrounding "(session <uuid>)"
// clause when present, else the bare UUID token. The clause form is matched
// first so the parenthetical wrapper is removed cleanly.
const SESSION_CLAUSE =
  /\s*\(session\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)/gi;
const BARE_UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// ── Shared host-boundary fragments (round-5 UNIFORM PASS) ──────────────────
//
// Every host/domain arm (NOTION_URL, NOTION_CONTEXT_ID, RAILWAY_PROJECT,
// RAILWAY_HOST) shares the SAME two boundary properties so no single arm is
// missed one at a time again:
//
//   (i) LEFT BOUNDARY — a host may carry optional leading subdomain labels
//       (`foo.`, `pr-1.myapp.`) which must be consumed as part of the match so
//       they never leak in front of the placeholder; but it must NEVER match
//       MID-LABEL (`evilnotion.so`, `xrailway.app`). The zero-width lookbehind
//       `HOST_LEFT` forbids a preceding label char (letter/digit/hyphen/dot) so
//       the match can only begin at a genuine host-label start, while the
//       `LEADING_LABELS` fragment (matched INSIDE the arm) greedily eats any
//       real subdomain labels that DO precede the anchor domain.
//
//   (ii) CASE-INSENSITIVITY — DNS is case-insensitive and copy-pasted hosts
//        carry uppercase (`MyApp.up.railway.app`, `Railway.app`), so every arm
//        is compiled with the `i` flag.
//
// `HOST_LEFT` is a NEGATIVE LOOKBEHIND, not a consuming char class: a consuming
// left-anchor would either eat the preceding separator (leaking / corrupting
// it) or fail to reset for the next label. Being zero-width, it neither
// consumes nor leaks, and it correctly rejects `evilnotion.so` (the char before
// `notion` is `l`, a label char) while accepting ` notion.so`, `(notion.so`,
// `/notion.so`, and start-of-string.
const HOST_LEFT = "(?<![a-zA-Z0-9-])";
// Zero-or-more leading subdomain labels, each `label.`. Optional so a
// label-less host (`up.railway.app`, `notion.so`) still matches; greedy so a
// multi-label host (`pr-1.myapp.up.railway.app`) collapses WHOLE.
const LEADING_LABELS = "(?:[a-zA-Z0-9-]+\\.)*";

// A Notion page id is EITHER a 32-hex run OR a dashed UUIDv4 (8-4-4-4-12). Both
// forms appear in real Notion URLs (`…-<32hex>` slug tails and `…-<dashed-uuid>`
// canonical ids), so every E3 arm must accept both or the un-matched form leaks
// its dangling internal prefix (CR findings 3 & 4).
const NOTION_ID =
  "(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

// E3 Notion links. Content-only. A full notion.so URL (with a trailing 32-hex
// id or dashed-uuid, and with ZERO or more intermediate path segments so both
// `notion.so/<id>` and `notion.so/team/Page-<id>` collapse whole — CR finding
// 4), OR a bare id that appears in notion.so / notion.com host context. The
// scheme-less context arm ALSO allows zero-or-more intermediate segments
// (matching the full URL) so a multi-segment `notion.so/team/space/Page-<id>`
// collapses WHOLE rather than leaking the internal page id or a dangling prefix
// (CR round-3 finding 2). A bare `/p/<id>` is handled by a SEPARATE
// marker-gated arm (see NOTION_P_ID / NOTION_MARKER below). A bare 32-hex
// OUTSIDE Notion context (e.g. a commit SHA / blob hash in code) must NOT be
// stripped (spec OQ5) — so there is deliberately no context-free bare-hex arm,
// and the `/p/<id>` arm is likewise gated on a same-string Notion marker.
// Each arm consumes the Notion context anchor along with the id, replacing the
// whole span with the placeholder (which no longer matches — idempotent).
//
// Both host arms consume ANY number of leading subdomain labels
// (`(?:[a-z0-9-]+\.)*`) immediately before `notion.so`/`notion.com`, not just
// `www`: a subdomained host (`foo.notion.so/<id>`, `app.notion.com/<id>`,
// `https://foo.notion.so/…`) must collapse WHOLE, or the leading label leaks in
// front of the placeholder (CR round-4 host hardening — the same multi-label
// leak class flagged on the Railway arm). Both are `gi`, so uppercase labels are
// handled too.
// The schemed-URL arm accepts BOTH `notion.so` and `notion.com` (crfix7 fold):
// NOTION_CONTEXT_ID already accepts both, so a schemed `https://notion.com/<id>`
// that only NOTION_URL could match whole was otherwise bypassed here — the
// scheme-less NOTION_CONTEXT_ID arm then matched only `notion.com/<id>` and left a
// dangling `https://` in front of the placeholder. Accepting `notion.com` here
// collapses the whole schemed URL (scheme included).
const NOTION_URL = new RegExp(
  `${HOST_LEFT}https?:\\/\\/${LEADING_LABELS}(?:notion\\.so|notion\\.com)\\/(?:[a-zA-Z0-9-]+\\/)*(?:[a-zA-Z0-9-]*-)?${NOTION_ID}\\b`,
  "gi",
);
// LEFT BOUNDARY (round-5 finding 2): without a left boundary this matched
// `notion.so`/`notion.com` MID-LABEL (`evilnotion.so/<hex>` => `evil<…>`),
// corrupting a non-Notion host. `HOST_LEFT` rejects a preceding label char so
// only a genuine host-label start (or a real leading subdomain consumed by
// `LEADING_LABELS`) matches. `evilnotion.so` no longer matches at all.
const NOTION_CONTEXT_ID = new RegExp(
  `${HOST_LEFT}${LEADING_LABELS}(?:notion\\.so|notion\\.com)\\/(?:p\\/)?(?:[a-zA-Z0-9-]+\\/)*(?:[a-zA-Z0-9-]*-)?${NOTION_ID}\\b`,
  "gi",
);
// A bare `/p/<id>` path segment. On its own this is CONTEXT-FREE — it looks
// exactly like a machine-local absolute path (leading `/`, interior `/`) and
// stripping it unconditionally would violate spec OQ5 (no context-free bare-id
// strip) AND corrupt unrelated routes/paths that merely happen to be `/p/<hex>`.
// So this arm is applied ONLY when the SAME string carries a Notion context
// marker (see NOTION_MARKER) — i.e. it is a genuine Notion page link, not an
// incidental filesystem/route path. When there is no Notion context anywhere in
// the string, a `/p/<id>` falls through to E1 and collapses to <local-path>
// (no leaked id, no false Notion label).
const NOTION_P_ID = new RegExp(
  `\\/p\\/(?:[a-zA-Z0-9-]*-)?${NOTION_ID}\\b`,
  "gi",
);
// Notion context marker: the notion.so / notion.com host, or a standalone
// `notion` word. Its presence in the string authorizes the (otherwise
// context-free) bare `/p/<id>` arm. `notion.so`/`notion.com` are matched with a
// leading domain boundary so `app.notion.com` still qualifies while an unrelated
// substring does not smuggle it in.
const NOTION_MARKER = /\bnotion(?:\.so|\.com)?\b/i;

// E4 internal Slack channels — CLOSED allowlist only (spec §3.1 E4). An open
// `#[a-z][a-z0-9-]+` pattern over-fires on Markdown headings, hashtags, and
// English words (`#teamwork`, `#teams`, `# Infra`, "see the #infra section"),
// so this matches ONLY the three known private slugs as whole tokens (word
// boundary => `#deploys` does not fire inside `#deployserver`).
const SLACK_CHANNEL = /#(?:engr|oss-alerts|deploys)\b/g;

// E5 internal Railway hosts. `railway.app/project/<id>` and
// `<name>.up.railway.app`. Content-only. Both arms share the UNIFORM
// host-boundary treatment (round-5): `HOST_LEFT` rejects a mid-label match,
// `LEADING_LABELS` consumes any leading subdomain labels WHOLE, and both are
// case-insensitive (`i`) because DNS is case-insensitive and copy-pasted hosts
// carry uppercase (`MyApp.up.railway.app`, `Railway.app/project/…`).
//
// RAILWAY_PROJECT (round-5 finding 1): round-5 hardened RAILWAY_HOST for
// multi-label leaks but SKIPPED the project arm, so a subdomained
// `pr-1.railway.app/project/xyz` / `foo.railway.app/project/my-id` leaked the
// leading label (`pr-1.<internal-service>`). `LEADING_LABELS` now consumes those
// leading labels, and `HOST_LEFT` blocks a mid-label match (`xrailway.app`).
//
// RAILWAY_HOST: `LEADING_LABELS` is zero-or-more (not `+`), so a label-less
// `up.railway.app` still collapses; a multi-label host
// (`pr-42.myapp.up.railway.app`) collapses WHOLE with no leading-label leak.
const RAILWAY_PROJECT = new RegExp(
  `${HOST_LEFT}${LEADING_LABELS}railway\\.app\\/project\\/[0-9a-zA-Z-]+\\b`,
  "gi",
);
const RAILWAY_HOST = new RegExp(
  `${HOST_LEFT}${LEADING_LABELS}up\\.railway\\.app\\b`,
  "gi",
);

// E6 internal emails — ONLY the CopilotKit email arm (spec §3.1 E6). A bare
// `@handle` arm is deliberately absent: it would wreck `@copilotkit/react-core`,
// `@types/node`, `@Injectable`, `@copilotkit`.
const TEAM_EMAIL = /[a-z0-9._%+-]+@copilotkit\.ai\b/gi;

// Home/user roots whose immediately-following segment is a machine-local
// username, NOT a repo-internal dir — so an anchor-dir token sitting there
// (`/Users/deploy/…`, `/home/src/…`) is machine-local structure, not a
// repo-relative tail, and must not anchor E1 (CR finding 1).
const HOME_ROOTS = ["Users", "home", "root"];

// From a machine-local absolute path, keep the substring starting at the FIRST
// occurrence of a recognized repo top-level segment to end-of-path; if none is
// present, return the literal `<local-path>`. Splitting on "/" and scanning for
// the first recognized segment makes "first occurrence" deterministic on nested
// cases (`/a/src/b/src/c` => `src/b/src/c`, the first `src/`).
//
// The anchor must be a GENUINE repo-internal segment, never a machine-local
// one. The first anchorable segment depends on the root form:
//   - a `/Users`|`/home`|`/root` root has a username at segment 2, so the first
//     genuine repo segment is segment 3 (`/Users/deploy/proj/x.ts` must collapse
//     to `<local-path>`, NOT emit `deploy/…` — CR round-1 finding 1);
//   - a `~/…` home root is ALREADY under the user's home at segment 1, so its
//     first anchorable segment is segment 2 (`~/src/x.ts` is home structure and
//     collapses; `~/proj/…/tests/foo.ts` still anchors at the later `tests`);
//   - a plain `/…` root (any other top-level dir) can BE a repo anchor at
//     segment 1 itself, so a path rooted directly at a top-level dir keeps its
//     portable tail (`/src/x.ts` => `src/x.ts`, `/bin/y` => `bin/y` — CR round-3
//     finding 4), instead of over-redacting to `<local-path>`.
// Segment 0 is always the leading `/`-marker or `~` and is never anchorable.
// The §8 anchor `/a/src/b/src/c.ts` still resolves to `src/b/src/c.ts`: it is a
// plain root (firstAnchorable 1), segment 1 (`a`) is not a recognized top-level
// dir, and the scan lands on the first genuine `src/` at segment 2.
function repoRelativeOrPlaceholder(absPath: string): string {
  const segments = absPath.split("/");
  // Determine the first segment that may legitimately anchor a repo-relative
  // tail, per the root-form rules above.
  let firstAnchorable: number;
  if (segments[0] === "~") {
    // `~/…`: segment 1 is directly under the user's home (machine-local).
    firstAnchorable = 2;
  } else if (HOME_ROOTS.includes(segments[1])) {
    // `/Users`|`/home`|`/root`: segment 2 is the username (machine-local).
    firstAnchorable = 3;
  } else {
    // Plain `/…` root: segment 1 is itself a candidate repo top-level dir.
    firstAnchorable = 1;
  }
  for (let i = firstAnchorable; i < segments.length; i++) {
    if (REPO_TOP_LEVEL.includes(segments[i])) {
      return segments.slice(i).join("/");
    }
  }
  return "<local-path>";
}

// Apply E1 to a single string (used for both `content` and `provenance.source`
// per §3.1 E1). The leading boundary is a zero-width lookbehind (it consumes no
// preceding char), so the whole match IS the path — replace it in place.
function sanitizeMachineLocalPaths(input: string): string {
  return input.replace(MACHINE_LOCAL_PATH, (absPath: string) =>
    repoRelativeOrPlaceholder(absPath),
  );
}

// Apply E2 to a single string (content + provenance.source). Strip the
// "(session <uuid>)" clause first, then any remaining bare UUID token.
function sanitizeSessionUuids(input: string): string {
  return input.replace(SESSION_CLAUSE, "").replace(BARE_UUID, "");
}

/**
 * Sanitize environment-specific references out of an externally-visible
 * fragment. Pure and deterministic — no I/O, no LLM. Idempotent:
 * `sanitizeEnvRefs(sanitizeEnvRefs(x)) === sanitizeEnvRefs(x)`.
 *
 * @param content the fragment's externally-visible body (E1-E6 applied)
 * @param provenanceSource the fragment's provenance.source (E1 + E2 only —
 *   §3.1: provenance.source is externally persisted via toSeedEntryRow, so it
 *   gets machine-local-path + session-UUID stripping; E3-E6 are content-only)
 */
export function sanitizeEnvRefs(
  content: string,
  provenanceSource: string,
): { content: string; source: string } {
  // --- content: E1-E6 ---
  let out = content;

  // E3 Notion page ids/URLs (content only). Full-URL arm first (most specific),
  // then the notion.so/notion.com-context id, then the `/p/<id>` arm.
  //
  // ORDERING (crfix3): this block runs BEFORE E1 machine-local paths. A genuine
  // Notion `/p/<id>` link is a leading-`/` path with an interior `/`, so E1
  // would otherwise consume it as a machine-local path and collapse it to
  // <local-path> before the Notion arm ever saw it (the NOTION_P_ID arm was
  // effectively DEAD for its own bare-path input). Running the context-anchored
  // Notion arms first lets a real Notion link collapse to <notion-page-link>.
  //
  // The `/p/<id>` arm is CONTEXT-ANCHORED (crfix3 / spec OQ5): it fires only when
  // the string also carries a Notion marker, so a truly context-free `/p/<hex>`
  // (no Notion anywhere) is NOT corrupted here — it falls through to E1 and
  // collapses to <local-path> (no leaked id, no false Notion label). Without the
  // marker guard, ordering this arm before E1 would silently rewrite unrelated
  // `/p/...` route/path segments — the exact context-free strip OQ5 forbids.
  //
  // The marker is evaluated against the PRE-replacement ORIGINAL `content`, not
  // the already-partially-replaced `out` (CR round-4 finding). The gate's meaning
  // is "did this string carry Notion context ANYWHERE?" — a fact about the
  // original input. Testing the post-replacement `out` couples the gate's
  // correctness to whether the placeholder happens to still contain the word
  // "notion": if the only Notion marker was a notion.so URL that an earlier arm
  // already collapsed, and the placeholder carried no `notion` token, the gate
  // would wrongly read false and a genuine `/p/<id>` link would fall through to
  // E1 and be mislabeled <local-path>. Reading the original removes that coupling.
  //
  // Run BEFORE the generic E2 UUID strip so a dashed-UUID Notion id is collapsed
  // as a Notion link (not partially eaten by the bare-UUID arm).
  const hadNotionContext = NOTION_MARKER.test(content);
  out = out
    .replace(NOTION_URL, "<notion-page-link>")
    .replace(NOTION_CONTEXT_ID, "<notion-page-link>");
  if (hadNotionContext) {
    out = out.replace(NOTION_P_ID, "<notion-page-link>");
  }

  // E5 internal Railway hosts. Runs BEFORE E1 (and before E2). Before E1 (crfix7
  // F1): E5 emits `<internal-service>`, and a genuine machine-local path appended
  // to a railway host (`myapp.up.railway.app/Users/jpr5/x.ts` — after E5,
  // `<internal-service>/Users/jpr5/x.ts`) must be caught by E1, exactly as a path
  // appended to a Notion link is (E3 also runs before E1). If E1 ran first, that
  // appended path would be preceded by a host word char (`p` of `.app`), skipped,
  // and then orphaned after the emitted `>` with no later E1 pass — leaking the
  // username on the first pass (idempotence would silently "fix" it on a 2nd pass,
  // masking a real first-pass leak). Before E2: a dashed-UUID project id inside
  // `railway.app/project/<uuid>` is collapsed to <internal-service> as a whole,
  // rather than the bare-UUID arm eating the id and leaving `railway.app/project/`.
  out = out
    .replace(RAILWAY_PROJECT, "<internal-service>")
    .replace(RAILWAY_HOST, "<internal-service>");

  // E1 machine-local paths. Runs AFTER the Notion arms AND the Railway arm so a
  // genuine Notion `/p/<id>` is already collapsed and any machine-local path
  // appended to an emitted `<notion-page-link>`/`<internal-service>` placeholder is
  // caught here (crfix7 F1); a context-free `/p/<id>` (no Notion marker) reaches
  // here and collapses to <local-path>.
  out = sanitizeMachineLocalPaths(out);

  // E2 session UUIDs. Runs after the structural URL/host arms so it only sees
  // free-standing session UUIDs (in prose or a `(session <uuid>)` clause).
  out = sanitizeSessionUuids(out);

  // E4 internal Slack channels (closed allowlist).
  out = out.replace(SLACK_CHANNEL, "<internal-channel>");

  // E6 internal emails.
  out = out.replace(TEAM_EMAIL, "<team-member>");

  // --- provenance.source: E1 + E2 only (§3.1) ---
  const source = sanitizeSessionUuids(
    sanitizeMachineLocalPaths(provenanceSource),
  );

  return { content: out, source };
}
