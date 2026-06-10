// Atlas validation-checkout helper (S14).
//
// A thin, dependency-injected helper that assembles a `ValidationContext` for
// the S14 validation gate (`./validate.ts`) from two on-disk artifacts:
//
//   1. a READ-ONLY checkout of origin/main (the tree `promoteValidation` greps
//      to source-verify a candidate's validationTargets), and
//   2. the showcase feature-registry JSON (the pill table `promoteValidation`
//      maps a claim against to showcase-verify it).
//
// Per the plan's §6 open-question resolution, the harvest runtime REUSES the
// indexer's existing clone dir (`ProviderOptions.cloneDir`) rather than cutting
// a fresh clone — the caller injects that path here. This module performs NO
// network and NO git: it only validates that the injected checkout dir exists
// and loads/parses the registry file off disk. Keeping acquisition out of this
// helper is what lets the S14 tests run fully hermetically against the fixture
// checkout (the test constructs `ValidationContext` directly — see
// `src/__tests__/atlas-validate.test.ts`).

import fs from "node:fs";
import path from "node:path";
import { PILL_STATUSES, type FeatureRegistry } from "./adapters/showcase.js";
import type { ValidationContext } from "./validate.js";

// Inputs for locating the validation context's two artifacts. Both paths are
// INJECTED (no discovery, no network) so the gate stays deterministic and the
// harvest driver controls exactly which checkout/registry are validated against.
export interface ValidationCheckoutOptions {
  // Absolute (or cwd-relative) path to the read-only origin/main checkout —
  // typically the indexer's existing clone dir (`ProviderOptions.cloneDir`).
  checkoutDir: string;
  // Path to the parsed-from-disk showcase feature-registry JSON
  // (showcase/shared/feature-registry.json or a snapshot of it).
  featureRegistryPath: string;
}

// Resolve + assert the read-only checkout directory. Fails LOUD (spec fail-loud
// discipline) if the injected path is missing or is not a directory, rather than
// silently yielding an empty grep surface that would mark every candidate
// unverified.
export function locateCheckoutDir(checkoutDir: string): string {
  const resolved = path.resolve(checkoutDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    // Carry the underlying error as `cause`: an EACCES/EIO dir is NOT
    // "does not exist", and the driver's formatCliError walks the cause
    // chain to surface the real diagnosis.
    throw new Error(
      `Atlas validation checkout dir cannot be read (missing or ` +
        `unreadable): "${resolved}". Inject the indexer's clone dir ` +
        `(ProviderOptions.cloneDir) or a dedicated read-only checkout of ` +
        `origin/main.`,
      { cause: err },
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Atlas validation checkout path is not a directory: "${resolved}".`,
    );
  }
  return resolved;
}

// Load + parse the showcase feature-registry JSON off disk. Fails LOUD on a
// missing or malformed file (a silently-empty registry would make every claim
// non-showcase-verifiable, masking a config error).
export function loadFeatureRegistry(
  featureRegistryPath: string,
): FeatureRegistry {
  const resolved = path.resolve(featureRegistryPath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf-8");
  } catch (err) {
    // Carry the underlying error as `cause` (same rationale as
    // locateCheckoutDir): EACCES/EIO is not "does not exist", and
    // formatCliError surfaces the cause chain.
    throw new Error(
      `Atlas feature-registry file cannot be read (missing or unreadable): ` +
        `"${resolved}". Point it at showcase/shared/feature-registry.json ` +
        `(or a snapshot).`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Atlas feature-registry file is not valid JSON ("${resolved}"): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { categories?: unknown }).categories)
  ) {
    throw new Error(
      `Atlas feature-registry file is missing a "categories" array ` +
        `("${resolved}").`,
    );
  }
  // Deep-shape check (fix9 Y19): stopping at "categories is an array" would
  // let a malformed snapshot (e.g. `{"categories":[{"pills":"x"}]}` or a
  // numeric pill id) sail through to S14's `lookupPill`, which iterates
  // `category.pills` and calls `pill.id.toLowerCase()` unguarded — a TypeError
  // deep in validation, far from the config error and with no file path. Fail
  // LOUD here instead, naming the registry path (same error shape as the
  // guards above). Manual checks, not Zod, to keep this helper dependency-thin.
  const categories = (parsed as { categories: unknown[] }).categories;
  categories.forEach((category, ci) => {
    if (
      typeof category !== "object" ||
      category === null ||
      !Array.isArray((category as { pills?: unknown }).pills)
    ) {
      throw new Error(
        `Atlas feature-registry file has a malformed category at ` +
          `categories[${ci}] — expected an object with a "pills" array ` +
          `("${resolved}").`,
      );
    }
    (category as { pills: unknown[] }).pills.forEach((pill, pi) => {
      const at = `categories[${ci}].pills[${pi}]`;
      if (typeof pill !== "object" || pill === null) {
        throw new Error(
          `Atlas feature-registry file has a malformed pill at ${at} — ` +
            `expected an object ("${resolved}").`,
        );
      }
      const p = pill as { id?: unknown; name?: unknown; status?: unknown };
      if (typeof p.id !== "string") {
        throw new Error(
          `Atlas feature-registry file has a malformed pill at ${at} — ` +
            `"id" must be a string ("${resolved}").`,
        );
      }
      if (p.name !== undefined && typeof p.name !== "string") {
        throw new Error(
          `Atlas feature-registry file has a malformed pill at ${at} — ` +
            `optional "name" must be a string ("${resolved}").`,
        );
      }
      // fix10 Z3: membership, not just `typeof "string"` — a registry with
      // `"Green"`/`"shipped"` would otherwise load silently and
      // `isShowcaseGreen`'s `status === "green"` comparison would never
      // verify any pill.
      if (
        typeof p.status !== "string" ||
        !(PILL_STATUSES as readonly string[]).includes(p.status)
      ) {
        throw new Error(
          `Atlas feature-registry file has a malformed pill at ${at} — ` +
            `"status" must be one of ` +
            `${PILL_STATUSES.map((s) => `"${s}"`).join(", ")} ("${resolved}").`,
        );
      }
    });
  });
  return parsed as FeatureRegistry;
}

// Assemble a `ValidationContext` from the injected checkout dir + registry path.
// This is the single seam the harvest driver (S18) calls to build the context it
// hands to `promoteValidation`; the S14 unit tests bypass it and construct the
// context directly against the fixture checkout (no disk registry needed).
export function loadValidationContext(
  opts: ValidationCheckoutOptions,
): ValidationContext {
  return {
    checkoutDir: locateCheckoutDir(opts.checkoutDir),
    featureRegistry: loadFeatureRegistry(opts.featureRegistryPath),
  };
}
