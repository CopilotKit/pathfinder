import type { UpsertAtlasSeedCandidateInput } from "../db/atlas.js";
import type { AtlasSourceConfig } from "../types.js";

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
  const content = [
    `# PR #${prNumber}: ${title}`,
    "",
    `Repository: ${repoFullName}`,
    `Base branch: ${baseBranch}`,
    headBranch ? `Head branch: ${headBranch}` : null,
    mergeSha ? `Merge commit: ${mergeSha}` : null,
    author ? `Author: ${author}` : null,
    mergedBy ? `Merged by: ${mergedBy}` : null,
    `URL: ${url}`,
    "",
    body ?? "(No pull request body provided.)",
  ]
    .filter((line): line is string => line != null)
    .join("\n");

  return {
    repoFullName,
    repoUrl,
    defaultBranch,
    baseBranch,
    isMergedPullRequest,
    candidates: atlasSources.map((source) => ({
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
