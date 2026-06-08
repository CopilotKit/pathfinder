import { getPool } from "./client.js";

const CACHE_CONTENT_KEY = "__atlas_content";

export type AtlasSeedStatus = "pending" | "approved" | "rejected";

export interface AtlasSeedEntry {
  id: number;
  canonicalKey: string;
  sourceName: string;
  repoUrl: string | null;
  ref: string | null;
  subsystem: string | null;
  status: AtlasSeedStatus;
  title: string;
  content: string;
  provenance: Record<string, unknown>;
  evidence: unknown[];
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class AtlasSeedNotPendingError extends Error {
  readonly code = "ATLAS_SEED_NOT_PENDING" as const;
  constructor(
    public readonly canonicalKey: string,
    public readonly action: "approve" | "reject",
  ) {
    super(
      `Cannot ${action} atlas seed entry "${canonicalKey}" because it is missing or not pending`,
    );
    this.name = "AtlasSeedNotPendingError";
  }
}

export interface UpsertAtlasSeedCandidateInput {
  canonicalKey: string;
  sourceName: string;
  repoUrl?: string | null;
  ref?: string | null;
  subsystem?: string | null;
  title: string;
  content: string;
  provenance: Record<string, unknown>;
  evidence: unknown[];
}

export interface AtlasCachePage {
  id: number;
  pageKey: string;
  sourceName: string;
  title: string;
  content: string;
  contentHash: string;
  stale: boolean;
  staleReason: string | null;
  generatedSeedIds: number[];
  provenance: Record<string, unknown>;
  generatedAt: Date | null;
  errorAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertAtlasCachePageInput {
  pageKey: string;
  sourceName: string;
  title: string;
  content: string;
  contentHash: string;
  generatedSeedIds?: number[];
  provenance?: Record<string, unknown>;
  generatedAt?: Date | null;
}

export interface ClearAtlasCachePageStaleInput {
  pageKey: string;
  content: string;
  contentHash: string;
  generatedSeedIds?: number[];
  provenance?: Record<string, unknown>;
  generatedAt?: Date | null;
}

export interface AtlasRepositoryFilter {
  repoUrl: string;
  refs?: string[];
  subsystems?: string[];
}

export interface AtlasContentQuery {
  changedAfter?: Date;
  changedOnOrBefore?: Date;
  repositories?: AtlasRepositoryFilter[];
}

export type AtlasIndexableContent =
  | {
      kind: "seed";
      key: string;
      sourceName: string;
      title: string;
      content: string;
      updatedAt: Date;
      seed: AtlasSeedEntry;
    }
  | {
      kind: "cache";
      key: string;
      sourceName: string;
      title: string;
      content: string;
      updatedAt: Date;
      cachePage: AtlasCachePage;
    };

// Parse a JSON string column with row-attributed context. A single malformed
// `provenance`/`evidence`/`generated_seed_ids` blob would otherwise throw a
// bare SyntaxError with no row identity and — because the list queries map
// every row — poison the WHOLE list query into an opaque 500 that hides all
// the valid rows. `ctx` names the column + offending row so the failure is
// actionable.
function parseJsonString<T>(value: string, ctx: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON for ${ctx}: ${detail}`);
  }
}

function parseJsonObject(value: unknown, ctx: string): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") {
    return parseJsonString<Record<string, unknown>>(value, ctx);
  }
  return value as Record<string, unknown>;
}

function parseJsonArray(value: unknown, ctx: string): unknown[] {
  if (value == null) return [];
  if (typeof value === "string") {
    return parseJsonString<unknown[]>(value, ctx);
  }
  return value as unknown[];
}

function parseNumberArray(value: unknown, ctx: string): number[] {
  return parseJsonArray(value, ctx).filter(
    (item): item is number => typeof item === "number",
  );
}

function toDate(value: unknown, ctx?: string): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const d = new Date(value as string);
  if (isNaN(d.getTime())) {
    console.warn(
      `[atlas] Ignoring invalid timestamp${ctx ? ` for ${ctx}` : ""}: ` +
        `${JSON.stringify(value)}`,
    );
    return null;
  }
  return d;
}

function mapSeedRow(row: Record<string, unknown>): AtlasSeedEntry {
  const ctx = `seed row id=${row.id} key=${String(row.canonical_key)}`;
  return {
    id: Number(row.id),
    canonicalKey: row.canonical_key as string,
    sourceName: row.source_name as string,
    repoUrl: (row.repo_url as string | null) ?? null,
    ref: (row.ref as string | null) ?? null,
    subsystem: (row.subsystem as string | null) ?? null,
    status: row.status as AtlasSeedStatus,
    title: row.title as string,
    content: row.content as string,
    provenance: parseJsonObject(row.provenance, `provenance of ${ctx}`),
    evidence: parseJsonArray(row.evidence, `evidence of ${ctx}`),
    approvedBy: (row.approved_by as string | null) ?? null,
    approvedAt: toDate(row.approved_at, `approved_at of ${ctx}`),
    rejectedBy: (row.rejected_by as string | null) ?? null,
    rejectedAt: toDate(row.rejected_at, `rejected_at of ${ctx}`),
    rejectionReason: (row.rejection_reason as string | null) ?? null,
    createdAt: toDate(row.created_at, `created_at of ${ctx}`) ?? new Date(0),
    updatedAt: toDate(row.updated_at, `updated_at of ${ctx}`) ?? new Date(0),
  };
}

function mapCacheRow(row: Record<string, unknown>): AtlasCachePage {
  const ctx = `cache row id=${row.id} key=${String(row.page_key)}`;
  const rawProvenance = parseJsonObject(row.provenance, `provenance of ${ctx}`);
  const { [CACHE_CONTENT_KEY]: contentValue, ...provenance } = rawProvenance;
  return {
    id: Number(row.id),
    pageKey: row.page_key as string,
    sourceName: row.source_name as string,
    title: row.title as string,
    content: typeof contentValue === "string" ? contentValue : "",
    contentHash: row.content_hash as string,
    stale: Boolean(row.stale),
    staleReason: (row.stale_reason as string | null) ?? null,
    generatedSeedIds: parseNumberArray(
      row.generated_seed_ids,
      `generated_seed_ids of ${ctx}`,
    ),
    provenance,
    generatedAt: toDate(row.generated_at, `generated_at of ${ctx}`),
    errorAt: toDate(row.error_at, `error_at of ${ctx}`),
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: toDate(row.created_at, `created_at of ${ctx}`) ?? new Date(0),
    updatedAt: toDate(row.updated_at, `updated_at of ${ctx}`) ?? new Date(0),
  };
}

function cacheProvenance(
  content: string,
  provenance: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...provenance,
    [CACHE_CONTENT_KEY]: content,
  };
}

function addUpdatedAtClauses(
  alias: string,
  query: Pick<AtlasContentQuery, "changedAfter" | "changedOnOrBefore">,
  params: unknown[],
): string[] {
  const clauses: string[] = [];
  if (query.changedAfter) {
    params.push(query.changedAfter);
    clauses.push(`${alias}.updated_at > $${params.length}`);
  }
  if (query.changedOnOrBefore) {
    params.push(query.changedOnOrBefore);
    clauses.push(`${alias}.updated_at <= $${params.length}`);
  }
  return clauses;
}

function addSeedRepositoryClause(
  alias: string,
  repositories: AtlasRepositoryFilter[] | undefined,
  params: unknown[],
): string | null {
  if (!repositories || repositories.length === 0) return null;

  const repositoryClauses = repositories.map((repository) => {
    params.push(repository.repoUrl);
    const clauses = [`${alias}.repo_url = $${params.length}`];
    if (repository.refs && repository.refs.length > 0) {
      params.push(repository.refs);
      clauses.push(`${alias}.ref = ANY($${params.length}::text[])`);
    }
    if (repository.subsystems && repository.subsystems.length > 0) {
      params.push(repository.subsystems);
      clauses.push(`${alias}.subsystem = ANY($${params.length}::text[])`);
    }
    return `(${clauses.join(" AND ")})`;
  });

  return `(${repositoryClauses.join(" OR ")})`;
}

function addCacheRepositoryClause(
  repositories: AtlasRepositoryFilter[] | undefined,
  params: unknown[],
): string | null {
  const seedRepositoryClause = addSeedRepositoryClause(
    "seed",
    repositories,
    params,
  );
  if (!seedRepositoryClause) return null;
  return `
    EXISTS (
      SELECT 1
      FROM atlas_seed_entries seed
      JOIN jsonb_array_elements_text(cache.generated_seed_ids) generated(seed_id)
        ON generated.seed_id::integer = seed.id
      WHERE ${seedRepositoryClause}
    )
  `;
}

export async function upsertAtlasSeedCandidate(
  input: UpsertAtlasSeedCandidateInput,
): Promise<AtlasSeedEntry> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
      INSERT INTO atlas_seed_entries (
        canonical_key,
        source_name,
        repo_url,
        ref,
        subsystem,
        title,
        content,
        provenance,
        evidence
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
      ON CONFLICT (canonical_key) DO UPDATE SET
        source_name = CASE
          WHEN atlas_seed_entries.status = 'pending' THEN EXCLUDED.source_name
          ELSE atlas_seed_entries.source_name
        END,
        repo_url = CASE
          WHEN atlas_seed_entries.status = 'pending' THEN EXCLUDED.repo_url
          ELSE atlas_seed_entries.repo_url
        END,
        ref = CASE
          WHEN atlas_seed_entries.status = 'pending' THEN EXCLUDED.ref
          ELSE atlas_seed_entries.ref
        END,
        subsystem = CASE
          WHEN atlas_seed_entries.status = 'pending' THEN EXCLUDED.subsystem
          ELSE atlas_seed_entries.subsystem
        END,
        title = CASE
          WHEN atlas_seed_entries.status = 'pending' THEN EXCLUDED.title
          ELSE atlas_seed_entries.title
        END,
        content = CASE
          WHEN atlas_seed_entries.status = 'pending' THEN EXCLUDED.content
          ELSE atlas_seed_entries.content
        END,
        provenance = CASE
          WHEN atlas_seed_entries.status = 'pending' THEN EXCLUDED.provenance
          ELSE atlas_seed_entries.provenance
        END,
        evidence = CASE
          WHEN atlas_seed_entries.status = 'pending' THEN EXCLUDED.evidence
          ELSE atlas_seed_entries.evidence
        END,
        updated_at = CASE
          WHEN atlas_seed_entries.status = 'pending' THEN NOW()
          ELSE atlas_seed_entries.updated_at
        END
      RETURNING *
    `,
    [
      input.canonicalKey,
      input.sourceName,
      input.repoUrl ?? null,
      input.ref ?? null,
      input.subsystem ?? null,
      input.title,
      input.content,
      JSON.stringify(input.provenance),
      JSON.stringify(input.evidence),
    ],
  );
  return mapSeedRow(rows[0] as Record<string, unknown>);
}

export async function approveAtlasSeedEntry(
  canonicalKey: string,
  actor: string,
): Promise<AtlasSeedEntry> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
      UPDATE atlas_seed_entries
      SET
        status = 'approved',
        approved_by = $2,
        approved_at = NOW(),
        rejected_by = NULL,
        rejected_at = NULL,
        rejection_reason = NULL,
        updated_at = NOW()
      WHERE canonical_key = $1 AND status = 'pending'
      RETURNING *
    `,
    [canonicalKey, actor],
  );
  if (rows[0]) return mapSeedRow(rows[0] as Record<string, unknown>);
  throw new AtlasSeedNotPendingError(canonicalKey, "approve");
}

export async function rejectAtlasSeedEntry(
  canonicalKey: string,
  actor: string,
  reason: string,
): Promise<AtlasSeedEntry> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
      UPDATE atlas_seed_entries
      SET
        status = 'rejected',
        rejected_by = $2,
        rejected_at = NOW(),
        rejection_reason = $3,
        updated_at = NOW()
      WHERE canonical_key = $1 AND status = 'pending'
      RETURNING *
    `,
    [canonicalKey, actor, reason],
  );
  if (rows[0]) return mapSeedRow(rows[0] as Record<string, unknown>);
  throw new AtlasSeedNotPendingError(canonicalKey, "reject");
}

