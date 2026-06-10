// Fixture: a tiny stand-in for `origin/main:src/db/atlas.ts`.
//
// The S14 validation gate greps a read-only checkout of origin/main for a
// candidate's validationTarget symbols/paths. This file carries a KNOWN symbol
// (`upsertAtlasSeedCandidate`) that a source-verify test asserts is found. The
// §7 worked-proof negative symbol is deliberately absent from this whole fixture
// tree (do not name it here — a real text grep would spuriously match it).

export interface UpsertAtlasSeedCandidateInput {
  canonicalKey: string;
  subsystem: string;
  title: string;
  content: string;
}

// Idempotent pending-only upsert of one harvested candidate row.
export async function upsertAtlasSeedCandidate(
  input: UpsertAtlasSeedCandidateInput,
): Promise<void> {
  void input;
}
