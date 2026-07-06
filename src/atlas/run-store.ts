// Run-corpus IO for the Atlas harvest pipeline. Pure filesystem; NO DB.
//
// The Tier-1 leaf fleet (blitz agents) writes one CandidateFragment JSON file per
// unit into a run directory; the in-process pipeline (Tiers 2-3) reads them back.
// This module is that on-disk seam plus the run MANIFEST — which persists counts,
// timestamps, AND the run's FINAL exclusion-rule SET so the NEXT run can seed its
// approval-artifact Exclusion-Rules section from the prior run's rules (spec
// §11.5). Cross-run rule persistence lives here (written by sync, S17; read by
// generate, S16).
//
// On-disk layout (rooted at a caller-supplied runs directory):
//
//   <runsDir>/<run-id>/
//     manifest.json            ← RunManifest (counts, timestamps, ruleSet)
//     fragments/
//       <fragment-id>.json     ← one CandidateFragment
//
// Determinism: writes use stable JSON (2-space indent) and create parent
// directories on demand; reads sort fragment files lexically so `readFragments`
// is order-stable across platforms.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CandidateFragmentSchema,
  ClassificationSchema,
  type CandidateFragment,
} from "./types.js";

// ── Path-segment safety guard ─────────────────────────────────────────────────

// Both caller-supplied identifiers are joined into filesystem paths: the
// `runId` into the runs dir (`<runsDir>/<runId>/…`, via every store method) and
// the `fragmentId` into the fragments dir (`<fragmentsDir>/<id>.json`). A value
// containing a path separator, or one that IS the `.`/`..` segment, would read
// or write OUTSIDE that dir — and `readFragments` only scans the top level, so
// an escaped file would be silently lost. Validate the value is a SAFE single
// path segment (no `/`, `\`, not exactly `.` or `..`, and unchanged by
// `path.basename`) and throw a clear Error otherwise. An EMBEDDED `..` (e.g.
// "a..b") is a single safe segment and is accepted. Fail loud at the producer
// rather than escape silently.
function assertSafePathSegment(
  value: string,
  label: "runId" | "fragmentId",
): void {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    path.basename(value) !== value
  ) {
    throw new Error(
      `Unsafe ${label} "${value}": must be a single path segment ` +
        `(no '/' or '\\', and not '.' or '..' itself); ` +
        `refusing to escape the runs dir`,
    );
  }
}

// ── Exclusion-rule type ───────────────────────────────────────────────────────
//
// The manifest persists the run's final exclusion-rule SET. `ExclusionRule` is
// S13's canonical type (`src/atlas/exclude.ts`), re-exported here so the manifest
// and the exclusion engine share ONE type. (S13 is merged; the earlier structural
// placeholder used `dimension: string`, too loose to merge with exclude's
// `dimension: keyof Classification`.) The run-store only serializes/deserializes
// this shape.
import type { ExclusionRule } from "./exclude.js";
export type { ExclusionRule };

// Runtime mirror of S13's canonical `ExclusionRule` (`src/atlas/exclude.ts`):
// a discriminated union over `kind`. The `flag` variant's `dimension` is
// `keyof Classification`, derived here from `ClassificationSchema.keyof()` so it
// stays in lockstep with the contract (S0) — a manifest naming a non-existent
// dimension is rejected, not silently seeded into the next run (§11.5). The
// `english` variant carries the plain-text instruction. `z.infer` of this schema
// is structurally identical to `ExclusionRule`; the cast on parse asserts that.
//
// LOCKSTEP (mirror width): this schema is a HAND-KEPT mirror of exclude.ts's
// `ExclusionRule` union — only the `dimension` key-set tracks the contract
// automatically (via `ClassificationSchema.keyof()`); the union's variants and
// their fields do NOT. A variant/field added in exclude.ts and not here makes
// `readManifest` reject manifests sync legitimately wrote; one added only here
// is hidden by the `as RunManifest` cast on the read path. Change both
// declarations together.
const ExclusionRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("flag"),
    dimension: ClassificationSchema.keyof(),
    equals: z.string(),
  }),
  z.object({
    kind: z.literal("english"),
    text: z.string(),
  }),
]);

