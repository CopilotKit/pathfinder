import { describe, it, expect, vi, beforeEach } from "vitest";

// The orchestrator's config-change detection is only as good as the column
// round-trip: if config_fingerprint is not SELECTed it always reads back
// undefined (every run full-walks), and if it is not bound on the INSERT it is
// never persisted (every run full-walks). Both failure modes are silent, so
// pin the SQL and the binds.

const mockQuery = vi.fn();
vi.mock("../db/client.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: unknown) => v },
}));

import { getIndexState, upsertIndexState } from "../db/queries.js";

describe("index_state.config_fingerprint round-trip", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("SELECTs config_fingerprint and surfaces it on the state", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source_type: "markdown",
          source_key: "docs",
          last_commit_sha: "abc",
          config_fingerprint: "fp-1",
          last_indexed_at: null,
          status: "idle",
          error_message: null,
        },
      ],
    });

    const state = await getIndexState("markdown", "docs");

    expect(String(mockQuery.mock.calls[0][0])).toContain("config_fingerprint");
    expect(state?.config_fingerprint).toBe("fp-1");
  });

  it("reads a pre-upgrade row (column absent) back as null, not undefined", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source_type: "markdown",
          source_key: "docs",
          last_commit_sha: "abc",
          config_fingerprint: null,
          last_indexed_at: null,
          status: "idle",
          error_message: null,
        },
      ],
    });

    const state = await getIndexState("markdown", "docs");
    expect(state?.config_fingerprint).toBeNull();
  });

  it("persists config_fingerprint on INSERT and on CONFLICT UPDATE", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await upsertIndexState({
      source_type: "markdown",
      source_key: "docs",
      last_commit_sha: "abc",
      config_fingerprint: "fp-1",
      status: "idle",
    });

    const [sql, binds] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("config_fingerprint");
    expect(String(sql)).toContain(
      "config_fingerprint = EXCLUDED.config_fingerprint",
    );
    expect(binds).toContain("fp-1");
  });

  it("binds NULL rather than the string 'null' when there is no fingerprint", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await upsertIndexState({
      source_type: "markdown",
      source_key: "docs",
      last_commit_sha: "abc",
      status: "idle",
    });

    const binds = mockQuery.mock.calls[0][1] as unknown[];
    expect(binds).toContain(null);
    expect(binds).not.toContain("null");
    expect(binds).not.toContain(undefined);
  });
});
