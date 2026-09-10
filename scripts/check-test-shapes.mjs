#!/usr/bin/env node
// Fail on test shapes that pass even when the production line they cover is
// reverted. Run as: node scripts/check-test-shapes.mjs
// Used by: static-quality CI. Also useful locally before pushing tests.
//
// Every rule here was earned by an actual vacuous test found in review, and
// every rule is a SHAPE, not a heuristic guess at intent: each one describes a
// construct that is either unconditionally true or silently skipped in exactly
// the failure case the test was written to catch.
//
// Parsing is done with the TypeScript AST rather than regex, because regex
// cannot tell `if (x) { expect(...) }` from `if (x) { ... } else { ... }`, nor a
// string in a comment from a string in an assertion.
//
// Escape hatches (a rule with no escape hatch gets deleted rather than obeyed):
//
//   // check-test-shapes-ignore-next-line <rule-id> — <reason>
//   // check-test-shapes-ignore-file <rule-id> — <reason>
//
// A reason is REQUIRED; a bare ignore comment is itself reported, so "silence
// it and move on" costs the same keystrokes as explaining why.
//
// Pre-existing violations live in check-test-shapes.baseline.json as a per-file
// count ratchet: the count may fall, never rise. Regenerate with
// `--update-baseline` ONLY after actually removing violations.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(REPO_ROOT, "src", "__tests__");
const BASELINE_PATH = join(
  REPO_ROOT,
  "scripts",
  "check-test-shapes.baseline.json",
);

const IGNORE_NEXT_LINE = "check-test-shapes-ignore-next-line";
const IGNORE_FILE = "check-test-shapes-ignore-file";

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/** Source text of a node, whitespace-collapsed, for identity comparisons. */
function textOf(node) {
  return node.getText().replace(/\s+/g, " ").trim();
}

/** The callee name of a call expression: `expect`, `foo.bar` -> `bar`, else "". */
function calleeName(node) {
  if (!ts.isCallExpression(node)) return "";
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
}

/** Walk up to the nearest enclosing `it(...)` / `test(...)` call, or null. */
const TEST_CALLEES = new Set(["it", "test", "fit", "xit"]);
function enclosingTest(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      // Matches `it(...)`, `it.each(...)(...)`, `it.only(...)`, `test(...)`.
      const root = ts.isIdentifier(e)
        ? e.text
        : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)
          ? e.expression.text
          : ts.isCallExpression(e) &&
              ts.isPropertyAccessExpression(e.expression)
            ? textOf(e.expression.expression)
            : "";
      if (TEST_CALLEES.has(root)) return n;
    }
  }
  return null;
}

/** Every descendant of `root` for which `pred` holds. */
function collect(root, pred) {
  const out = [];
  (function walk(n) {
    if (pred(n)) out.push(n);
    n.forEachChild(walk);
  })(root);
  return out;
}

/**
 * The `expect(x)` call at the head of the chain `expect(x).not.toBe(y)`, given
 * any node inside that chain, or null.
 *
 * Walking straight up the parent chain is NOT enough, and getting this wrong
 * silently disables every rule that uses it: in `expect(a).toEqual(b)` the
 * `expect(a)` call is a CHILD of the `.toEqual` property access, so a node
 * inside `b` never has it as an ancestor. So for each ancestor call, descend
 * its leftmost callee spine looking for the `expect` head.
 */
function expectHeadOf(node) {
  for (let n = node; n; n = n.parent) {
    if (!ts.isCallExpression(n)) continue;
    let spine = n;
    while (spine) {
      if (ts.isCallExpression(spine)) {
        if (
          ts.isIdentifier(spine.expression) &&
          spine.expression.text === "expect"
        ) {
          return spine;
        }
        spine = spine.expression;
      } else if (
        ts.isPropertyAccessExpression(spine) ||
        ts.isElementAccessExpression(spine)
      ) {
        spine = spine.expression;
      } else break;
    }
  }
  return null;
}

/** The matcher names applied to an `expect(...)` head, e.g. ["not","toBe"]. */
function matcherChain(expectCall) {
  const names = [];
  for (let n = expectCall.parent; n; n = n.parent) {
    if (ts.isPropertyAccessExpression(n)) names.push(n.name.text);
    else if (!ts.isCallExpression(n)) break;
  }
  return names;
}

