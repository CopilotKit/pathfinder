import { describe, it, expect } from "vitest";
import { deriveUrl } from "../indexing/url-derivation.js";
import type { FileSourceConfig } from "../types.js";

/** Helper to build a minimal FileSourceConfig with url_derivation options. */
function makeConfig(
  baseUrl: string,
  derivation: FileSourceConfig["url_derivation"] = {},
): FileSourceConfig {
  return {
    name: "test",
    type: "markdown",
    path: ".",
    file_patterns: ["**/*.md"],
    chunk: { target_tokens: 500 },
    base_url: baseUrl,
    url_derivation: derivation,
  };
}

describe("deriveUrl", () => {
  // ── Returns null when not configured ────────────────────────────────────

  it("returns null when base_url is missing", () => {
    const config: FileSourceConfig = {
      name: "test",
      type: "markdown",
      path: ".",
      file_patterns: ["**/*.md"],
      chunk: { target_tokens: 500 },
      url_derivation: { strip_suffix: ".md" },
    };
    expect(deriveUrl("docs/page.md", config)).toBeNull();
  });

  it("returns null when url_derivation is missing", () => {
    const config: FileSourceConfig = {
      name: "test",
      type: "markdown",
      path: ".",
      file_patterns: ["**/*.md"],
      chunk: { target_tokens: 500 },
      base_url: "https://example.com/docs/",
    };
    expect(deriveUrl("docs/page.md", config)).toBeNull();
  });

  it("returns null when both base_url and url_derivation are missing", () => {
    const config: FileSourceConfig = {
      name: "test",
      type: "markdown",
      path: ".",
      file_patterns: ["**/*.md"],
      chunk: { target_tokens: 500 },
    };
    expect(deriveUrl("docs/page.md", config)).toBeNull();
  });

  // ── No derivation options (empty object) ────────────────────────────────

  it("returns base_url + full path when derivation options are empty", () => {
    const config = makeConfig("https://example.com/docs/");
    expect(deriveUrl("getting-started.md", config)).toBe(
      "https://example.com/docs/getting-started.md",
    );
  });

  // ── strip_prefix ────────────────────────────────────────────────────────

  it("strips a matching prefix", () => {
    const config = makeConfig("https://example.com/", {
      strip_prefix: "docs/",
    });
    expect(deriveUrl("docs/guide/intro.md", config)).toBe(
      "https://example.com/guide/intro.md",
    );
  });

  it("leaves path unchanged when prefix does not match", () => {
    const config = makeConfig("https://example.com/", { strip_prefix: "src/" });
    expect(deriveUrl("docs/guide/intro.md", config)).toBe(
      "https://example.com/docs/guide/intro.md",
    );
  });

  it("strips prefix only from the start (not mid-path)", () => {
    const config = makeConfig("https://example.com/", {
      strip_prefix: "guide/",
    });
    expect(deriveUrl("docs/guide/intro.md", config)).toBe(
      "https://example.com/docs/guide/intro.md",
    );
  });

  // ── strip_suffix ────────────────────────────────────────────────────────

  it("strips a matching suffix", () => {
    const config = makeConfig("https://example.com/", { strip_suffix: ".md" });
    expect(deriveUrl("guide/intro.md", config)).toBe(
      "https://example.com/guide/intro",
    );
  });

  it("strips .mdx suffix", () => {
    const config = makeConfig("https://example.com/", { strip_suffix: ".mdx" });
    expect(deriveUrl("guide/intro.mdx", config)).toBe(
      "https://example.com/guide/intro",
    );
  });

  it("leaves path unchanged when suffix does not match", () => {
    const config = makeConfig("https://example.com/", { strip_suffix: ".mdx" });
    expect(deriveUrl("guide/intro.md", config)).toBe(
      "https://example.com/guide/intro.md",
    );
  });

  it("strips suffix only from the end (not mid-path)", () => {
    const config = makeConfig("https://example.com/", { strip_suffix: ".md" });
    expect(deriveUrl(".md/intro.txt", config)).toBe(
      "https://example.com/.md/intro.txt",
    );
  });

  it("handles suffix with regex-special characters", () => {
    const config = makeConfig("https://example.com/", { strip_suffix: ".m+d" });
    // The suffix ".m+d" should be treated literally, not as regex
    expect(deriveUrl("guide/intro.m+d", config)).toBe(
      "https://example.com/guide/intro",
    );
    // "." in the suffix should NOT match arbitrary characters
    expect(deriveUrl("guide/introXm+d", config)).toBe(
      "https://example.com/guide/introXm+d",
    );
  });

  // ── strip_route_groups ──────────────────────────────────────────────────

  it("strips Next.js-style route groups", () => {
    const config = makeConfig("https://example.com/", {
      strip_route_groups: true,
    });
    expect(deriveUrl("(marketing)/about/page.md", config)).toBe(
      "https://example.com/about/page.md",
    );
  });

  it("strips multiple route groups", () => {
    const config = makeConfig("https://example.com/", {
      strip_route_groups: true,
    });
    expect(deriveUrl("(app)/(dashboard)/settings/page.md", config)).toBe(
      "https://example.com/settings/page.md",
    );
  });

  it("does not strip route groups when disabled", () => {
    const config = makeConfig("https://example.com/", {
      strip_route_groups: false,
    });
    expect(deriveUrl("(marketing)/about/page.md", config)).toBe(
      "https://example.com/(marketing)/about/page.md",
    );
  });

  it("leaves path unchanged when there are no route groups", () => {
    const config = makeConfig("https://example.com/", {
      strip_route_groups: true,
    });
    expect(deriveUrl("about/page.md", config)).toBe(
      "https://example.com/about/page.md",
    );
  });

  // ── strip_index ─────────────────────────────────────────────────────────

  it("strips trailing /index", () => {
    const config = makeConfig("https://example.com/", { strip_index: true });
    expect(deriveUrl("guide/index", config)).toBe("https://example.com/guide");
  });

  it('strips bare "index" (root index page)', () => {
    const config = makeConfig("https://example.com/", { strip_index: true });
    expect(deriveUrl("index", config)).toBe("https://example.com/");
  });

  it('does not strip "index" when it is part of a filename', () => {
    const config = makeConfig("https://example.com/", { strip_index: true });
    expect(deriveUrl("guide/indexing", config)).toBe(
      "https://example.com/guide/indexing",
    );
  });

  it("does not strip index when disabled", () => {
    const config = makeConfig("https://example.com/", { strip_index: false });
    expect(deriveUrl("guide/index", config)).toBe(
      "https://example.com/guide/index",
    );
  });

  // ── Combined options ────────────────────────────────────────────────────

  it("applies all options together (prefix + suffix + route groups + index)", () => {
    const config = makeConfig("https://docs.example.com/", {
      strip_prefix: "content/",
      strip_suffix: ".mdx",
      strip_route_groups: true,
      strip_index: true,
    });
    // Order: strip_prefix -> strip_suffix -> strip_route_groups -> strip_index
    // 'content/(guides)/getting-started/index.mdx'
    //  -> strip_prefix 'content/': '(guides)/getting-started/index.mdx'
    //  -> strip_suffix '.mdx':     '(guides)/getting-started/index'
    //  -> strip_route_groups:      'getting-started/index'
    //  -> strip_index:             'getting-started'
    expect(
      deriveUrl("content/(guides)/getting-started/index.mdx", config),
    ).toBe("https://docs.example.com/getting-started");
    // Non-index path:
    expect(deriveUrl("content/(guides)/getting-started/page.mdx", config)).toBe(
      "https://docs.example.com/getting-started/page",
    );
  });

  it("applies prefix + suffix together", () => {
    const config = makeConfig("https://example.com/docs/", {
      strip_prefix: "pages/",
      strip_suffix: ".md",
    });
    expect(deriveUrl("pages/api/reference.md", config)).toBe(
      "https://example.com/docs/api/reference",
    );
  });

  it("applies suffix + index together (suffix stripped before index check)", () => {
    const config = makeConfig("https://example.com/", {
      strip_suffix: ".md",
      strip_index: true,
    });
    expect(deriveUrl("guide/index.md", config)).toBe(
      "https://example.com/guide",
    );
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it("handles empty path", () => {
    const config = makeConfig("https://example.com/");
    expect(deriveUrl("", config)).toBe("https://example.com/");
  });

  it("handles path that equals the prefix exactly", () => {
    const config = makeConfig("https://example.com/", {
      strip_prefix: "docs/",
    });
    expect(deriveUrl("docs/", config)).toBe("https://example.com/");
  });

  it("handles deeply nested path", () => {
    const config = makeConfig("https://example.com/", {
      strip_prefix: "content/",
      strip_suffix: ".md",
    });
    expect(deriveUrl("content/a/b/c/d/e/page.md", config)).toBe(
      "https://example.com/a/b/c/d/e/page",
    );
  });
});
