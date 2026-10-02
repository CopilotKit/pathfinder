import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  generateSchema,
  generateMigration,
  generatePostSchemaMigration,
} from "../db/schema.js";

describe("generateSchema", () => {
  it("returns SQL containing the vector extension", () => {
    const ddl = generateSchema(1536);
    expect(ddl).toContain("CREATE EXTENSION IF NOT EXISTS vector");
  });

  it("includes the correct vector dimension in the chunks table", () => {
    const ddl = generateSchema(1536);
    expect(ddl).toContain("vector(1536)");
  });

  it("parameterizes dimensions correctly for different values", () => {
    const ddl768 = generateSchema(768);
    expect(ddl768).toContain("vector(768)");
    expect(ddl768).not.toContain("vector(1536)");

    const ddl3072 = generateSchema(3072);
    expect(ddl3072).toContain("vector(3072)");
  });

  // -- chunks table -----------------------------------------------------

  describe("chunks table", () => {
    it("creates the chunks table", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS chunks");
    });

    it("includes required columns", () => {
      const ddl = generateSchema(1536);
      const requiredColumns = [
        "source_name",
        "source_url",
        "title",
        "content",
        "embedding",
        "repo_url",
        "file_path",
        "start_line",
        "end_line",
        "language",
        "chunk_index",
        "metadata",
        "indexed_at",
        "commit_sha",
        "version",
      ];
      for (const col of requiredColumns) {
        expect(ddl).toContain(col);
      }
    });

    it("has a unique constraint on source_name, file_path, chunk_index", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain("chunks_source_file_chunk_uniq");
      expect(ddl).toContain("UNIQUE (source_name, file_path, chunk_index)");
    });

    it("defines HNSW index on embedding column", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain("CREATE INDEX IF NOT EXISTS idx_chunks_embedding");
      expect(ddl).toContain("USING hnsw (embedding vector_cosine_ops)");
    });

    it("defines indexes on source_name and repo_url", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain(
        "CREATE INDEX IF NOT EXISTS idx_chunks_source_name",
      );
      expect(ddl).toContain("CREATE INDEX IF NOT EXISTS idx_chunks_repo_url");
    });

    it("has a serial primary key", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toMatch(/id\s+SERIAL PRIMARY KEY/);
    });

    it("defaults metadata to empty JSON object", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain("JSONB NOT NULL DEFAULT '{}'");
    });

    it("defaults indexed_at to NOW()", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain("TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    });
  });

  // -- index_state table ------------------------------------------------

  describe("index_state table", () => {
    it("creates the index_state table", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS index_state");
    });

    it("includes required columns", () => {
      const ddl = generateSchema(1536);
      const cols = [
        "source_type",
        "source_key",
        "last_commit_sha",
        "config_fingerprint",
        "last_indexed_at",
        "status",
        "error_message",
      ];
      for (const col of cols) {
        expect(ddl).toContain(col);
      }
    });

    it("has a unique constraint on source_type, source_key", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain("index_state_source_uniq");
      expect(ddl).toContain("UNIQUE (source_type, source_key)");
    });

    it("defaults status to idle", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain("DEFAULT 'idle'");
    });
  });

  // -- collected_data table ---------------------------------------------

  describe("collected_data table", () => {
    it("creates the collected_data table", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS collected_data");
    });

    it("includes required columns", () => {
      const ddl = generateSchema(1536);
      expect(ddl).toContain("tool_name");
      expect(ddl).toContain("data");
      expect(ddl).toContain("created_at");
    });
  });
});

describe("generateMigration", () => {
  it("drops doc_chunks table", () => {
    const sql = generateMigration();
    expect(sql).toContain("DROP TABLE IF EXISTS doc_chunks CASCADE");
  });

  it("drops code_chunks table", () => {
    const sql = generateMigration();
    expect(sql).toContain("DROP TABLE IF EXISTS code_chunks CASCADE");
  });
});