export async function listPendingAtlasSeedCandidates(filter?: {
  sourceName?: string;
}): Promise<AtlasSeedEntry[]> {
  const pool = getPool();
  const params: unknown[] = [];
  const clauses = ["status = 'pending'"];
  if (filter?.sourceName) {
    params.push(filter.sourceName);
    clauses.push(`source_name = $${params.length}`);
  }
  const { rows } = await pool.query(
    `
      SELECT *
      FROM atlas_seed_entries
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC, id ASC
    `,
    params,
  );
  return rows.map((row) => mapSeedRow(row as Record<string, unknown>));
}

export async function upsertAtlasCachePage(
  input: UpsertAtlasCachePageInput,
): Promise<AtlasCachePage> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
      INSERT INTO atlas_cache_pages (
        page_key,
        source_name,
        title,
        content_hash,
        stale,
        stale_reason,
        generated_seed_ids,
        provenance,
        generated_at,
        error_at,
        error_message
      )
      VALUES ($1, $2, $3, $4, FALSE, NULL, $5::jsonb, $6::jsonb, $7, NULL, NULL)
      ON CONFLICT (page_key) DO UPDATE SET
        source_name = EXCLUDED.source_name,
        title = EXCLUDED.title,
        content_hash = EXCLUDED.content_hash,
        stale = FALSE,
        stale_reason = NULL,
        generated_seed_ids = EXCLUDED.generated_seed_ids,
        provenance = EXCLUDED.provenance,
        generated_at = EXCLUDED.generated_at,
        error_at = NULL,
        error_message = NULL,
        updated_at = NOW()
      RETURNING *
    `,
    [
      input.pageKey,
      input.sourceName,
      input.title,
      input.contentHash,
      JSON.stringify(input.generatedSeedIds ?? []),
      JSON.stringify(cacheProvenance(input.content, input.provenance)),
      input.generatedAt ?? new Date(),
    ],
  );
  return mapCacheRow(rows[0] as Record<string, unknown>);
}

export async function markAtlasCachePageStale(
  pageKey: string,
  reason: string,
): Promise<AtlasCachePage> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
      UPDATE atlas_cache_pages
      SET stale = TRUE, stale_reason = $2, updated_at = NOW()
      WHERE page_key = $1
      RETURNING *
    `,
    [pageKey, reason],
  );
  if (rows[0]) return mapCacheRow(rows[0] as Record<string, unknown>);
  throw new Error(`Atlas cache page "${pageKey}" not found`);
}

