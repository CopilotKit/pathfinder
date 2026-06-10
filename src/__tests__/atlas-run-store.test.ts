// Unit tests for the Atlas run-store (S2). Pure filesystem, no DB.
//
// Covers: fragment write/read round-trip (order-stable), empty-run reads, and the
// run MANIFEST round-trip INCLUDING the final exclusion-rule SET (§11.5) plus
// createdAt/updatedAt timestamp management. All IO is against a throwaway tmp dir
// (`fs.mkdtemp`), torn down per test, following the repo's workspace.test.ts idiom.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  RunStore,
  type ExclusionRule,
  type RunManifestInput,
} from "../atlas/run-store.js";
import type { CandidateFragment } from "../atlas/types.js";

function fragment(
  overrides: Partial<CandidateFragment> = {},
): CandidateFragment {
  return {
    sourcetype: "github-pr",
    subsystem: "atlas",
    source_name: "CopilotKit/pathfinder",
    title: "default claim",
    content: "why/how prose",
    provenance: {
      source: "github",
      classification: {
        sensitivity: "public",
        knowledge_type: "architecture",
        audience: "all-staff",
        validation_status: "unverified",
        confidence: "medium",
        provenance_class: "primary",
        freshness: { as_of: "2026-06-08" },
      },
    },
    evidence: [],
    needsReview: false,
    validationTargets: [],
    ...overrides,
  };
}

