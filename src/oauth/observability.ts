// src/oauth/observability.ts
// Pathfinder has no metrics surface; observability is log-derived from
// the `[oauth] …` prefix. Centralised here so the operator can grep one
// vocabulary instead of N log strings sprinkled across handlers.

type Fields = Record<string, string | number | boolean | undefined>;

function format(fields: Fields): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

export const oauthLog = {
  register(fields: Fields): void {
    console.log(`[oauth] register ${format(fields)}`);
  },
  registerRejected(fields: Fields & { reason: string }): void {
    console.warn(`[oauth] register_rejected ${format(fields)}`);
  },
  consentMinted(fields: Fields): void {
    console.log(`[oauth] consent_minted ${format(fields)}`);
  },
  consentApproved(fields: Fields): void {
    console.log(`[oauth] consent_approved ${format(fields)}`);
  },
  consentDenied(fields: Fields): void {
    console.log(`[oauth] consent_denied ${format(fields)}`);
  },
  consentNonceInvalid(
    fields: Fields & {
      reason: "hmac" | "expired" | "field_mismatch" | "format";
    },
  ): void {
    console.warn(`[oauth] consent_nonce_invalid ${format(fields)}`);
  },
  capEvicted(fields: { ttl: number; unused: number }): void {
    if (fields.ttl === 0 && fields.unused === 0) return;
    console.warn(
      `[oauth] cap_evicted ttl=${fields.ttl} unused=${fields.unused}`,
    );
  },
  capOverflow(
    fields: Fields & { scope: "total" | "per_ip"; ip: string },
  ): void {
    console.warn(`[oauth] cap_overflow ${format(fields)}`);
  },
  // Consent-endpoint rate-limit hit. Mirrors handlers.ts:72 shape but tags
  // the endpoint so the consent funnel is greppable independent of the
  // generic OAuth rate-limit log.
  consentRateLimited(fields: Fields & { ip: string }): void {
    console.warn(
      `[oauth] rate_limited ${format({ ...fields, endpoint: "consent" })}`,
    );
  },
  // Post-MAC-verify tamper/divergence signals. Reaching any of these means
  // the nonce MAC was valid and step 3 (field equality) passed, so the
  // 400 indicates payload-vs-store divergence: either the client was
  // evicted/deleted, or the bound parameters no longer match what we
  // still accept.
  consentStaleClient(fields: Fields & { ip: string; client_id: string }): void {
    console.warn(`[oauth] consent_stale_client ${format(fields)}`);
  },
  consentScopeMismatch(
    fields: Fields & { ip: string; client_id: string; scope: string },
  ): void {
    console.warn(`[oauth] consent_scope_mismatch ${format(fields)}`);
  },
  consentParamUnsupported(
    fields: Fields & {
      ip: string;
      client_id: string;
      response_type: string;
      code_challenge_method: string;
    },
  ): void {
    console.warn(`[oauth] consent_param_unsupported ${format(fields)}`);
  },
  consentUnknownDecision(
    fields: Fields & { ip: string; client_id: string; decision: string },
  ): void {
    console.warn(`[oauth] consent_unknown_decision ${format(fields)}`);
  },
  consentRedirectUriUnparseable(
    fields: Fields & { ip: string; client_id: string },
  ): void {
    console.warn(`[oauth] consent_redirect_uri_unparseable ${format(fields)}`);
  },
  // Abuse blocklist hit on a search/knowledge tool call. Logged with the
  // matching pattern reason and the resolved client IP so the operator can
  // grep `[oauth] search_blocked` for abuse volume independent of the
  // per-row `query_log.blocked` flag. Kept on `oauthLog` for vocabulary
  // consistency with the rest of the `[oauth] …` log surface; the block
  // itself is not OAuth-scoped but the IP attribution and grep surface are.
  searchBlocked(fields: Fields & { ip: string; reason: string }): void {
    console.warn(`[oauth] search_blocked ${format(fields)}`);
  },
} as const;