export async function markAtlasCachePagesStaleForSources(
  sourceNames: string[],
  reason: string,
): Promise<number> {
  if (sourceNames.length === 0) return 0;
  const pool = getPool();
  const { rows } = await pool.query(
    `
      UPDATE atlas_cache_pages cache
      SET stale = TRUE, stale_reason = $2, updated_at = NOW()
      WHERE
        cache.source_name = ANY($1::text[])
        OR EXISTS (
          SELECT 1
          FROM atlas_seed_entries seed
          JOIN jsonb_array_elements_text(cache.generated_seed_ids) generated(seed_id)
            ON generated.seed_id::integer = seed.id
          WHERE seed.source_name = ANY($1::text[])
        )
      RETURNING id
    `,
    [sourceNames, reason],
  );
  return rows.length;
}

export async function clearAtlasCachePageStale(
  input: ClearAtlasCachePageStaleInput,
): Promise<AtlasCachePage> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
      UPDATE atlas_cache_pages
      SET
        content_hash = $2,
        stale = FALSE,
        stale_reason = NULL,
        generated_seed_ids = COALESCE($3::jsonb, generated_seed_ids),
        provenance = provenance || $4::jsonb,
        generated_at = $5,
        error_at = NULL,
        error_message = NULL,
        updated_at = NOW()
      WHERE page_key = $1
      RETURNING *
    `,
    [
      input.pageKey,
      input.contentHash,
      input.generatedSeedIds ? JSON.stringify(input.generatedSeedIds) : null,
      JSON.stringify(cacheProvenance(input.content, input.provenance)),
      input.generatedAt ?? new Date(),
    ],
  );
  if (rows[0]) return mapCacheRow(rows[0] as Record<string, unknown>);
  throw new Error(`Atlas cache page "${input.pageKey}" not found`);
}

export async function recordAtlasCachePageGenerationError(
  pageKey: string,
  errorMessage: string,
): Promise<AtlasCachePage> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
      UPDATE atlas_cache_pages
      SET
        stale = TRUE,
        stale_reason = COALESCE(stale_reason, 'generation failed'),
        error_at = NOW(),
        error_message = $2,
        updated_at = NOW()
      WHERE page_key = $1
      RETURNING *
    `,
    [pageKey, errorMessage],
  );
  if (rows[0]) return mapCacheRow(rows[0] as Record<string, unknown>);
  throw new Error(`Atlas cache page "${pageKey}" not found`);
}