describe("generatePostSchemaMigration", () => {
  it("adds version column to chunks", () => {
    const sql = generatePostSchemaMigration();
    expect(sql).toContain(
      "ALTER TABLE chunks ADD COLUMN IF NOT EXISTS version TEXT",
    );
  });

  it("creates index on version column", () => {
    const sql = generatePostSchemaMigration();
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_chunks_version ON chunks (version)",
    );
  });

  it("adds index_state.config_fingerprint idempotently", () => {
    // Additive + nullable so installs whose index_state predates the column
    // read back NULL; the orchestrator treats NULL as "unknown" and full-walks
    // once rather than silently trusting a stale incremental.
    const sql = generatePostSchemaMigration();
    expect(sql).toContain(
      "ALTER TABLE index_state ADD COLUMN IF NOT EXISTS config_fingerprint TEXT",
    );
    expect(sql).not.toContain(
      "ALTER TABLE index_state ADD COLUMN IF NOT EXISTS config_fingerprint TEXT NOT NULL",
    );
  });

  it("places index_state DDL BEFORE the query_log marker", () => {
    // Several PGlite tests apply only the tail of this migration, sliced from
    // the query_log marker. index_state DDL after that marker would run
    // against a database with no index_state table and abort the whole slice.
    const sql = generatePostSchemaMigration();
    expect(sql.indexOf("ALTER TABLE index_state")).toBeLessThan(
      sql.indexOf("-- Analytics: query_log table for tracking tool usage"),
    );
  });

  it("creates query_log table", () => {
    const sql = generatePostSchemaMigration();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS query_log");
  });

  it("includes query_log required columns", () => {
    const sql = generatePostSchemaMigration();
    for (const col of [
      "tool_name",
      "query_text",
      "result_count",
      "top_score",
      "latency_ms",
      "source_name",
      "session_id",
      "request_source",
      "created_at",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("creates indexes on query_log", () => {
    const sql = generatePostSchemaMigration();
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_query_log_created_at ON query_log (created_at)",
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_query_log_tool_name ON query_log (tool_name)",
    );
  });

  it("adds request_source via idempotent ADD COLUMN IF NOT EXISTS for back-compat", () => {
    // Installs whose query_log predates the request_source column must pick it
    // up without a destructive migration. The ALTER ... ADD COLUMN IF NOT
    // EXISTS is what makes re-running the post-schema migration safe on both
    // fresh and existing databases.
    const sql = generatePostSchemaMigration();
    expect(sql).toContain(
      "ALTER TABLE query_log ADD COLUMN IF NOT EXISTS request_source TEXT",
    );
  });

  it("indexes request_source for audience-filtered analytics reads", () => {
    const sql = generatePostSchemaMigration();
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_query_log_request_source ON query_log (request_source)",
    );
  });

  it("creates the webhook_deliveries table and its indexes", () => {
    // The JSDoc on generatePostSchemaMigration claims it also creates
    // webhook_deliveries (alongside query_log) — lock that claim so the
    // doc and the DDL stay in sync.
    const sql = generatePostSchemaMigration();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS webhook_deliveries");
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_source ON webhook_deliveries (source)",
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_delivered_at ON webhook_deliveries (delivered_at)",
    );
  });

  it("does NOT append the tsvector trigger DDL (returned separately)", () => {
    // generateTsvTriggerDdl() is the source of the trigger DDL; the
    // post-schema migration returns only the core (PGlite-safe) SQL. The
    // JSDoc must not claim the trigger is "appended" here.
    const sql = generatePostSchemaMigration();
    expect(sql).not.toContain("CREATE TRIGGER");
    expect(sql).not.toContain("chunks_tsv_trigger");
  });
});