describe("RunStore", () => {
  let runsDir: string;
  let store: RunStore;
  const runId = "run-2026-06-08";

  beforeEach(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-run-store-"));
    store = new RunStore(runsDir);
  });

  afterEach(() => {
    fs.rmSync(runsDir, { recursive: true, force: true });
  });

  describe("fragment IO", () => {
    it("round-trips a single fragment", () => {
      const frag = fragment({ title: "single", claimSlugHint: "single-claim" });
      store.writeFragment(runId, "frag-001", frag);

      const read = store.readFragments(runId);
      expect(read).toHaveLength(1);
      expect(read[0]).toEqual(frag);
    });

    it("writes to runs/<run-id>/fragments/<id>.json", () => {
      store.writeFragment(runId, "frag-001", fragment());
      const file = path.join(runsDir, runId, "fragments", "frag-001.json");
      expect(fs.existsSync(file)).toBe(true);
    });

    it("throws a collision error (naming runId + fragmentId) on a second write of the same fragmentId", () => {
      store.writeFragment(
        runId,
        "frag-001",
        fragment({ title: "first write" }),
      );
      const second = () =>
        store.writeFragment(
          runId,
          "frag-001",
          fragment({ title: "second write" }),
        );
      expect(second).toThrow(/fragment id collision/);
      expect(second).toThrow(runId);
      expect(second).toThrow("frag-001");
      // The FIRST write's content is intact — no silent last-write-wins.
      const read = store.readFragments(runId);
      expect(read).toHaveLength(1);
      expect(read[0]!.title).toBe("first write");
    });

    it("round-trips multiple fragments in stable (sorted) order", () => {
      store.writeFragment(runId, "frag-c", fragment({ title: "c" }));
      store.writeFragment(runId, "frag-a", fragment({ title: "a" }));
      store.writeFragment(runId, "frag-b", fragment({ title: "b" }));

      const titles = store.readFragments(runId).map((f) => f.title);
      expect(titles).toEqual(["a", "b", "c"]); // sorted by filename: a,b,c
    });

    it("returns [] for a run with no fragments", () => {
      expect(store.readFragments("nonexistent-run")).toEqual([]);
    });

    // A `fragmentId` containing a path separator or `..` would write OUTSIDE the
    // fragments dir (and readFragments only scans the top level, silently losing
    // it). The id must be a safe single path segment — fail loud otherwise.
    describe("fragmentId path-traversal guard", () => {
      it("throws on a parent-traversal id ('../evil')", () => {
        expect(() =>
          store.writeFragment(runId, "../evil", fragment()),
        ).toThrow();
      });

      it("throws on an id with a forward slash ('a/b')", () => {
        expect(() => store.writeFragment(runId, "a/b", fragment())).toThrow();
      });

      it("throws on an id with a backslash ('a\\\\b')", () => {
        expect(() => store.writeFragment(runId, "a\\b", fragment())).toThrow();
      });

      it("throws on a bare '..' id", () => {
        expect(() => store.writeFragment(runId, "..", fragment())).toThrow();
      });

      it("does NOT write any file outside the fragments dir for an unsafe id", () => {
        expect(() =>
          store.writeFragment(runId, "../evil", fragment()),
        ).toThrow();
        // The escape target must not have been created.
        expect(fs.existsSync(path.join(runsDir, runId, "evil.json"))).toBe(
          false,
        );
      });

      it("still accepts a safe single-segment id", () => {
        expect(() =>
          store.writeFragment(runId, "frag-001", fragment()),
        ).not.toThrow();
        expect(
          fs.existsSync(
            path.join(runsDir, runId, "fragments", "frag-001.json"),
          ),
        ).toBe(true);
      });
    });

    // The same traversal threat applies to the caller-supplied `runId` — it is
    // joined into the runs dir by every store method, so `../escape` would read
    // or write OUTSIDE the runs dir. The runId must get the same single-path-
    // segment guard as fragmentId.
    describe("runId path-traversal guard", () => {
      it("writeFragment throws on a parent-traversal runId ('../escape')", () => {
        expect(() =>
          store.writeFragment("../escape", "frag-001", fragment()),
        ).toThrow(/runId/);
      });

      it("readFragments throws on a parent-traversal runId", () => {
        expect(() => store.readFragments("../escape")).toThrow(/runId/);
      });

      it("writeManifest throws on a parent-traversal runId", () => {
        expect(() =>
          store.writeManifest("../escape", { fragmentCount: 0, ruleSet: [] }),
        ).toThrow(/runId/);
      });

      it("readManifest throws on a parent-traversal runId", () => {
        expect(() => store.readManifest("../escape")).toThrow(/runId/);
      });

      it("throws on a runId containing a path separator ('a/b')", () => {
        expect(() =>
          store.writeFragment("a/b", "frag-001", fragment()),
        ).toThrow(/runId/);
      });

      it("does NOT create any directory outside the runs dir for an unsafe runId", () => {
        // Use a NESTED runs dir so the would-be escape target lands inside this
        // test's own tmp root (deterministic — not shared os.tmpdir() state).
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-escape-"));
        try {
          const nested = new RunStore(path.join(root, "runs"));
          expect(() =>
            nested.writeFragment("../escape", "frag-001", fragment()),
          ).toThrow();
          expect(fs.existsSync(path.join(root, "escape"))).toBe(false);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    });

    // A corrupt or schema-invalid fragment file must fail LOUD with the
    // offending file's path (mirroring readManifest), not a pathless
    // SyntaxError/ZodError that leaves the operator hunting through the run dir.
    describe("corrupt fragment validation", () => {
      function writeRawFragment(name: string, raw: string): string {
        const dir = path.join(runsDir, runId, "fragments");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        fs.writeFileSync(file, raw, "utf-8");
        return file;
      }

      it("throws with the fragment file path on invalid JSON", () => {
        const file = writeRawFragment("frag-bad.json", "{ not json ");
        expect(() => store.readFragments(runId)).toThrow(file);
      });

      it("throws with the fragment file path on a schema-invalid fragment", () => {
        const file = writeRawFragment(
          "frag-invalid.json",
          JSON.stringify({ title: "missing everything else" }),
        );
        expect(() => store.readFragments(runId)).toThrow(file);
      });
    });
  });

  describe("manifest IO", () => {
    const ruleSet: ExclusionRule[] = [
      { kind: "flag", dimension: "sensitivity", equals: "proprietary" },
      { kind: "flag", dimension: "sensitivity", equals: "secret" },
      { kind: "english", text: "Drop anything about customer GTM strategy." },
    ];

    it("round-trips a manifest including the exclusion-rule set", () => {
      const input: RunManifestInput = { fragmentCount: 3, ruleSet };
      const written = store.writeManifest(runId, input);

      const read = store.readManifest(runId);
      expect(read).toBeDefined();
      expect(read!.runId).toBe(runId);
      expect(read!.fragmentCount).toBe(3);
      expect(read!.ruleSet).toEqual(ruleSet);
      // round-trips byte-for-byte with what writeManifest returned
      expect(read).toEqual(written);
    });

    it("writes runs/<run-id>/manifest.json", () => {
      store.writeManifest(runId, { fragmentCount: 0, ruleSet: [] });
      expect(fs.existsSync(path.join(runsDir, runId, "manifest.json"))).toBe(
        true,
      );
    });

    it("returns undefined when no manifest has been written (first run)", () => {
      expect(store.readManifest("first-ever-run")).toBeUndefined();
    });

    it("preserves createdAt and advances updatedAt across rewrites", () => {
      const t1 = new Date("2026-06-08T00:00:00.000Z");
      const t2 = new Date("2026-06-09T12:00:00.000Z");

      const first = store.writeManifest(
        runId,
        { fragmentCount: 1, ruleSet },
        t1,
      );
      expect(first.createdAt).toBe(t1.toISOString());
      expect(first.updatedAt).toBe(t1.toISOString());

      const second = store.writeManifest(
        runId,
        { fragmentCount: 5, ruleSet: [] },
        t2,
      );
      expect(second.createdAt).toBe(t1.toISOString()); // preserved
      expect(second.updatedAt).toBe(t2.toISOString()); // advanced
      expect(second.fragmentCount).toBe(5);
      expect(second.ruleSet).toEqual([]);
    });

    it("ignores runId in the input body, using the argument", () => {
      // RunManifestInput omits runId, but guard the runtime behavior too.
      store.writeManifest(runId, {
        fragmentCount: 0,
        ruleSet: [],
      } as RunManifestInput);
      expect(store.readManifest(runId)!.runId).toBe(runId);
    });

    // The manifest persists the run's FINAL exclusion-rule set, which seeds the
    // NEXT run (§11.5). A corrupt or schema-invalid manifest must fail LOUD (with
    // the offending file path) rather than silently returning a bad object that
    // poisons the next run's exclusion seeding.
    describe("malformed manifest validation", () => {
      function writeRawManifest(raw: string): string {
        const file = path.join(runsDir, runId, "manifest.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, raw, "utf-8");
        return file;
      }

      it("throws with the manifest path on invalid JSON", () => {
        const file = writeRawManifest("{ this is not json ");
        expect(() => store.readManifest(runId)).toThrow(file);
      });

      it("throws with the manifest path on a schema-invalid ruleSet", () => {
        // Valid JSON, valid manifest skeleton, but a rule with an unknown `kind`
        // (and missing the discriminated-union fields) — must be rejected.
        const file = writeRawManifest(
          JSON.stringify(
            {
              runId,
              createdAt: "2026-06-08T00:00:00.000Z",
              updatedAt: "2026-06-08T00:00:00.000Z",
              fragmentCount: 1,
              ruleSet: [{ kind: "bogus", whatever: true }],
            },
            null,
            2,
          ),
        );
        expect(() => store.readManifest(runId)).toThrow(file);
      });

      it("throws with the manifest path on a flag rule with a bad dimension", () => {
        // `dimension` must be a key of Classification; "not-a-dimension" is not.
        const file = writeRawManifest(
          JSON.stringify(
            {
              runId,
              createdAt: "2026-06-08T00:00:00.000Z",
              updatedAt: "2026-06-08T00:00:00.000Z",
              fragmentCount: 1,
              ruleSet: [
                { kind: "flag", dimension: "not-a-dimension", equals: "x" },
              ],
            },
            null,
            2,
          ),
        );
        expect(() => store.readManifest(runId)).toThrow(file);
      });

      it("accepts a valid manifest written by writeManifest (round-trip)", () => {
        const written = store.writeManifest(runId, {
          fragmentCount: 3,
          ruleSet,
        });
        // readManifest re-parses through the schema and must return it intact.
        expect(store.readManifest(runId)).toEqual(written);
      });

      // writeManifest reads the existing manifest to preserve createdAt. If the
      // existing manifest is corrupt, readManifest THROWS — which would make a
      // corrupt manifest impossible to overwrite/repair. writeManifest must treat
      // a read failure as "no prior manifest" and write a fresh one (so the API
      // can recover from corruption). readManifest itself stays fail-loud.
      it("overwrites a corrupt (invalid-JSON) manifest, creating a fresh one", () => {
        writeRawManifest("{ this is not json ");
        const now = new Date("2026-06-09T12:00:00.000Z");
        const written = store.writeManifest(
          runId,
          { fragmentCount: 2, ruleSet },
          now,
        );
        // createdAt falls back to `now` (no recoverable prior value).
        expect(written.createdAt).toBe(now.toISOString());
        expect(written.updatedAt).toBe(now.toISOString());
        expect(written.fragmentCount).toBe(2);
        // The repaired manifest now reads back cleanly.
        expect(store.readManifest(runId)).toEqual(written);
      });

      it("overwrites a schema-invalid manifest, creating a fresh one", () => {
        writeRawManifest(
          JSON.stringify({
            runId,
            createdAt: "2026-06-08T00:00:00.000Z",
            updatedAt: "2026-06-08T00:00:00.000Z",
            fragmentCount: 1,
            ruleSet: [{ kind: "bogus", whatever: true }],
          }),
        );
        const now = new Date("2026-06-09T12:00:00.000Z");
        const written = store.writeManifest(
          runId,
          { fragmentCount: 0, ruleSet: [] },
          now,
        );
        // A corrupt prior createdAt is NOT trusted; fall back to `now`.
        expect(written.createdAt).toBe(now.toISOString());
        expect(store.readManifest(runId)).toEqual(written);
      });

      // The repair path must be NARROW: only the two corruption errors
      // readManifest itself raises (invalid JSON / schema-invalid) are treated
      // as "no prior manifest". Any other fs failure (EACCES, EISDIR, EIO…) is
      // a real environment problem and must propagate, not silently reset
      // createdAt over it.
      it("rethrows a non-corruption fs error instead of swallowing it", () => {
        // A prior VALID manifest exists, but reading it fails with an fs-level
        // error (EACCES/EIO) — NOT manifest corruption. Swallowing it would
        // silently reset createdAt over a manifest we never actually read.
        store.writeManifest(runId, { fragmentCount: 1, ruleSet: [] });
        const eacces = Object.assign(
          new Error("EACCES: permission denied, open 'manifest.json'"),
          { code: "EACCES" },
        );
        const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
          throw eacces;
        });
        try {
          expect(() =>
            store.writeManifest(runId, { fragmentCount: 2, ruleSet: [] }),
          ).toThrow(/EACCES/);
        } finally {
          read.mockRestore();
        }
      });

      it("warns (naming the manifest path) when repairing a corrupt manifest", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const file = writeRawManifest("{ this is not json ");
          store.writeManifest(runId, { fragmentCount: 0, ruleSet: [] });
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn.mock.calls[0].map(String).join(" ")).toContain(file);
        } finally {
          warn.mockRestore();
        }
      });

      it("does NOT warn on a clean rewrite of a valid manifest", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          store.writeManifest(runId, { fragmentCount: 1, ruleSet: [] });
          store.writeManifest(runId, { fragmentCount: 2, ruleSet: [] });
          expect(warn).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      });
    });
  });

  describe("fragment + manifest coexist in one run dir", () => {
    it("keeps fragments and manifest independently readable", () => {
      store.writeFragment(runId, "frag-001", fragment());
      store.writeManifest(runId, { fragmentCount: 1, ruleSet: [] });

      expect(store.readFragments(runId)).toHaveLength(1);
      expect(store.readManifest(runId)!.fragmentCount).toBe(1);
    });
  });
});
