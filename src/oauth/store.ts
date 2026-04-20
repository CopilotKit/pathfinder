// In-memory stores for OAuth state — dynamic clients and authorization codes.
// Singleton exports match the `src/ip-limiter.ts` pattern.

import { randomBytes, randomUUID } from "node:crypto";

export interface RegisteredClient {
  client_id: string;
  client_secret: string;
  client_id_issued_at: number;
  client_secret_issued_at: number;
  client_secret_expires_at: number;
  redirect_uris: string[];
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export interface AuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  expiresAt: number;
}

export interface IssueCodeInput {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  ttlMs: number;
}

export class ClientStore {
  private clients = new Map<string, RegisteredClient>();

  register(input: { redirect_uris: string[] }): RegisteredClient {
    const issuedAt = Math.floor(Date.now() / 1000);
    const client: RegisteredClient = {
      client_id: randomUUID(),
      client_secret: base64url(randomBytes(32)),
      client_id_issued_at: issuedAt,
      client_secret_issued_at: issuedAt,
      client_secret_expires_at: 0,
      redirect_uris: [...input.redirect_uris],
    };
    this.clients.set(client.client_id, client);
    return client;
  }

  get(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }
}

export class CodeStore {
  private codes = new Map<string, AuthCode>();

  issue(input: IssueCodeInput): { code: string; expiresAt: number } {
    const code = randomUUID();
    const expiresAt = Date.now() + input.ttlMs;
    this.codes.set(code, {
      clientId: input.clientId,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      resource: input.resource,
      expiresAt,
    });
    return { code, expiresAt };
  }

  consume(code: string): AuthCode | undefined {
    const record = this.codes.get(code);
    if (!record) return undefined;
    // One-time use: always remove on consume attempt
    this.codes.delete(code);
    if (record.expiresAt < Date.now()) return undefined;
    return record;
  }
}

export const clientStore = new ClientStore();
export const codeStore = new CodeStore();
