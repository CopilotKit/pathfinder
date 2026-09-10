import { describe, it, expect } from "vitest";

import {
  computeSourceConfigFingerprint,
  decideAcquisition,
} from "../indexing/source-fingerprint.js";
import { SourceConfigSchema } from "../types.js";
import type { SourceConfig } from "../types.js";

/** Parse through the real schema so defaults are applied as at runtime. */
function source(overrides: Record<string, unknown>): SourceConfig {
  return SourceConfigSchema.parse({
    name: "docs",
    type: "markdown",
    path: "content",
    file_patterns: ["**/*.md"],
    ...overrides,
  });
}

describe("computeSourceConfigFingerprint", () => {
  it("is stable for an identical config", () => {
    expect(computeSourceConfigFingerprint(source({}))).toBe(
      computeSourceConfigFingerprint(source({})),
    );
  });

  it("changes when file_patterns widens (the production regression)", () => {
    expect(
      computeSourceConfigFingerprint(
        source({ file_patterns: ["**/*.md", "**/*.mdx"] }),
      ),
    ).not.toBe(computeSourceConfigFingerprint(source({})));
  });

  it("changes when the walk root moves", () => {
    expect(computeSourceConfigFingerprint(source({ path: "docs" }))).not.toBe(
      computeSourceConfigFingerprint(source({})),
    );
  });

  it("changes when url_derivation.strip_prefix changes", () => {
    expect(
      computeSourceConfigFingerprint(
        source({ url_derivation: { strip_prefix: "content/" } }),
      ),
    ).not.toBe(computeSourceConfigFingerprint(source({})));
  });

  it("is order-insensitive for set-valued fields", () => {
    // Cosmetic reordering of a SET must not force a needless full walk.
    expect(
      computeSourceConfigFingerprint(
        source({ file_patterns: ["**/*.mdx", "**/*.md"] }),
      ),
    ).toBe(
      computeSourceConfigFingerprint(
        source({ file_patterns: ["**/*.md", "**/*.mdx"] }),
      ),
    );
    expect(
      computeSourceConfigFingerprint(
        source({ skip_dirs: ["b", "a"], exclude_patterns: ["y", "x"] }),
      ),
    ).toBe(
      computeSourceConfigFingerprint(
        source({ skip_dirs: ["a", "b"], exclude_patterns: ["x", "y"] }),
      ),
    );
  });

  it("IS order-sensitive for strip_prefix candidate lists", () => {
    // The list is ordered — the FIRST matching candidate is the one stripped —
    // so reordering genuinely changes the derived URLs.
    expect(
      computeSourceConfigFingerprint(
        source({ url_derivation: { strip_prefix: ["a/", "a/b/"] } }),
      ),
    ).not.toBe(
      computeSourceConfigFingerprint(
        source({ url_derivation: { strip_prefix: ["a/b/", "a/"] } }),
      ),
    );
  });

  it("ignores fields that do not change what is enumerated", () => {
    // chunk sizing / version / category only affect how already-enumerated
    // content is rendered; they must not force a full re-walk of every source.
    expect(
      computeSourceConfigFingerprint(
        source({ chunk: { target_tokens: 900 }, version: "2", name: "other" }),
      ),
    ).toBe(computeSourceConfigFingerprint(source({})));
  });

  it("covers non-file source types", () => {
    const slack = (channels: string[]) =>
      computeSourceConfigFingerprint(
        SourceConfigSchema.parse({ name: "faq", type: "slack", channels }),
      );
    expect(slack(["C1", "C2"])).toBe(slack(["C2", "C1"]));
    expect(slack(["C1"])).not.toBe(slack(["C1", "C2"]));

    const notion = (roots: string[]) =>
      computeSourceConfigFingerprint(
        SourceConfigSchema.parse({
          name: "wiki",
          type: "notion",
          root_pages: roots,
        }),
      );
    expect(notion(["p1"])).not.toBe(notion(["p1", "p2"]));
  });
});

describe("decideAcquisition", () => {
  it("full-walks when there is no prior state", () => {
    expect(decideAcquisition(null, null, "fp")).toEqual({
      mode: "full",
      reason: "no-prior-state",
    });
  });

  it("full-walks ONCE when the stored fingerprint is NULL (pre-upgrade row)", () => {
    // NULL is "unknown", not "unchanged": we cannot prove the indexed content
    // matches the current config. The orchestrator persists the fingerprint on
    // success, so this is a one-time cost per source, not a per-boot one.
    expect(decideAcquisition("sha", null, "fp")).toEqual({
      mode: "full",
      reason: "no-stored-config-fingerprint",
    });
  });

  it("full-walks when the config fingerprint differs", () => {
    expect(decideAcquisition("sha", "old", "new")).toEqual({
      mode: "full",
      reason: "config-changed",
    });
  });

  it("goes incremental when the sha exists AND the fingerprint matches", () => {
    expect(decideAcquisition("sha", "fp", "fp")).toEqual({
      mode: "incremental",
      reason: "config-unchanged",
    });
  });
});
