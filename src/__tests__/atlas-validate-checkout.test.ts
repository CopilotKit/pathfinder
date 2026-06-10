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
} from "../atlas/validate-checkout.js";
import { formatCliError } from "../../scripts/atlas-harvest.js";

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
