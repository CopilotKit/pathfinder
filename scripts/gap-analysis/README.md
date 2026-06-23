# Monthly Gap Analysis

A scheduled pipeline that surfaces the documentation/knowledge gaps in
Pathfinder's indexed corpus by analyzing what users actually search for — and
what comes back empty — over a rolling 30-day window.

It runs from the [`monthly-gap-analysis.yml`](../../.github/workflows/monthly-gap-analysis.yml)
GitHub Action on the 1st of each month (04:00 UTC, after the nightly reindex)
and can be triggered manually via `workflow_dispatch`.

## What it does

1. **Reads** the analytics JSON API on the production MCP
   (`GET /api/analytics/{summary,queries,empty-queries}?days=30`).
2. **Filters** out synthetic/internal probe queries (see "Why no live MCP
   queries" below).
3. **Clusters** the top and empty-result queries deterministically (normalized
   key: lowercase → strip punctuation → drop stop words → crudely singularize
   trailing-`s` tokens → sort tokens) so near-identical phrasings collapse into
   one bucket.
4. Runs **one** LLM classification pass (Anthropic) to rank the clusters into a
   severity-tagged gap report. If no API key is provided it falls back to a
   deterministic report derived from the empty-result clusters.
5. **Publishes** the markdown report by creating a new dated Notion page under
   Plans / Proposals each run (it does not update a prior page).
6. **Alerts Slack** — but only when a _new_ high-severity gap appears versus the
   prior run. "New" is compared on the stable normalized key of each gap
   (lowercase → strip punctuation → drop stop words → singularize → sort
   tokens), via a small state file carried across runs as a GitHub Actions
   **artifact**. This collapses only _trivial_ rewordings (casing, punctuation,
   stop words, word order) of the same gap so they don't re-alert; a
   _substantial_ semantic rephrasing of the same underlying gap (different
   significant tokens) may still re-alert. The same normalization de-duplicates
   trivially-reworded gaps **within** a single run too, so one underlying gap
   yields one bullet and one stored key.

## Why no live MCP queries

This pipeline READS the analytics JSON API and works only from that data — it
does **not** read the indexed repos and deliberately does **not** reproduce
search queries against the live MCP. The first manual gap-analysis run did
exactly that, and its probe queries were logged back into analytics and then
counted as "real" user demand on the next pass — a self-inflation loop. Reading
the analytics API (and stripping the known synthetic shapes) avoids polluting
the very signal it measures.

## Required secrets

Configure the per-repo ones as **repository secrets** (Settings → Secrets and
variables → Actions); `SLACK_WEBHOOK_ENGR` is an **org-level** secret
and is already provisioned. The workflow runs without
any of them, but no-ops gracefully until they are provisioned, so CI/lint and
dry runs stay green.

| Secret                       | Purpose                                                                                                                                          | When unset                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `PATHFINDER_ANALYTICS_TOKEN` | Bearer token for `GET /api/analytics/*` on the production MCP (`https://mcp.copilotkit.ai`).                                                     | Script logs "skipping live fetch" and exits 0.                             |
| `ANTHROPIC_API_KEY`          | Anthropic key for the single LLM classification/summarization pass.                                                                              | Deterministic fallback report is produced from the clusters (no LLM call). |
| `NOTION_TOKEN`               | Notion integration token used to publish the report page.                                                                                        | Notion publish step is skipped.                                            |
| `SLACK_WEBHOOK_ENGR`         | Org-level incoming-webhook URL for **#engr**. The gap report (a successful-run signal) posts here only when new high-severity gaps are detected. | No Slack alert is sent.                                                    |

> **Slack env var name + channel:** the _script_ reads the webhook URL from
> `SLACK_WEBHOOK`, not `SLACK_WEBHOOK_ENGR`. The workflow bridges the two by
> mapping the org secret into the script's variable
> (`SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_ENGR }}`), so in CI the gap report
> posts to **#engr** automatically; a **local** run must export `SLACK_WEBHOOK`
> itself — otherwise the alert step is a silent no-op. Run FAILURES are surfaced
> as a red CI run, not a Slack alert.

The Notion parent page id defaults to the Gap-Reports page
(`3793aa38-1852-80a5-89d3-c3d37147aa22`) and can be overridden with the
`NOTION_PARENT_PAGE_ID` env var.

## Running locally

```bash
# Dry/no-secrets mode — exits 0 without touching the network.
npx tsx scripts/gap-analysis/monthly-gap-analysis.ts

# Write the rendered report to a file.
npx tsx scripts/gap-analysis/monthly-gap-analysis.ts --report /tmp/gap.md

# Full run against the production analytics API (deterministic report unless
# ANTHROPIC_API_KEY is also set; Notion/Slack skipped unless their secrets are).
PATHFINDER_ANALYTICS_TOKEN=... \
  npx tsx scripts/gap-analysis/monthly-gap-analysis.ts --report /tmp/gap.md

# --dry-run suppresses the durable state-file write (the uploaded artifact
# lineage) and ALL external side effects even when the secrets are present —
# no Notion publish, no Slack alert, no state-file write (useful for verifying
# fetch + clustering live without mutating anything). A `--report <path>` you
# explicitly request is STILL written: it is a requested local output (a
# preview), not an external side effect, so dry-run + --report previews the
# rendered report on disk without touching state, Notion, or Slack.
PATHFINDER_ANALYTICS_TOKEN=... NOTION_TOKEN=... \
  npx tsx scripts/gap-analysis/monthly-gap-analysis.ts --dry-run --report /tmp/gap.md
```

### Useful env overrides

| Var                     | Default                                   | Notes                                                                                                                       |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ANALYTICS_BASE_URL`    | `https://mcp.copilotkit.ai`               | Point at a local/staging MCP.                                                                                               |
| `GAP_ANALYSIS_DAYS`     | `30`                                      | Lookback window.                                                                                                            |
| `GAP_STATE_PATH`        | `/tmp/pathfinder-gap-analysis-state.json` | Prior-run state for new-gap diffing.                                                                                        |
| `ANTHROPIC_MODEL`       | `claude-haiku-4-5-20251001`               | Override the model id.                                                                                                      |
| `NOTION_PARENT_PAGE_ID` | Gap-Reports page                          | Where the report page is created.                                                                                           |
| `SLACK_WEBHOOK`         | _(unset)_                                 | Webhook the gap report posts to (#engr). The workflow maps `SLACK_WEBHOOK_ENGR` into it; set it directly for a local alert. |

## Files

- [`monthly-gap-analysis.ts`](./monthly-gap-analysis.ts) — entry point /
  orchestration (fetch → cluster → LLM → Notion → Slack).
- [`cluster.ts`](./cluster.ts) — pure, dependency-free synthetic-filter and
  clustering helpers.
- [`cluster.test.ts`](./cluster.test.ts) — unit tests for the filter +
  clustering logic (run with `npm test`).
- [`monthly-gap-analysis.test.ts`](./monthly-gap-analysis.test.ts) — unit tests
  for the pure orchestration helpers (days validation, gap classification,
  JSON parsing, stable new-gap dedup, state round-trip).

## Scope (MVP)

This is the single-pass MVP: one deterministic clustering step plus one LLM
classification pass. The full multi-agent diagnosis fleet is intentionally out
of scope.
