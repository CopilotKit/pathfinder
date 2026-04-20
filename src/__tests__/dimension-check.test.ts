import { describe, it, expect } from "vitest";
import { generateDimensionCheckQuery } from "../db/schema.js";

describe("generateDimensionCheckQuery", () => {
  it("returns SQL that queries vector dimensions from actual data", () => {
    const sql = generateDimensionCheckQuery();
    expect(sql).toContain("vector_dims");
    expect(sql).toContain("chunks");
    expect(sql).toContain("embedding");
  });
});