// Runtime schema for the persisted RunManifest. `readManifest` parses against
// this so a corrupt/old-format manifest fails loud (with its path) rather than
// poisoning the next run. `writeManifest`'s output round-trips through it.
const RunManifestSchema = z.object({
  runId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  fragmentCount: z.number(),
  ruleSet: z.array(ExclusionRuleSchema),
  // Run-completion marker (C.4). Present ONLY once a run's upsert loop has
  // finished successfully; their ABSENCE is the signal that a run is
  // partial/aborted (crashed mid-upsert, or a preview/dry-run that never
  // persisted). `completedAt` is the ISO-8601 stamp taken after the last
  // upsert; `upsertedCount` is the number of rows actually written. Optional
  // so a legitimately-incomplete manifest round-trips instead of failing loud.
  completedAt: z.string().optional(),
  upsertedCount: z.number().optional(),
});

// Thrown by `readManifest` when the on-disk manifest exists but is corrupt
// (invalid JSON) or schema-invalid. A DISTINCT class so `writeManifest`'s
// repair path can catch exactly these two cases and nothing else — a plain fs
// error (EACCES, EIO, …) is an environment problem, not corruption, and must
// propagate.
export class CorruptRunManifestError extends Error {}

// ── Run manifest ──────────────────────────────────────────────────────────────

// Persisted per run alongside the fragments. `ruleSet` is the run's FINAL
// exclusion-rule set (the prior-run rules + defaults + any edits the lead made on
// the Notion artifact), persisted so the next run seeds from it (§11.5).
export interface RunManifest {
  runId: string;
  // ISO-8601 timestamps. `createdAt` is set on first write; `updatedAt` advances
  // on every manifest write.
  createdAt: string;
  updatedAt: string;
  // Number of fragments written for this run (informational; the authoritative
  // count is `readFragments(runId).length`).
  fragmentCount: number;
  // The run's final exclusion-rule set, for next-run seeding (§11.5).
  ruleSet: ExclusionRule[];
  // Run-completion marker (C.4). Set ONLY on a successful upsert: `completedAt`
  // is the ISO-8601 stamp taken after the upsert loop, `upsertedCount` the
  // number of rows written. When BOTH are absent the run did not complete a
  // persist (crashed mid-upsert, or a preview/dry-run) — that absence is how a
  // partial run is told apart from a completed one.
  completedAt?: string;
  upsertedCount?: number;
}

// What a manifest write accepts. `createdAt`/`updatedAt` are managed by the store
// (callers never set timestamps); everything else is caller-supplied.
export type RunManifestInput = Omit<
  RunManifest,
  "createdAt" | "updatedAt" | "runId"
>;

// ── Store ──────────────────────────────────────────────────────────────────────

// Filesystem-backed run-corpus store. Construct with the root directory under
// which per-run directories live (e.g. `runs/` in the repo, or a tmp dir in
// tests). The `RunStore` interface referenced by the artifact sync slot (§4.9)
// is satisfied by this class.
export class RunStore {
  constructor(private readonly runsDir: string) {}

  // ── path helpers ──

  private runDir(runId: string): string {
    // Same traversal guard as fragmentId — every public method routes its
    // runId through here, so this is the single chokepoint.
    assertSafePathSegment(runId, "runId");
    return path.join(this.runsDir, runId);
  }

  private fragmentsDir(runId: string): string {
    return path.join(this.runDir(runId), "fragments");
  }

  private manifestPath(runId: string): string {
    return path.join(this.runDir(runId), "manifest.json");
  }

  // ── fragment IO ──