/**
 * The assertion applied to an `expect(...)` head, as
 * `{ negated, matcher, args }` — e.g. `expect(x).not.toBe(null)` gives
 * `{ negated: true, matcher: "toBe", args: [null] }`.
 */
function assertionOf(expectCall) {
  const chain = matcherChain(expectCall);
  const negated = chain.includes("not");
  const matcher = chain.filter((m) => m !== "not").at(-1) ?? "";
  let args = [];
  for (let n = expectCall.parent; n; n = n.parent) {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === matcher
    ) {
      args = [...n.arguments];
      break;
    }
    if (!ts.isCallExpression(n) && !ts.isPropertyAccessExpression(n)) break;
  }
  return { negated, matcher, args };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Is `node` a literal that is definitely truthy? */
function isTruthyLiteral(node) {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (ts.isStringLiteral(node)) return node.text.length > 0;
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0;
  return (
    ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
  );
}

/**
 * Does this assertion establish that its subject EXISTS? A preceding one makes
 * a later truthiness `if` a narrowing convenience rather than a silent skip —
 * because the assertion itself already fails in the case the `if` would skip.
 *
 * `expect(r.ok).toBe(true)` before `if (r.ok)` is the common sound form and
 * MUST NOT be flagged; missing it was the rule's first false-positive class.
 */
function establishesExistence({ negated, matcher, args }) {
  if (negated) {
    return ["toBeNull", "toBeUndefined", "toBeFalsy"].includes(matcher);
  }
  if (
    ["toBeDefined", "toBeTruthy", "toBeInstanceOf", "toHaveLength"].includes(
      matcher,
    )
  ) {
    return true;
  }
  if (["toBeGreaterThan", "toBeGreaterThanOrEqual"].includes(matcher))
    return true;
  if (["toBe", "toEqual", "toStrictEqual"].includes(matcher)) {
    return args.length > 0 && isTruthyLiteral(args[0]);
  }
  return false;
}

/** Does `condition` merely test that something exists (vs. compare a value)? */
function isExistenceCondition(node) {
  if (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node)
  ) {
    return true;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    const nullish = (n) =>
      n.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(n) && n.text === "undefined");
    const isInequality =
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (isInequality && (nullish(node.right) || nullish(node.left)))
      return true;
  }
  return false;
}

/** The subject of an existence condition, for matching against assertions. */
function conditionSubject(node) {
  if (ts.isBinaryExpression(node)) {
    const nullish = (n) =>
      n.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(n) && n.text === "undefined");
    return textOf(nullish(node.right) ? node.left : node.right);
  }
  return textOf(node);
}

const ruleBareConditionalExpect = {
  id: "bare-conditional-expect",
  describe:
    "`if (x) { expect(...) }` with no `else` and no preceding existence " +
    "assertion: when `x` is null — exactly the regression the test guards — " +
    "the assertion never runs and the test passes anyway. Assert that `x` " +
    "exists first, or add an `else { expect.fail(...) }`.",
  visit(node, report) {
    if (!ts.isIfStatement(node) || node.elseStatement) return;
    if (!isExistenceCondition(node.expression)) return;

    const asserts = collect(
      node.thenStatement,
      (n) => ts.isCallExpression(n) && calleeName(n) === "expect",
    );
    if (asserts.length === 0) return;

    const test = enclosingTest(node);
    if (!test) return;

    // Anything that establishes existence BEFORE this `if` — an existence
    // matcher, or a hand-rolled `if (!x) throw` / `assert(x)` guard.
    const subject = conditionSubject(node.expression);
    // `node.pos` includes leading trivia, so it EQUALS the previous
    // statement's end — a `<` comparison against it silently misses an
    // immediately-preceding guard. Compare against the real token start.
    const ifStart = node.getStart();
    const establishes = (name) =>
      subject === name ||
      subject.startsWith(`${name}.`) ||
      subject.startsWith(`${name}?.`) ||
      subject.startsWith(`${name}[`);

    const priorExistenceAssertion = collect(
      test,
      (n) =>
        ts.isCallExpression(n) &&
        calleeName(n) === "expect" &&
        n.end <= ifStart &&
        establishesExistence(assertionOf(n)) &&
        n.arguments.length > 0 &&
        establishes(textOf(n.arguments[0])),
    );
    if (priorExistenceAssertion.length > 0) return;

    // A hand-rolled guard: `if (!label) throw ...` / `assert(label)` before the
    // narrowing `if`. Same soundness as an existence assertion — the test
    // cannot reach the `if` with a missing subject.
    const bails = (stmt) =>
      collect(
        stmt,
        (t) =>
          ts.isThrowStatement(t) ||
          (ts.isCallExpression(t) && /^(fail|error)$/.test(calleeName(t))),
      ).length > 0;

    const priorGuard = collect(
      test,
      (n) =>
        n.end <= ifStart &&
        ((ts.isIfStatement(n) &&
          ts.isPrefixUnaryExpression(n.expression) &&
          n.expression.operator === ts.SyntaxKind.ExclamationToken &&
          establishes(textOf(n.expression.operand)) &&
          bails(n.thenStatement)) ||
          (ts.isCallExpression(n) &&
            /^(assert|invariant|assertDefined)$/.test(calleeName(n)) &&
            n.arguments.length > 0 &&
            establishes(textOf(n.arguments[0])))),
    );
    if (priorGuard.length > 0) return;

    report(node, `if (${subject}) { expect(...) } with no else`);
  },
};

