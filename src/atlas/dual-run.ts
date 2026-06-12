// Phase-2 dual-run shadow gate (spec §6.2, §7.6 / T10).
//
// runDualRun compares two structured-output draws (runA, runB) for the SAME
// fragment-shaped target and produces a verdict the harness uses to decide
// whether Phase 2 may advance. The comparator has three precondition branches:
//
//   (a) seed-present (deterministic control): canonicalize both runs via
//       `canonicalizeFragment` and require byte-equality of the resulting
//       JSON.stringify. If they match → "match". Else → "diverge", with a
//       reason naming the FIRST diverging top-level field.
//
//   (b) no-seed but a relaxed comparator is available: compare structurally
//       — same top-level shape (same key set), enum fields byte-identical
//       at their real paths (the five classification enums nested under
//       `provenance.classification.*` — sensitivity, knowledge_type,
//       validation_status, confidence, provenance_class — plus top-level
//       `sourcetype` and per-item `evidence[].kind`), and free-text fields
//       (title, content) with similarity ≥ 0.95. Pass → "relaxed-match";
//       else → "diverge".
//       Similarity uses a simple word-set Jaccard (|A∩B| / |A∪B|) — chosen
//       over character-bigram cosine to avoid pulling in an extra dependency;
//       Jaccard is robust enough for the gate threshold and trivially
//       reproducible. See SIMILARITY_THRESHOLD below.
//
//   (c) neither available: "gated" — Phase 2 cannot advance.
//
// Verdicts are diagnostic, not destructive — the gate refuses to advance
// rather than dropping data.

import { canonicalizeFragment } from "./canonicalize.js";

// Classification enum fields whose values must be byte-identical in the
// no-seed relaxed branch. CandidateFragmentObject (src/atlas/types.ts) puts
// these FIVE under `provenance.classification.<field>` — they are NOT top-
// level on the fragment. Reading them at the wrong nesting level silently
// passes every check on a real fragment; M-1 fixed that.
const CLASSIFICATION_ENUM_FIELDS = [
  "sensitivity",
  "knowledge_type",
  "validation_status",
  "confidence",
  "provenance_class",
] as const;

// Free-text fields compared by similarity in the relaxed branch.
const TEXT_FIELDS = ["title", "content"] as const;

// Jaccard similarity threshold for the relaxed comparator — same threshold
// the spec calls for under the cosine framing; Jaccard is the equivalent
// set-overlap measure for our short, mostly-token-distinct strings.
const SIMILARITY_THRESHOLD = 0.95;

export type DualRunResult = "match" | "relaxed-match" | "diverge" | "gated";

export interface DualRunVerdict {
  result: DualRunResult;
  reason: string;
}

export interface DualRunOptions {
  runA: object;
  runB: object;
  seedAvailable: boolean;
  relaxedComparatorAvailable: boolean;
}

// Word-set Jaccard similarity in [0, 1]. Two empty strings are defined as
// identical (similarity 1) — they are byte-equal and the relaxed comparator
// has nothing to disagree about.
function jaccardSimilarity(a: string, b: string): number {
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    );
  const setA = tokens(a);
  const setB = tokens(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 1;
  return intersection / union;
}

