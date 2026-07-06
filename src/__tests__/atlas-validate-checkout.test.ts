// Unit tests for the S14 validation-checkout helper (validate-checkout.ts).
//
// fix8 X27: the helper's fail-loud errors must CARRY the underlying filesystem
// error as `cause` — an EACCES/EIO checkout dir or registry file is not
// "does not exist", and `formatCliError` (the driver's cause-chain printer)
// exists precisely to surface the real diagnosis. These tests stub the fs call
// to throw EACCES and assert the cause survives all the way through
// `formatCliError`'s rendered output.

import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  locateCheckoutDir,
  loadFeatureRegistry,
  loadValidationContext,
} from "../atlas/validate-checkout.js";
import { formatCliError } from "../atlas/harvest-cli.js";

function eaccesError(syscall: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`EACCES: permission denied, ${syscall} '/stubbed/path'`),
    { code: "EACCES" },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("locateCheckoutDir — unreadable dir surfaces the cause (fix8 X27)", () => {
  it("attaches the underlying EACCES as `cause` and formatCliError renders it", () => {
    const eacces = eaccesError("stat");
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw eacces;
    });

    let thrown: unknown;
    try {
      locateCheckoutDir("/some/checkout");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Not "does not exist" — the dir may exist and be unreadable.
    expect((thrown as Error).message).toMatch(
      /cannot be read \(missing or unreadable\)/,
    );
    expect((thrown as Error).cause).toBe(eacces);
    // The driver's cause-chain printer surfaces the real diagnosis.
    expect(formatCliError(thrown)).toContain("EACCES: permission denied");
  });
});

describe("loadFeatureRegistry — unreadable file surfaces the cause (fix8 X27)", () => {
  it("attaches the underlying EACCES as `cause` and formatCliError renders it", () => {
    const eacces = eaccesError("open");
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw eacces;
    });

    let thrown: unknown;
    try {
      loadFeatureRegistry("/some/feature-registry.json");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /cannot be read \(missing or unreadable\)/,
    );
    expect((thrown as Error).cause).toBe(eacces);
    expect(formatCliError(thrown)).toContain("EACCES: permission denied");
  });
});

// fix9 Y19: the registry guard must validate the DEEP shape, not just that
// `categories` is an array — a snapshot like `{"categories":[{"pills":"x"}]}`
// or a numeric pill id would otherwise TypeError deep inside `lookupPill`
// (S14), far from the config error and with no file path.
describe("loadFeatureRegistry — deep shape validation (fix9 Y19)", () => {
  let dir: string;
  let seq = 0;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-registry-shape-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeRegistry(value: unknown): string {
    const file = path.join(dir, `registry-${seq++}.json`);
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf-8");
    return file;
  }

  function loudConfigError(file: string): unknown {
    let thrown: unknown;
    try {
      loadFeatureRegistry(file);
    } catch (e) {
      thrown = e;
    }
    // A loud config error naming the registry path — NOT a pathless TypeError
    // thrown later from lookupPill.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain("feature-registry");
    expect((thrown as Error).message).toContain(path.resolve(file));
    return thrown;
  }

  it("rejects a category whose `pills` is not an array", () => {
    const file = writeRegistry({ categories: [{ pills: "x" }] });
    const thrown = loudConfigError(file);
    expect((thrown as Error).message).toContain("pills");
  });

  it("rejects a non-object category", () => {
    const file = writeRegistry({ categories: ["not-a-category"] });
    loudConfigError(file);
  });

  it("rejects a non-object pill", () => {
    const file = writeRegistry({ categories: [{ pills: ["bare-string"] }] });
    loudConfigError(file);
  });

  it("rejects a pill with a non-string id", () => {
    const file = writeRegistry({
      categories: [{ pills: [{ id: 42, status: "green" }] }],
    });
    const thrown = loudConfigError(file);
    expect((thrown as Error).message).toContain("id");
  });

  it("rejects a pill with a non-string status", () => {
    const file = writeRegistry({
      categories: [{ pills: [{ id: "agentic-chat", status: 7 }] }],
    });
    const thrown = loudConfigError(file);
    expect((thrown as Error).message).toContain("status");
  });

  // fix10 Z3: `typeof status === "string"` is not enough — a registry with
  // `"Green"` or `"shipped"` would load silently, and isShowcaseGreen's
  // `status === "green"` comparison would never verify any pill. The guard
  // must enforce membership in the actual PillStatus set.
  it("rejects a pill whose status is not a known PillStatus value (fix10 Z3)", () => {
    const file = writeRegistry({
      categories: [{ pills: [{ id: "agentic-chat", status: "Green" }] }],
    });
    const thrown = loudConfigError(file);
    expect((thrown as Error).message).toContain("categories[0].pills[0]");
    expect((thrown as Error).message).toContain('"green"');
    expect((thrown as Error).message).toContain('"quarantined"');
    expect((thrown as Error).message).toContain('"not_supported"');
  });

  it("rejects a pill with a non-string `name`", () => {
    const file = writeRegistry({
      categories: [
        { pills: [{ id: "agentic-chat", name: 1, status: "green" }] },
      ],
    });
    const thrown = loudConfigError(file);
    expect((thrown as Error).message).toContain("name");
  });

  it("accepts a well-formed registry (name optional)", () => {
    const file = writeRegistry({
      version: "1",
      categories: [
        {
          id: "genui",
          name: "Generative UI",
          pills: [
            { id: "agentic-chat", name: "Agentic Chat", status: "green" },
            { id: "tool-render", status: "quarantined" },
          ],
        },
        { id: "empty", pills: [] },
      ],
    });
    const registry = loadFeatureRegistry(file);
    expect(registry.categories).toHaveLength(2);
    expect(registry.categories[0]!.pills[0]!.id).toBe("agentic-chat");
  });
});