const ruleNanComparatorInAssertion = {
  id: "nan-comparator-in-assertion",
  describe:
    "A sort comparator inside an assertion whose operands are non-null-" +
    "asserted (`b! - a!`) or optionally-chained. On a null element the " +
    "comparator returns NaN, `Array#sort` treats that as 'equal', the array " +
    "comes back unchanged, and the assertion holds no matter what the " +
    "production code did. Coerce the operands (`(b ?? 0) - (a ?? 0)`) or " +
    "assert the elements are non-null first.",
  visit(node, report) {
    if (!ts.isCallExpression(node)) return;
    if (calleeName(node) !== "sort" || node.arguments.length === 0) return;
    if (!expectHeadOf(node)) return; // only inside an assertion

    const comparator = node.arguments[0];
    if (
      !ts.isArrowFunction(comparator) &&
      !ts.isFunctionExpression(comparator)
    ) {
      return;
    }
    const unsafeOperands = collect(
      comparator.body,
      (n) =>
        ts.isNonNullExpression(n) ||
        (ts.isPropertyAccessExpression(n) && n.questionDotToken) ||
        (ts.isElementAccessExpression(n) && n.questionDotToken),
    );
    if (unsafeOperands.length === 0) return;

    report(node, `sort comparator ${textOf(comparator)} can return NaN`);
  },
};

const ruleSoleIsFiniteAssertion = {
  id: "sole-isfinite-assertion",
  describe:
    "`Number.isFinite(x)` as a test's ONLY assertion. It passes for 0, for " +
    "-1, and for every wrong-but-numeric value, so it cannot distinguish a " +
    "correct coercion from a broken one. Assert the expected value too.",
  visit(node, report) {
    if (!ts.isCallExpression(node)) return;
    const e = node.expression;
    const isIsFinite =
      ts.isPropertyAccessExpression(e) &&
      e.name.text === "isFinite" &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === "Number";
    if (!isIsFinite) return;
    if (!expectHeadOf(node)) return;

    const test = enclosingTest(node);
    if (!test) return;
    const allExpects = collect(
      test,
      (n) => ts.isCallExpression(n) && calleeName(n) === "expect",
    );
    if (allExpects.length !== 1) return;

    report(node, "Number.isFinite is this test's only assertion");
  },
};

const ruleAsNeverInTests = {
  id: "as-never-in-test",
  describe:
    "`as never` in a test. It does not narrow a type, it ERASES the check: " +
    "the compiler stops verifying that the double actually has the members " +
    "the code under test calls, so a mock missing a method type-checks and " +
    "fails only at runtime — or, worse, passes because the missing call was " +
    'never reached. Type the double (e.g. `Pick<Server, "tool">`) instead.',
  visit(node, report) {
    if (!ts.isAsExpression(node)) return;
    if (node.type.kind !== ts.SyntaxKind.NeverKeyword) return;
    report(node, `${textOf(node.expression)} as never`);
  },
};

/**
 * `not.toContain("literal")` is a tautology when the literal appears nowhere in
 * production source: nothing could ever have produced it. Loaded lazily so the
 * src/ scan costs nothing when no candidate exists.
 */