  // Write a single fragment under `<run-id>/fragments/<fragmentId>.json`. The
  // fragment is validated against the S0 schema before writing so a malformed
  // fragment fails loud at the producer rather than poisoning the pipeline. The
  // `fragmentId` is the file stem the caller controls (e.g. a content hash or a
  // leaf-unit id); it must be filesystem-safe. The write is exclusive (`wx`):
  // two parallel leaf agents writing the same fragmentId would otherwise
  // silently last-write-wins, losing a unit's fragment with zero signal — a
  // collision fails loud instead (fail-loud discipline).
  writeFragment(
    runId: string,
    fragmentId: string,
    fragment: CandidateFragment,
  ): void {
    assertSafePathSegment(fragmentId, "fragmentId");
    const parsed = CandidateFragmentSchema.parse(fragment);
    const dir = this.fragmentsDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${fragmentId}.json`);
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf-8",
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `[atlas/run-store] fragment id collision: run "${runId}" already has ` +
            `a fragment "${fragmentId}" (${filePath}). Either two parallel leaf ` +
            `agents produced the same fragment id, or a retried leaf is ` +
            `re-writing its own fragment — delete the file or use a fresh run id.`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  // Read all fragments for a run, validated against the S0 schema and returned in
  // a stable (lexically-sorted-by-filename) order. Returns `[]` if the run (or
  // its fragments dir) does not exist yet. A corrupt (bad-JSON) or
  // schema-invalid fragment fails loud WITH its file path (mirroring
  // `readManifest`) so the operator knows exactly which file to inspect, rather
  // than a pathless SyntaxError/ZodError.
  readFragments(runId: string): CandidateFragment[] {
    const dir = this.fragmentsDir(runId);
    if (!fs.existsSync(dir)) return [];
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    return files.map((file) => {
      const fullPath = path.join(dir, file);
      const raw = fs.readFileSync(fullPath, "utf-8");
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `Corrupt fragment at ${fullPath}: invalid JSON (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
      const result = CandidateFragmentSchema.safeParse(json);
      if (!result.success) {
        throw new Error(
          `Invalid fragment at ${fullPath}: ${result.error.message}`,
        );
      }
      return result.data;
    });
  }

  // ── manifest IO ──

  // Read the run manifest. Returns `undefined` if no manifest has been written
  // for the run (e.g. the very first run has no prior-run manifest to seed from).
  readManifest(runId: string): RunManifest | undefined {
    const file = this.manifestPath(runId);
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, "utf-8");
    // Parse + validate. A malformed (bad JSON) or schema-invalid manifest —
    // notably a bogus `ruleSet` — fails loud with the offending path rather than
    // returning a bad object that would poison the next run's seeding (§11.5).
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new CorruptRunManifestError(
        `Corrupt run manifest at ${file}: invalid JSON (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
    const result = RunManifestSchema.safeParse(json);
    if (!result.success) {
      throw new CorruptRunManifestError(
        `Invalid run manifest at ${file}: ${result.error.message}`,
      );
    }
    // `z.infer` of RunManifestSchema is structurally identical to RunManifest
    // (ExclusionRuleSchema mirrors exclude.ts's ExclusionRule); the cast asserts
    // the discriminated-union narrowing TS can't carry across `keyof()`.
    return result.data as RunManifest;
  }

  // Write (create or update) the run manifest. `createdAt` is preserved across
  // updates (set once, on first write); `updatedAt` advances to `now` on every
  // write. `runId` is taken from the argument, never the input body.
  writeManifest(
    runId: string,
    input: RunManifestInput,
    now: Date = new Date(),
  ): RunManifest {
    // Preserve `createdAt` from a prior manifest, but a corrupt/schema-invalid
    // existing manifest must NOT wedge the write: `readManifest` is fail-loud
    // (for read callers), so catch EXACTLY its corruption error here and treat
    // it as "no prior manifest" (use the new `createdAt`). This lets the write
    // API REPAIR a corrupt manifest rather than being unable to overwrite it —
    // loudly (warn names the path), and ONLY for corruption: any other fs
    // error (EACCES, EIO, …) propagates, since swallowing it would silently
    // reset `createdAt` over a manifest that was never actually read.
    let existing: RunManifest | undefined;
    try {
      existing = this.readManifest(runId);
    } catch (err) {
      if (!(err instanceof CorruptRunManifestError)) throw err;
      console.warn(
        `[atlas] repairing corrupt run manifest at ${this.manifestPath(runId)} (${err.message})`,
      );
      existing = undefined;
    }
    const iso = now.toISOString();
    // The completion-marker fields (C.4) are threaded through ONLY when the
    // caller supplies them, so an incomplete run's manifest omits the keys
    // entirely (their absence is the "did not complete" signal) rather than
    // carrying an explicit `undefined`.
    const manifest: RunManifest = {
      runId,
      createdAt: existing?.createdAt ?? iso,
      updatedAt: iso,
      fragmentCount: input.fragmentCount,
      ruleSet: input.ruleSet,
      ...(input.completedAt !== undefined
        ? { completedAt: input.completedAt }
        : {}),
      ...(input.upsertedCount !== undefined
        ? { upsertedCount: input.upsertedCount }
        : {}),
    };
    fs.mkdirSync(this.runDir(runId), { recursive: true });
    fs.writeFileSync(
      this.manifestPath(runId),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );
    return manifest;
  }
}