describe("query_log era/transport columns", () => {
  const NEW_COLS = [
    "transport",
    "protocol_era",
    "protocol_version",
    "client_name",
    "auth_client_id",
  ];
  const MARKER = "-- Analytics: query_log table for tracking tool usage";

  const CREATE = "CREATE TABLE IF NOT EXISTS query_log";

  // indexOf that fails loudly, naming what it looked for. A bare -1 would
  // slice from the wrong place and surface later as a confusing error.
  function indexOrThrow(haystack: string, needle: string, from = 0): number {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) {
      throw new Error(
        `schema DDL fixture: ${JSON.stringify(needle)} not found`,
      );
    }
    return idx;
  }

  function analyticsDdl(): string {
    const full = generatePostSchemaMigration();
    return full.slice(indexOrThrow(full, MARKER));
  }

  // The current query_log CREATE TABLE with the five column lines removed, as
  // a stand-in for a table created before these columns existed. The strip
  // expects each column line to end in a comma (another column follows).
  function oldCreateTable(): string {
    const ddl = analyticsDdl();
    const start = indexOrThrow(ddl, CREATE);
    const end = indexOrThrow(ddl, ");", start) + 2;
    let stmt = ddl.slice(start, end);
    for (const col of NEW_COLS) {
      const next = stmt.replace(new RegExp(`^\\s+${col}\\s+TEXT,\\n`, "m"), "");
      // Fail loudly, naming the column, if the DDL layout changed so the
      // strip no longer matches: the fixture would otherwise keep the column.
      if (next === stmt) {
        throw new Error(
          `oldCreateTable: could not strip column "${col}" from the query_log CREATE TABLE`,
        );
      }
      stmt = next;
    }
    return stmt;
  }

  async function columnInfo(db: PGlite) {
    const res = await db.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
      data_type: string;
    }>(
      `SELECT column_name, is_nullable, column_default, data_type
         FROM information_schema.columns
        WHERE table_name = 'query_log' AND column_name = ANY($1)`,
      [NEW_COLS],
    );
    return res.rows;
  }

  function expectFiveNullableTextColumns(
    rows: Awaited<ReturnType<typeof columnInfo>>,
  ) {
    expect(rows.map((r) => r.column_name).sort()).toEqual([...NEW_COLS].sort());
    for (const r of rows) {
      expect(r.is_nullable).toBe("YES");
      expect(r.column_default).toBeNull();
      expect(r.data_type).toBe("text");
    }
  }

  it("old-DDL fixture really lacks the new columns", async () => {
    const db = new PGlite();
    try {
      await db.exec(oldCreateTable());
      expect(await columnInfo(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("adds the five nullable columns to a table created by the OLD DDL, idempotently", async () => {
    const db = new PGlite();
    try {
      await db.exec(oldCreateTable());
      await db.exec(
        "INSERT INTO query_log (tool_name, query_text, result_count, latency_ms) VALUES ('search','old',0,1)",
      );
      await db.exec(analyticsDdl());
      await db.exec(analyticsDdl());
      expectFiveNullableTextColumns(await columnInfo(db));
      const old = await db.query<Record<string, unknown>>(
        `SELECT ${NEW_COLS.join(", ")} FROM query_log WHERE query_text = 'old'`,
      );
      expect(old.rows).toHaveLength(1);
      for (const c of NEW_COLS) expect(old.rows[0][c]).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("creates the five nullable columns on a fresh table, idempotently", async () => {
    const db = new PGlite();
    try {
      await db.exec(analyticsDdl());
      await db.exec(analyticsDdl());
      expectFiveNullableTextColumns(await columnInfo(db));
    } finally {
      await db.close();
    }
  });

  it("fresh CREATE TABLE carries the columns without relying on the ALTERs", () => {
    const ddl = analyticsDdl();
    const start = indexOrThrow(ddl, CREATE);
    const create = ddl.slice(start, indexOrThrow(ddl, ");", start));
    for (const c of NEW_COLS)
      expect(create).toMatch(new RegExp(`\\b${c}\\s+TEXT`));
  });
});