let productionSourceCache = null;
function productionSource() {
  if (productionSourceCache === null) {
    const parts = [];
    for (const file of walkTs(join(REPO_ROOT, "src"))) {
      if (file.includes(`${join("src", "__tests__")}`)) continue;
      parts.push(readFileSync(file, "utf-8"));
    }
    productionSourceCache = parts.join("\n");
  }
  return productionSourceCache;
}

const ruleTautologicalNotToContain = {
  id: "tautological-not-tocontain",
  describe:
    '`not.toContain("<literal>")` where the literal exists NOWHERE except ' +
    "inside that one assertion — not in production source, and not anywhere " +
    "else in the test file. Nothing can emit a string that no code and no " +
    "fixture contains, so the assertion is true by construction and would " +
    "stay true with the feature deleted. Assert against the string production " +
    "actually emits, or feed the literal in as input so the assertion has " +
    "something real to rule out.\n" +
    "Deliberately NOT flagged: a literal the test itself supplies as input " +
    "(a connection string handed to a redactor, an error message a mock " +
    "throws). Those are grounded assertions even though src/ never mentions " +
    "the string.",
  visit(node, report) {
    if (!ts.isCallExpression(node)) return;
    if (calleeName(node) !== "toContain" || node.arguments.length !== 1) return;

    const arg = node.arguments[0];
    if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
      return;
    }
    const expectCall = expectHeadOf(node);
    if (!expectCall) return;
    if (!matcherChain(expectCall).includes("not")) return;

    const literal = arg.text;
    if (literal.length === 0) return;
    // Pure punctuation / control characters (`"\f"`, `"\n\n\n"`, `"�"`)
    // cannot be grounded by searching source text — the file spells them as
    // escapes while the AST hands back the decoded character — so say nothing
    // rather than guess.
    if (!/[A-Za-z0-9]/.test(literal)) return;
    if (productionSource().includes(literal)) return;

    // Is the literal GROUNDED — could anything have produced it? Production
    // composes strings ("## " + sourceName, dir + "/" + file), so an exact
    // whole-literal search is far too strict: `not.toContain("## slack-empty")`
    // is a real assertion even though only `slack-empty` appears verbatim.
    // So require every meaningful TOKEN to be unaccounted for. What is left
    // after that is a literal no code and no fixture supplies any part of.
    const fileText = node.getSourceFile().text;
    const tokens = literal
      .split(/[^A-Za-z0-9_.:-]+/)
      .filter((t) => t.length >= 2);
    if (tokens.length > 0) {
      const grounded = tokens.every(
        (t) =>
          fileText.split(t).length - 1 > 1 || productionSource().includes(t),
      );
      if (grounded) return;
    }

    report(
      node,
      `not.toContain(${JSON.stringify(literal)}) — literal exists nowhere but this assertion`,
    );
  },
};

/**
 * `vi.clearAllMocks()` in a file that also queues `*Once` values.
 * `clearAllMocks` clears the CALL LOG but NOT the once-queue, so a queued value
 * its own test never consumed is handed to whichever later test calls the mock
 * next. See the note in vitest.config.ts: this is why `mockReset: true` is not
 * on repo-wide (it breaks 243 pre-existing tests), and why the invariant is
 * enforced here instead.
 */
const ruleClearAllMocksWithOnce = {
  id: "clear-all-mocks-with-once",
  describe:
    "`vi.clearAllMocks()` in a file that queues `mockResolvedValueOnce` / " +
    "`mockReturnValueOnce` / `mockImplementationOnce` values. `clearAllMocks` " +
    "drains the call log but NOT the once-queue, so a queued value that its " +
    "own test never consumed leaks into a later test's first call. Use " +
    "`vi.resetAllMocks()` (or `mock.mockReset()`) instead, which drains both.",
  visit(node, report) {
    if (!ts.isCallExpression(node)) return;
    if (calleeName(node) !== "clearAllMocks") return;

    const file = node.getSourceFile();
    const queuesOnce = collect(
      file,
      (n) =>
        ts.isCallExpression(n) &&
        /^mock(ResolvedValue|RejectedValue|ReturnValue|Implementation)Once$/.test(
          calleeName(n),
        ),
    );
    if (queuesOnce.length === 0) return;

    report(
      node,
      `vi.clearAllMocks() alongside ${queuesOnce.length} *Once() value(s)`,
    );
  },
};

