// Inline MDX snippet imports before chunking.
//
// CopilotKit-style docs compose pages from shared snippets, e.g.:
//
//   import MigrateToV2 from "@/snippets/shared/troubleshooting/migrate-to-v2.mdx";
//   <MigrateToV2 components={props.components} />
//
// The chunker's stripMdx() removes both the `import` line and the `<Snippet/>`
// JSX, so snippet-composed pages index as nearly empty. This module resolves
// those imports against the docs source tree and inlines the snippet body into
// the host page *before* stripping, so the real content gets chunked and
// indexed. Snippets may themselves import snippets, so resolution recurses with
// a bounded depth and a cycle guard.

import fs from "node:fs";
import path from "node:path";

/** How many levels of snippet-importing-snippet to follow. */
const DEFAULT_MAX_DEPTH = 3;
/** How far up the tree to look for the `@/` alias root (the `snippets/` parent). */
const MAX_ALIAS_LOOKUP_DEPTH = 12;

export interface InlineSnippetOptions {
  /** Maximum recursion depth for nested snippet imports. */
  maxDepth?: number;
}

interface ImportDecl {
  /** Local name the snippet is bound to (the JSX component name). */
  name: string;
  /** Raw module specifier, e.g. "@/snippets/foo.mdx" or "./foo.mdx". */
  spec: string;
  /** The full matched import statement text (for removal). */
  raw: string;
}

/** Matches `import Name from "spec";` (single-line ESM default import). */
const IMPORT_RE =
  /^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]([^'"]+)['"];?\s*$/gm;

/**
 * Strip leading YAML frontmatter from an MDX snippet body. Snippets normally
 * have no frontmatter, but stripping defensively keeps inlined output clean.
 */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length) : content;
}

/**
 * Resolve the directory that the `@/` alias maps to for a given host file.
 *
 * In CopilotKit's docs the alias is configured (tsconfig `paths`) as
 * `@/* -> ./*` relative to the docs project root, which is the directory that
 * contains `snippets/`. Rather than hard-code the repo layout, walk up from the
 * host file until we find an ancestor that contains a `snippets/` directory.
 * Returns null if none is found within a bounded number of levels.
 */
function findAliasRoot(hostDir: string): string | null {
  let dir = hostDir;
  for (let i = 0; i < MAX_ALIAS_LOOKUP_DEPTH; i++) {
    try {
      const candidate = path.join(dir, "snippets");
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return dir;
      }
    } catch {
      // Ignore stat errors and keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Resolve a module specifier to an absolute file path on disk, or null if it
 * does not point at a snippet we can inline.
 */
function resolveSpec(
  spec: string,
  hostDir: string,
  aliasRoot: string | null,
): string | null {
  // Only inline MDX/markdown snippet imports; ignore component/code imports.
  if (!/\.mdx?$/.test(spec)) return null;

  let abs: string;
  if (spec.startsWith("@/")) {
    if (!aliasRoot) return null;
    abs = path.join(aliasRoot, spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    abs = path.resolve(hostDir, spec);
  } else {
    // Bare package import (e.g. a real npm module) — not a local snippet.
    return null;
  }

  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  } catch {
    return null;
  }
  return null;
}

/** Parse single-line default-import declarations from MDX content. */
function parseImports(content: string): ImportDecl[] {
  const decls: ImportDecl[] = [];
  let match: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(content)) !== null) {
    decls.push({ name: match[1], spec: match[2], raw: match[0] });
  }
  return decls;
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace JSX usages of `name` (self-closing `<Name ... />` and paired
 * `<Name ...>...</Name>`) with `replacement`.
 */
function replaceUsages(
  content: string,
  name: string,
  replacement: string,
): string {
  const n = escapeRegExp(name);
  let result = content;

  // Self-closing: <Name ... /> — replaced FIRST so a self-closing tag can never
  // be consumed as the opening tag of the paired match below (which would
  // otherwise swallow everything up to the next </Name>, deleting any content
  // in between two uses of the same snippet).
  const selfRe = new RegExp(`<${n}(?:\\s+[^>]*)?\\s*/>`, "g");
  result = result.replace(selfRe, () => replacement);

  // Paired: <Name ...> ... </Name> (snippet bodies normally render via the
  // self-closing form, but handle the wrapping form too). Inner content is
  // discarded in favor of the inlined snippet body. The opening tag's attribute
  // run must not end in `/` (`[^>]*[^/>]`), so the pattern cannot match a
  // self-closing `<Name ... />` form even if the self-closing pass above left
  // one behind.
  const pairedRe = new RegExp(
    `<${n}(?:\\s+[^>]*[^/>])?>[\\s\\S]*?<\\/${n}>`,
    "g",
  );
  result = result.replace(pairedRe, () => replacement);

  return result;
}

/**
 * Inline MDX snippet imports into `content`.
 *
 * @param content - The MDX/markdown source of the host file.
 * @param hostAbsPath - Absolute filesystem path of the host file. Used to
 *   resolve the `@/` alias and relative snippet specifiers. If not absolute (or
 *   the alias root can't be located), snippet inlining is skipped and the
 *   original content is returned unchanged.
 * @param opts - Optional behavior overrides.
 * @returns The content with resolvable snippet imports inlined.
 */
export function inlineSnippetImports(
  content: string,
  hostAbsPath: string | undefined,
  opts: InlineSnippetOptions = {},
): string {
  if (!content || !hostAbsPath || !path.isAbsolute(hostAbsPath)) {
    return content;
  }
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  return inlineRecursive(content, hostAbsPath, maxDepth, new Set());
}

function inlineRecursive(
  content: string,
  hostAbsPath: string,
  depthRemaining: number,
  visited: Set<string>,
): string {
  if (depthRemaining <= 0) return content;

  const decls = parseImports(content);
  if (decls.length === 0) return content;

  const hostDir = path.dirname(hostAbsPath);
  const aliasRoot = findAliasRoot(hostDir);

  let result = content;

  for (const decl of decls) {
    const snippetAbs = resolveSpec(decl.spec, hostDir, aliasRoot);
    if (!snippetAbs) continue; // not a local snippet (or missing) — leave as-is

    // Cycle guard: never inline a file already on the current resolution path.
    if (visited.has(snippetAbs)) {
      // Drop the import + usage so cyclic refs don't leave dangling JSX, but
      // do not recurse again into the cycle.
      result = replaceUsages(result, decl.name, "");
      result = result.replace(decl.raw, "");
      continue;
    }

    let snippetBody: string;
    try {
      snippetBody = fs.readFileSync(snippetAbs, "utf-8");
    } catch {
      continue; // unreadable — leave the original import/usage untouched
    }

    snippetBody = stripFrontmatter(snippetBody);

    // Recurse into the snippet so nested snippets get inlined too.
    const nextVisited = new Set(visited);
    nextVisited.add(snippetAbs);
    const resolvedBody = inlineRecursive(
      snippetBody,
      snippetAbs,
      depthRemaining - 1,
      nextVisited,
    );

    // Inline the (recursively resolved) body wherever the component is used,
    // then remove the now-unused import line.
    result = replaceUsages(result, decl.name, `\n\n${resolvedBody.trim()}\n\n`);
    result = result.replace(decl.raw, "");
  }

  return result;
}
