// Fixture: a tiny stand-in for a runtime source file on `origin/main`.
//
// Carries the `TwoLayerShim` symbol that an architecture candidate's
// validationTarget resolves to (source-verify → found). Used by the S14
// validation-gate tests; not compiled by the real build (fixtures/ is excluded
// from tsconfig include).

// The V1-wraps-V2 two-layer shim: V1 surface delegates to the V2 engine.
export class TwoLayerShim {
  constructor(private readonly engine: unknown) {}

  delegate(): unknown {
    return this.engine;
  }
}