const RULES = [
  ruleBareConditionalExpect,
  ruleNanComparatorInAssertion,
  ruleSoleIsFiniteAssertion,
  ruleAsNeverInTests,
  ruleTautologicalNotToContain,
  ruleClearAllMocksWithOnce,
];

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

/** Ignore directives in a file, as `{ nextLine: Map<line, Set<rule>>, file: Set<rule>, bare: [] }`. */
function parseIgnores(text) {
  const nextLine = new Map();
  const file = new Set();
  const bare = [];
  const lines = text.split("\n");
  // The trailing group is optional so that a directive with NO rule and NO
  // reason still MATCHES — and is therefore reported as a bare ignore rather
  // than silently doing nothing.
  const directive = new RegExp(
    `//\\s*(${IGNORE_NEXT_LINE}|${IGNORE_FILE})\\b\\s*([\\w-]+)?\\s*(.*)$`,
  );
  const isCommentOrBlank = (line) => {
    const t = line.trim();
    return (
      t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    );
  };

  lines.forEach((line, i) => {
    const m = directive.exec(line);
    if (!m) return;
    const [, kind, rule, rest] = m;
    const reason = (rest ?? "").replace(/^[—\-:]+\s*/, "").trim();
    if (!rule || !reason) {
      bare.push({ line: i + 1, text: line.trim() });
      return;
    }
    if (kind === IGNORE_FILE) {
      file.add(rule);
      return;
    }
    // "Next line" means the next line of CODE, not literally i+2: a reason long
    // enough to be worth writing wraps onto following comment lines, and an
    // off-by-a-wrapped-line directive that silently stops working is exactly how
    // a check earns a reputation for being unusable.
    let target = i + 1;
    while (target < lines.length && isCommentOrBlank(lines[target]))
      target += 1;
    target += 1; // to 1-based
    if (!nextLine.has(target)) nextLine.set(target, new Set());
    nextLine.get(target).add(rule);
  });
  return { nextLine, file, bare };
}

