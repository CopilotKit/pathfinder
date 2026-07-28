// Near-miss NEGATIVE for the file-scoped `clear-all-mocks-with-once` rule:
// `vi.clearAllMocks()` is fine on its own — the leak needs a `*Once` queue to
// leak FROM. Needs its own file because the rule reasons about the whole file.
//
// Never executed, never type-checked.
/* eslint-disable */

declare const it: (name: string, fn: () => unknown) => void;
declare const beforeEach: (fn: () => unknown) => void;
declare const expect: any;
declare const vi: any;
declare const searchChunks: (...args: unknown[]) => Promise<any[]>;
declare const mockQuery: any;

beforeEach(() => {
  vi.clearAllMocks();
});

it("configures the mock without a queue", async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  expect(await searchChunks([], 10)).toEqual([]);
});