// S19 (Theme E): FAIL-CLOSED contract for the clone/grep seam the §7 validation
// gate depends on. `validate-checkout.ts` does no git and no grep itself — it
// assembles the ValidationContext the gate greps against. The fail-closed
// invariant at THIS seam: when the injected checkout is MISSING / UNREADABLE /
// the wrong type (what a failed clone, an absent ref, or a stale/aborted grep
// working tree looks like from disk), the helper must THROW rather than hand
// back a context. A silently-empty or non-existent grep surface would make
// EVERY candidate's validationTargets fail to match, marking them all
// "unverified" — i.e. the gate would falsely source-verify NOTHING while
// looking green-ish. So the contract is: fail closed (throw), never return.
describe("validate-checkout FAIL-CLOSED contract (S19)", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-failclosed-"));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // --- checkout dir: missing (failed clone / absent ref) ---
  it("locateCheckoutDir THROWS (does not return a path) when the checkout dir is absent", () => {
    const missing = path.join(tmp, "no-such-clone-dir");
    // Guard the premise: the path really does not exist.
    expect(fs.existsSync(missing)).toBe(false);

    let thrown: unknown;
    let returned: unknown;
    try {
      returned = locateCheckoutDir(missing);
    } catch (e) {
      thrown = e;
    }

    // Fail CLOSED: it must throw, never yield a (bogus) resolved path that
    // downstream grep would treat as an empty-but-valid checkout.
    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /checkout dir cannot be read \(missing or unreadable\)/,
    );
    // The ENOENT cause survives for formatCliError's diagnosis.
    expect((thrown as NodeJS.ErrnoException & { cause?: unknown }).cause).toBeDefined();
    expect(
      (
        (thrown as { cause?: NodeJS.ErrnoException }).cause as NodeJS.ErrnoException
      ).code,
    ).toBe("ENOENT");
  });

  // --- checkout dir: exists but is a FILE, not a tree (wrong-type checkout) ---
  it("locateCheckoutDir THROWS when the checkout path is a file, not a directory", () => {
    const asFile = path.join(tmp, "clone-is-a-file");
    fs.writeFileSync(asFile, "not a checkout\n", "utf-8");

    let thrown: unknown;
    let returned: unknown;
    try {
      returned = locateCheckoutDir(asFile);
    } catch (e) {
      thrown = e;
    }

    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/is not a directory/);
  });

  // --- checkout dir: stat() errors (EIO / aborted grep working tree) ---
  it("locateCheckoutDir fails CLOSED when statSync errors (EIO), never returning", () => {
    const eio = Object.assign(new Error("EIO: i/o error, stat '/x'"), {
      code: "EIO",
    });
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw eio;
    });

    let thrown: unknown;
    let returned: unknown;
    try {
      returned = locateCheckoutDir("/some/checkout");
    } catch (e) {
      thrown = e;
    }

    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(eio);
  });

  // --- registry: missing file (absent ref / unpopulated checkout) ---
  it("loadFeatureRegistry THROWS (does not return a registry) when the file is absent", () => {
    const missing = path.join(tmp, "no-such-registry.json");
    expect(fs.existsSync(missing)).toBe(false);

    let thrown: unknown;
    let returned: unknown;
    try {
      returned = loadFeatureRegistry(missing);
    } catch (e) {
      thrown = e;
    }

    // Fail CLOSED: never a silently-empty registry (which would make every
    // claim non-showcase-verifiable, masking the config error).
    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /feature-registry file cannot be read \(missing or unreadable\)/,
    );
    expect(
      (
        (thrown as { cause?: NodeJS.ErrnoException }).cause as NodeJS.ErrnoException
      ).code,
    ).toBe("ENOENT");
  });

  // --- whole seam: loadValidationContext never returns a context if EITHER
  //     artifact is bad (the single seam the harvest driver calls) ---
  it("loadValidationContext fails CLOSED (no context) when the checkout dir is missing", () => {
    const registry = path.join(tmp, "registry-ok.json");
    fs.writeFileSync(
      registry,
      `${JSON.stringify({ categories: [] })}\n`,
      "utf-8",
    );

    let thrown: unknown;
    let returned: unknown;
    try {
      returned = loadValidationContext({
        checkoutDir: path.join(tmp, "absent-clone"),
        featureRegistryPath: registry,
      });
    } catch (e) {
      thrown = e;
    }

    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/checkout dir cannot be read/);
  });

  it("loadValidationContext fails CLOSED (no context) when the registry file is missing", () => {
    const checkout = path.join(tmp, "real-checkout");
    fs.mkdirSync(checkout, { recursive: true });

    let thrown: unknown;
    let returned: unknown;
    try {
      returned = loadValidationContext({
        checkoutDir: checkout,
        featureRegistryPath: path.join(tmp, "absent-registry.json"),
      });
    } catch (e) {
      thrown = e;
    }

    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/feature-registry file cannot be read/);
  });
});