// Find the first top-level field whose canonicalized JSON differs between
// runA and runB. Returns the field name, or null if the two are byte-equal
// at every top-level key (in which case they should also stringify equal).
function firstDivergingField(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string | null {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  // Sort for determinism — we want the SAME "first" field to be reported
  // regardless of object key-insertion order on either side.
  const sortedKeys = Array.from(keys).sort();
  for (const k of sortedKeys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return k;
  }
  return null;
}

export function runDualRun(opts: DualRunOptions): DualRunVerdict {
  const { runA, runB, seedAvailable, relaxedComparatorAvailable } = opts;

  // Branch (a): seed-present — strict byte-equality after canonicalize.
  if (seedAvailable) {
    const canonA = canonicalizeFragment(runA) as Record<string, unknown>;
    const canonB = canonicalizeFragment(runB) as Record<string, unknown>;
    if (JSON.stringify(canonA) === JSON.stringify(canonB)) {
      return {
        result: "match",
        reason: "seed-present byte-equality after canonicalize",
      };
    }
    const field = firstDivergingField(canonA, canonB);
    return {
      result: "diverge",
      reason: field
        ? `seed-present canonicalized runs diverge at field "${field}"`
        : "seed-present canonicalized runs diverge",
    };
  }

  // Branch (b): no-seed but relaxed comparator available.
  if (relaxedComparatorAvailable) {
    const a = runA as Record<string, unknown>;
    const b = runB as Record<string, unknown>;

    // Shape compat: same top-level key set. Schema validation happened
    // upstream, so we only need to confirm the two runs are comparing the
    // same field surface.
    const keysA = new Set(Object.keys(a));
    const keysB = new Set(Object.keys(b));
    if (keysA.size !== keysB.size) {
      return {
        result: "diverge",
        reason: `no-seed relaxed: top-level key sets differ in size (${keysA.size} vs ${keysB.size})`,
      };
    }
    for (const k of keysA) {
      if (!keysB.has(k)) {
        return {
          result: "diverge",
          reason: `no-seed relaxed: key "${k}" missing on runB`,
        };
      }
    }

    // Classification enum fields: byte-identical, read at the REAL nested
    // path `provenance.classification.<field>`. A future regression that
    // moved them top-level (or renamed `classification`) would re-trip the
    // both-missing rule below and surface as `diverge`, not a silent pass.
    const classA =
      ((a.provenance as Record<string, unknown> | undefined)?.classification as
        | Record<string, unknown>
        | undefined) ?? {};
    const classB =
      ((b.provenance as Record<string, unknown> | undefined)?.classification as
        | Record<string, unknown>
        | undefined) ?? {};
    for (const field of CLASSIFICATION_ENUM_FIELDS) {
      const hasA = field in classA;
      const hasB = field in classB;
      // M-5: schema requires every classification enum present on every
      // valid fragment; both-missing means at least one side is malformed,
      // which is a structural divergence from the contract.
      if (!hasA && !hasB) {
        return {
          result: "diverge",
          reason: `no-seed relaxed: classification enum "${field}" missing on both sides`,
        };
      }
      if (JSON.stringify(classA[field]) !== JSON.stringify(classB[field])) {
        return {
          result: "diverge",
          reason: `no-seed relaxed: classification enum "${field}" differs`,
        };
      }
    }

    // Top-level `sourcetype` enum: also covered by spec §7.6. Per the M-5 /
    // T-R3-1 / T-R3-2 "both-missing → diverge" precedent, `sourcetype` is a
    // REQUIRED structural enum on CandidateFragmentObject (no .optional(), no
    // .default()). Without an explicit both-missing guard, the JSON.stringify
    // compare below collapses to `undefined === undefined` and silent-passes.
    const hasSourcetypeA = "sourcetype" in a;
    const hasSourcetypeB = "sourcetype" in b;
    if (!hasSourcetypeA && !hasSourcetypeB) {
      return {
        result: "diverge",
        reason: `no-seed relaxed: enum field "sourcetype" missing on both sides`,
      };
    }
    if (JSON.stringify(a.sourcetype) !== JSON.stringify(b.sourcetype)) {
      return {
        result: "diverge",
        reason: `no-seed relaxed: enum field "sourcetype" differs`,
      };
    }

    // Per-item `evidence[].kind` enum: both sides must have the same number
    // of evidence items AND the same `kind` discriminant at each index. A
    // length or kind mismatch is a structural enum divergence; positional
    // alignment matches the per-index canonicalize ordering.
    //
    // T-R3-2: extension of the M-5 "both-missing → diverge" precedent. The
    // schema declares `evidence: z.array(...).default([])` — i.e. AFTER parse
    // it is always an array. The comparator receives `object` (untyped) and
    // serves as the structural pin against malformation that bypasses the
    // parser. If both sides are missing/non-array, the prior `?? []` fallback
    // would collapse both to length-0 and silently pass — that is the silent
    // pass on a malformed shape M-5 codified against. Diverge instead.
    const evAArray = Array.isArray(a.evidence);
    const evBArray = Array.isArray(b.evidence);
    // T-R4-1: ASYMMETRIC mixed-shape XOR. When one side is an array and the
    // other is not, the prior `?? []` fallback collapsed the non-array side
    // to length-0 and silently relaxed-matched against a well-formed empty
    // array on the other side. Per spec §7.6, structurally different
    // evidence shapes must diverge — check XOR BEFORE the both-missing
    // branch so the asymmetric class is closed.
    if (evAArray !== evBArray) {
      return {
        result: "diverge",
        reason:
          "no-seed relaxed: evidence shape mismatch (one side is not an array)",
      };
    }
    if (!evAArray && !evBArray) {
      return {
        result: "diverge",
        reason: "no-seed relaxed: evidence array missing on both sides",
      };
    }
    // Both arrays at this point — proceed with length + per-index check.
    const evA = a.evidence as unknown[];
    const evB = b.evidence as unknown[];
    if (evA.length !== evB.length) {
      return {
        result: "diverge",
        reason: `no-seed relaxed: evidence array length differs (${evA.length} vs ${evB.length})`,
      };
    }
    for (let i = 0; i < evA.length; i += 1) {
      const kA = (evA[i] as Record<string, unknown> | undefined)?.kind;
      const kB = (evB[i] as Record<string, unknown> | undefined)?.kind;
      if (JSON.stringify(kA) !== JSON.stringify(kB)) {
        return {
          result: "diverge",
          reason: `no-seed relaxed: evidence[${i}].kind differs`,
        };
      }
    }

    // Free-text fields: Jaccard similarity ≥ threshold.
    //
    // T-R3-1: extension of the M-5 "both-missing → diverge" precedent.
    // CandidateFragmentObject declares `title: z.string()` and
    // `content: z.string()` — both REQUIRED (no `.default()`, no
    // `.optional()`). When BOTH sides have a missing/non-string value, the
    // prior empty-string fallback would produce two empty token sets, the
    // jaccard function returns 1.0 for two empty strings, and the relaxed
    // branch silently matched on a structurally-malformed pair. Pre-check
    // for both-missing on each required text field and diverge BEFORE
    // hitting the similarity fallback.
    for (const field of TEXT_FIELDS) {
      const aIsString = typeof a[field] === "string";
      const bIsString = typeof b[field] === "string";
      // T-R4-2: ASYMMETRIC mixed-shape XOR. When one side has a valid
      // (possibly empty) string and the other side is non-string, the prior
      // `?? ""` fallback collapsed the non-string side to `""` and
      // Jaccard("", "") = 1.0 silently relaxed-matched a structurally
      // divergent pair. Per spec §7.6 + the schema's required `z.string()`
      // declaration, shape-mismatch must diverge — check XOR BEFORE the
      // both-missing branch so the asymmetric class is closed.
      if (aIsString !== bIsString) {
        return {
          result: "diverge",
          reason: `no-seed relaxed: text field "${field}" shape mismatch (one side is not a string)`,
        };
      }
      if (!aIsString && !bIsString) {
        return {
          result: "diverge",
          reason: `no-seed relaxed: text field "${field}" missing on both sides`,
        };
      }
      // Both strings at this point — proceed with Jaccard similarity.
      const ta = a[field] as string;
      const tb = b[field] as string;
      const sim = jaccardSimilarity(ta, tb);
      if (sim < SIMILARITY_THRESHOLD) {
        return {
          result: "diverge",
          reason: `no-seed relaxed: text field "${field}" similarity ${sim.toFixed(3)} < ${SIMILARITY_THRESHOLD}`,
        };
      }
    }

    return {
      result: "relaxed-match",
      reason:
        "no-seed relaxed: shape + enums equal, text similarity above threshold",
    };
  }

  // Branch (c): neither precondition met — gate refuses to advance.
  return {
    result: "gated",
    reason:
      "neither seed control nor relaxed comparator is available; Phase 2 cannot advance",
  };
}
