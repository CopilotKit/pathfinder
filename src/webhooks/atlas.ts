import type { UpsertAtlasSeedCandidateInput } from "../db/atlas.js";
import type { AtlasSourceConfig } from "../types.js";
import { buildGitHubSeedContent } from "../atlas/adapters/github.js";

interface PullRequestUser {
  login?: unknown;
}

export interface AtlasPullRequestPayload {
  action?: unknown;
  repository?: {
    clone_url?: unknown;
    default_branch?: unknown;
    full_name?: unknown;
  };
  pull_request?: {
    number?: unknown;
    merged?: unknown;
    merge_commit_sha?: unknown;
    title?: unknown;
    body?: unknown;
    html_url?: unknown;
    base?: { ref?: unknown };
    head?: { ref?: unknown };
    user?: PullRequestUser;
    merged_by?: PullRequestUser | null;
  };
}

export interface AtlasPullRequestSeedExtraction {
  repoFullName: string;
  repoUrl: string;
  defaultBranch: string;
  baseBranch: string;
  isMergedPullRequest: boolean;
  candidates: UpsertAtlasSeedCandidateInput[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function extractAtlasPullRequestSeedCandidates(
  payload: AtlasPullRequestPayload,
  atlasSources: AtlasSourceConfig[],
  deliveryId: string | undefined,
): AtlasPullRequestSeedExtraction {
  // The repository fields and base.ref below are extracted UNCONDITIONALLY —
  // they are part of this function's return shape for ALL actions (the
  // not-merged early-return below carries them too), not just merged PRs.
  // GitHub pull_request payloads always include them, so a throw here means a
  // malformed payload — failing loud on malformed input is deliberate.
  const repoFullName = requireString(
    payload.repository?.full_name,
    "repository.full_name",
  );
  const repoUrl = requireString(
    payload.repository?.clone_url,
    "repository.clone_url",
  );
  const defaultBranch = requireString(
    payload.repository?.default_branch,
    "repository.default_branch",
  );
  const pr = payload.pull_request;
  if (!pr || typeof pr !== "object") {
    throw new Error("Missing pull_request");
  }

  const baseBranch = requireString(pr.base?.ref, "pull_request.base.ref");
  const isMergedPullRequest = payload.action === "closed" && pr.merged === true;
  if (!isMergedPullRequest) {
    return {
      repoFullName,
      repoUrl,
      defaultBranch,
      baseBranch,
      isMergedPullRequest,
      candidates: [],
    };
  }

  const prNumber =
    typeof pr.number === "number" && Number.isInteger(pr.number)
      ? pr.number
      : null;
  if (prNumber == null) {
    throw new Error("Missing pull_request.number");
  }
  const title = requireString(pr.title, "pull_request.title");
  const url = requireString(pr.html_url, "pull_request.html_url");
  const mergeSha = optionalString(pr.merge_commit_sha);
  const body = optionalString(pr.body);
  const author = optionalString(pr.user?.login);
  const mergedBy = optionalString(pr.merged_by?.login);
  const headBranch = optionalString(pr.head?.ref);
  const ref = baseBranch;
  // Body→content assembly is the ONE piece of code shared with the batch GitHub
  // adapter (B2). The webhook passes its RAW body and the historic fallback so
  // its output stays byte-identical (raw title + raw body); the batch adapter
  // reuses the same helper with a distilled body. Nothing else is shared — the
  // webhook keeps its own `[{ type: "pull_request", ... }]` evidence + raw title.
  const content = buildGitHubSeedContent({
    kindLabel: "PR",
    number: prNumber,
    title,
    repoFullName,
    baseBranch,
    headBranch,
    mergeSha,
    author,
    mergedBy,
    url,
    bodyText: body,
    emptyBodyFallback: "(No pull request body provided.)",
  });

  return {
    repoFullName,
    repoUrl,
    defaultBranch,
    baseBranch,
    isMergedPullRequest,
    candidates: atlasSources.map((source) => ({
      // NOTE: this webhook key grammar (`github-pr:<source>:<repo>:<n>`)
      // deliberately differs from the batch-harvest grammar
      // (`<sourcetype>:<subsystem>:<claim-slug>` via buildCanonicalKey, i.e.
      // `github-pr:<repo>:<slug>` since the github adapter's subsystem is the
      // repo fullName) — unifying the two is the documented S20/spec
      // follow-up (R6 V92).
      canonicalKey: `github-pr:${source.name}:${repoFullName}:${prNumber}`,
      sourceName: source.name,
      repoUrl,
      ref,
      subsystem: null,
      title: `PR #${prNumber}: ${title}`,
      content,
      provenance: {
        provider: "github",
        event: "pull_request",
        delivery_id: deliveryId ?? null,
        repo: repoFullName,
        pr_number: prNumber,
        url,
        base_branch: baseBranch,
        head_branch: headBranch,
        merge_commit_sha: mergeSha,
      },
      evidence: [
        {
          type: "pull_request",
          url,
          title,
          body,
        },
      ],
    })),
  };
}