function checkFile(absPath) {
  const text = readFileSync(absPath, "utf-8");
  const rel = relative(REPO_ROOT, absPath);
  const sourceFile = ts.createSourceFile(
    absPath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const ignores = parseIgnores(text);
  const findings = [];

  const visit = (node) => {
    for (const rule of RULES) {
      if (ignores.file.has(rule.id)) continue;
      rule.visit(node, (at, detail) => {
        const line =
          sourceFile.getLineAndCharacterOfPosition(at.getStart(sourceFile))
            .line + 1;
        if (ignores.nextLine.get(line)?.has(rule.id)) return;
        findings.push({ rule: rule.id, file: rel, line, detail });
      });
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  const bare = ignores.bare.map((b) => ({
    rule: "bare-ignore-directive",
    file: rel,
    line: b.line,
    detail: `${b.text} — an ignore needs a rule id AND a reason`,
  }));

  return [...bare, ...findings];
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  } catch {
    return { rules: {} };
  }
}

function toCounts(findings) {
  const counts = {};
  for (const f of findings) {
    counts[f.rule] ??= {};
    counts[f.rule][f.file] = (counts[f.rule][f.file] ?? 0) + 1;
  }
  return counts;
}

/**
 * Verify the CHECKER, against the fixtures, before trusting its verdict.
 *
 * This is not ceremony. Twice while writing these rules a helper bug
 * (`expectHeadOf` not descending the callee spine; `node.pos` including leading
 * trivia) silently disabled whole rules — the check still printed a clean ✓.
 * A quality gate that can pass while doing nothing is worse than no gate, so CI
 * runs this first: every rule must still fire on its known-bad shape, and none
 * may fire on the near-miss it must tolerate.
 */
function selfTest() {
  const dir = join(REPO_ROOT, "scripts", "__fixtures__", "check-test-shapes");
  const positives = "true-positives.fixture.ts";
  const findings = [...walkTs(dir)].flatMap(checkFile);

  const failures = [];
  for (const f of findings) {
    if (!f.file.endsWith(positives)) {
      failures.push(
        `false positive: ${f.rule} fired on a near-miss negative at ${f.file}:${f.line} (${f.detail})`,
      );
    }
  }
  const expected = [...RULES.map((r) => r.id), "bare-ignore-directive"];
  for (const id of expected) {
    if (!findings.some((f) => f.rule === id && f.file.endsWith(positives))) {
      failures.push(
        `silently disabled: ${id} did not fire on its true-positive fixture`,
      );
    }
  }

  if (failures.length > 0) {
    console.log("❌ check-test-shapes self-test FAILED");
    for (const f of failures) console.log(`   ${f}`);
    return 1;
  }
  console.log(
    `✓ Self-test passed: ${expected.length} rules each fire on their true-positive fixture and none fire on the near-miss negatives.`,
  );
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes("--update-baseline");
  const explain = args.includes("--explain");

  if (args.includes("--self-test")) return selfTest();

  if (explain) {
    for (const rule of RULES) {
      console.log(`\n${rule.id}\n  ${rule.describe.replace(/\n/g, "\n  ")}`);
    }
    return 0;
  }

  // Explicit file arguments make the check usable on a fixture dir.
  const targets = args.filter((a) => !a.startsWith("--"));
  const files = targets.length
    ? targets.flatMap((t) => (statSync(t).isDirectory() ? [...walkTs(t)] : [t]))
    : [...walkTs(TEST_DIR)];

  const findings = files.flatMap(checkFile);
  const counts = toCounts(findings);

  if (updateBaseline) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          $comment:
            "Pre-existing violations of scripts/check-test-shapes.mjs, as a " +
            "per-file count RATCHET: a count may fall, never rise. Do not add " +
            "entries by hand — fix the tests, then rerun with " +
            "--update-baseline. A file absent here must have zero violations.",
          rules: counts,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Baseline written: ${relative(REPO_ROOT, BASELINE_PATH)}`);
    return 0;
  }

  const baseline = targets.length ? { rules: {} } : loadBaseline();
  const regressions = [];
  const loosened = [];

  for (const [ruleId, perFile] of Object.entries(counts)) {
    for (const [file, count] of Object.entries(perFile)) {
      const allowed = baseline.rules?.[ruleId]?.[file] ?? 0;
      if (count > allowed) {
        regressions.push({ ruleId, file, count, allowed });
      }
    }
  }
  for (const [ruleId, perFile] of Object.entries(baseline.rules ?? {})) {
    for (const [file, allowed] of Object.entries(perFile)) {
      const count = counts[ruleId]?.[file] ?? 0;
      if (count < allowed) loosened.push({ ruleId, file, count, allowed });
    }
  }

  const byRule = new Map();
  for (const r of regressions) {
    if (!byRule.has(r.ruleId)) byRule.set(r.ruleId, []);
    byRule.get(r.ruleId).push(r);
  }

  for (const [ruleId, rows] of byRule) {
    const rule = RULES.find((r) => r.id === ruleId);
    console.log(`\n❌ ${ruleId}`);
    if (rule) console.log(`   ${rule.describe.replace(/\n/g, "\n   ")}`);
    for (const row of rows) {
      const sites = findings.filter(
        (f) => f.rule === ruleId && f.file === row.file,
      );
      const over = row.count - row.allowed;
      console.log(
        `   ${row.file}: ${row.count} violation(s), ${row.allowed} allowed by baseline (+${over})`,
      );
      for (const s of sites)
        console.log(`     ${s.file}:${s.line}  ${s.detail}`);
    }
    console.log(
      `   Silence one justified site with: // ${IGNORE_NEXT_LINE} ${ruleId} — <reason>`,
    );
  }

  if (loosened.length > 0) {
    console.log(
      "\nℹ️  Baseline is now looser than reality — tighten it with `node scripts/check-test-shapes.mjs --update-baseline`:",
    );
    for (const l of loosened) {
      console.log(
        `   ${l.ruleId} ${l.file}: ${l.count} actual vs ${l.allowed} allowed`,
      );
    }
  }

  if (regressions.length > 0) {
    const total = regressions.reduce((n, r) => n + (r.count - r.allowed), 0);
    console.log(
      `\n${total} new test-shape violation(s) across ${byRule.size} rule(s) in ${files.length} file(s).`,
    );
    return 1;
  }

  console.log(
    `✓ No new test-shape violations (${files.length} files, ${RULES.length} rules, ${findings.length} baselined).`,
  );
  return 0;
}

process.exit(main());
