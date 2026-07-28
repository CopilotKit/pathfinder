// Near-miss NEGATIVE for the file-scoped `clear-all-mocks-with-once` rule:
// `vi.resetAllMocks()` drains the once-queue as well as the call log, so
// queueing `*Once` values alongside it is safe. Needs its own file because the
// rule reasons about the whole file.
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
  vi.resetAllMocks();
});

it("queues a once value under resetAllMocks", async () => {
  mockQuery.mockResolvedValueOnce({ rows: [] });
  expect(await searchChunks([], 10)).toEqual([]);
});