export async function listStaleAtlasCachePages(filter?: {
  sourceName?: string;
}): Promise<AtlasCachePage[]> {
  const pool = getPool();
  const params: unknown[] = [];
  const clauses = ["stale = TRUE"];
  if (filter?.sourceName) {
    params.push(filter.sourceName);
    clauses.push(`source_name = $${params.length}`);
  }
  const { rows } = await pool.query(
    `
      SELECT *
      FROM atlas_cache_pages
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at ASC, id ASC
    `,
    params,
  );
  return rows.map((row) => mapCacheRow(row as Record<string, unknown>));
}

export async function listIndexableAtlasContent(
  sourceName: string,
  query: AtlasContentQuery = {},
): Promise<AtlasIndexableContent[]> {
  const pool = getPool();
  const seedParams: unknown[] = [sourceName];
  const seedClauses = [
    "seed.source_name = $1",
    "seed.status = 'approved'",
    ...addUpdatedAtClauses("seed", query, seedParams),
  ];
  const seedRepositoryClause = addSeedRepositoryClause(
    "seed",
    query.repositories,
    seedParams,
  );
  if (seedRepositoryClause) seedClauses.push(seedRepositoryClause);

  const cacheParams: unknown[] = [sourceName];
  const cacheClauses = [
    "cache.source_name = $1",
    "cache.stale = FALSE",
    ...addUpdatedAtClauses("cache", query, cacheParams),
  ];
  const cacheRepositoryClause = addCacheRepositoryClause(
    query.repositories,
    cacheParams,
  );
  if (cacheRepositoryClause) cacheClauses.push(cacheRepositoryClause);

  const [seedResult, cacheResult] = await Promise.all([
    pool.query(
      `
        SELECT seed.*
        FROM atlas_seed_entries seed
        WHERE ${seedClauses.join(" AND ")}
        ORDER BY seed.updated_at ASC, seed.id ASC
      `,
      seedParams,
    ),
    pool.query(
      `
        SELECT cache.*
        FROM atlas_cache_pages cache
        WHERE ${cacheClauses.join(" AND ")}
        ORDER BY cache.updated_at ASC, cache.id ASC
      `,
      cacheParams,
    ),
  ]);

  const seeds = seedResult.rows.map((row) => {
    const seed = mapSeedRow(row as Record<string, unknown>);
    return {
      kind: "seed" as const,
      key: seed.canonicalKey,
      sourceName: seed.sourceName,
      title: seed.title,
      content: seed.content,
      updatedAt: seed.updatedAt,
      seed,
    };
  });

  const cachePages = cacheResult.rows
    .map((row) => mapCacheRow(row as Record<string, unknown>))
    .filter((cachePage) => cachePage.content.length > 0)
    .map((cachePage) => ({
      kind: "cache" as const,
      key: cachePage.pageKey,
      sourceName: cachePage.sourceName,
      title: cachePage.title,
      content: cachePage.content,
      updatedAt: cachePage.updatedAt,
      cachePage,
    }));

  return [...seeds, ...cachePages].sort((a, b) => {
    const byTime = a.updatedAt.getTime() - b.updatedAt.getTime();
    if (byTime !== 0) return byTime;
    if (a.kind !== b.kind) return a.kind === "seed" ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

export async function listRemovedAtlasContentIds(
  sourceName: string,
  query: AtlasContentQuery = {},
): Promise<string[]> {
  const pool = getPool();
  const seedParams: unknown[] = [sourceName];
  const seedClauses = [
    "seed.source_name = $1",
    "seed.status = 'rejected'",
    ...addUpdatedAtClauses("seed", query, seedParams),
  ];
  const seedRepositoryClause = addSeedRepositoryClause(
    "seed",
    query.repositories,
    seedParams,
  );
  if (seedRepositoryClause) seedClauses.push(seedRepositoryClause);

  const cacheParams: unknown[] = [sourceName];
  const cacheClauses = [
    "cache.source_name = $1",
    `(cache.stale = TRUE OR COALESCE(cache.provenance ->> '${CACHE_CONTENT_KEY}', '') = '')`,
    ...addUpdatedAtClauses("cache", query, cacheParams),
  ];
  const cacheRepositoryClause = addCacheRepositoryClause(
    query.repositories,
    cacheParams,
  );
  if (cacheRepositoryClause) cacheClauses.push(cacheRepositoryClause);

  const [seedResult, cacheResult] = await Promise.all([
    pool.query(
      `
        SELECT seed.canonical_key
        FROM atlas_seed_entries seed
        WHERE ${seedClauses.join(" AND ")}
        ORDER BY seed.updated_at ASC, seed.id ASC
      `,
      seedParams,
    ),
    pool.query(
      `
        SELECT cache.page_key
        FROM atlas_cache_pages cache
        WHERE ${cacheClauses.join(" AND ")}
        ORDER BY cache.updated_at ASC, cache.id ASC
      `,
      cacheParams,
    ),
  ]);

  return [
    ...seedResult.rows.map(
      (row) =>
        `atlas-seed:${(row as Record<string, unknown>).canonical_key as string}`,
    ),
    ...cacheResult.rows.map(
      (row) =>
        `atlas-cache:${(row as Record<string, unknown>).page_key as string}`,
    ),
  ];
}

export async function getAtlasStateToken(
  sourceName: string,
  query: Pick<AtlasContentQuery, "repositories"> = {},
): Promise<string | null> {
  const pool = getPool();
  const seedParams: unknown[] = [sourceName];
  const seedClauses = [
    "seed.source_name = $1",
    "seed.status IN ('approved', 'rejected')",
  ];
  const seedRepositoryClause = addSeedRepositoryClause(
    "seed",
    query.repositories,
    seedParams,
  );
  if (seedRepositoryClause) seedClauses.push(seedRepositoryClause);

  const cacheParams: unknown[] = [sourceName];
  const cacheClauses = ["cache.source_name = $1"];
  const cacheRepositoryClause = addCacheRepositoryClause(
    query.repositories,
    cacheParams,
  );
  if (cacheRepositoryClause) cacheClauses.push(cacheRepositoryClause);

  const [seedResult, cacheResult] = await Promise.all([
    pool.query(
      `
        SELECT MAX(seed.updated_at) AS state_token
        FROM atlas_seed_entries seed
        WHERE ${seedClauses.join(" AND ")}
      `,
      seedParams,
    ),
    pool.query(
      `
        SELECT MAX(cache.updated_at) AS state_token
        FROM atlas_cache_pages cache
        WHERE ${cacheClauses.join(" AND ")}
      `,
      cacheParams,
    ),
  ]);

  const values = [
    seedResult.rows[0]?.state_token,
    cacheResult.rows[0]?.state_token,
  ]
    .map((value) => toDate(value, "atlas state token"))
    .filter((value): value is Date => value !== null);
  if (values.length === 0) return null;
  return new Date(
    Math.max(...values.map((value) => value.getTime())),
  ).toISOString();
}

// Test-only exports of the otherwise-private row mappers and timestamp parser.
// These are pure functions; exporting them lets us unit-test the robustness
// paths (malformed JSON → context-bearing error, invalid timestamp → null)
// directly without contriving a backing store that can hold malformed columns.
export const __testing = {
  mapSeedRow,
  mapCacheRow,
  toDate,
};
