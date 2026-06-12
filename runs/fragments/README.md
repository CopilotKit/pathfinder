# Atlas Harvest — fragment on-disk contract

Fragments under `<runs-dir>/<run-id>/fragments/<stem>.json` are the canonical
durable artifact of a Tier-1 leaf-fleet run. They are the seam between the
agent-orchestration half (the leaf fleet) and the deterministic in-process
half (`atlas harvest run` and downstream tiers).

## On-disk format

One JSON object per file, pretty-printed, validated against
`CandidateFragmentSchema` (in `src/atlas/types.ts`) — or
`EpisodicCandidateFragmentSchema` when `sourcetype: "episodic"`, which layers
the four episodic-invariant refinements (`needsReview`, `provenance_class`,
`confidence`, `validation_status`) on top of the base.

See `scripts/atlas-harvest/leaf-prompt.md` for the field-by-field contract and
worked examples.

## Stem derivation

The file stem is supplied explicitly via `--stem <stem>` to the
`atlas harvest write-fragment` CLI. When `--stem` is omitted, the stem is
derived from the fragment's canonical-key components — concretely
`claimSlug(<sourcetype>:<subsystem>:claimSlug(claimSlugHint || title))`
(`claimSlugHint` is optional on `CandidateFragmentSchema`; the CLI falls back
to the fragment `title` when no hint is supplied). The stem derivation and
the fragment's `canonical_key` are produced by different functions and yield
different strings — the stem is a filesystem-safe slug, not a copy of the
canonical key. The derivation is still idempotent across runs and two
fragments with the same claim text but different sourcetype/subsystem never
collide.

## Canonical write boundary

Only `atlas harvest write-fragment --stdin` writes into this directory in
Phase 0. Direct `fs.writeFile` from leaves is deprecated as of Phase 0 — it
still works (existing leaves are not broken) but it is no longer the supported
write path, and Phase 1 will remove the leaf-side writer entirely.

The write CLI reads a single fragment JSON from stdin, validates it, and
writes it to `<runs-dir>/<run-id>/fragments/<stem>.json`.

## Schema validation

The CLI Zod-parses the input before writing. Exit-code matrix (spec §4.2.1):

- `0` — success (fragment written; absolute path printed to stdout)
- `1` — stdin/IO failure (bad JSON, unreadable stdin, write error other than EEXIST)
- `2` — stem collision (file already exists)
- `3` — schema validation failure (base `CandidateFragmentSchema` rejected the input)
- `4` — episodic invariant violation (one of `needsReview`/`provenance_class`/`confidence`/`validation_status` failed the episodic refinement)

stderr always carries the underlying Zod / IO error message; the exit code
distinguishes the FAILURE CLASS so the caller (leaf adapter, CI gate) can
route accordingly.

## Atomic create

The CLI creates fragment files EXCLUSIVELY (the underlying open uses the `wx`
flag). A pre-existing file at the same stem yields exit code 2 (`EEXIST`) and
no write occurs — the prior fragment is never silently overwritten.

To re-mint a fragment at the same stem, delete the file first (or run with a
fresh `--run-id`).
