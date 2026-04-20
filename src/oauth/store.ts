// In-memory stores for OAuth state — dynamic clients and authorization codes.
// Singleton exports match the `src/ip-limiter.ts` pattern.

import { randomUUID } from "node:crypto";

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
}

export interface AuthCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

export interface IssueCodeInput {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  ttlMs: number;
}

export class ClientStore {
  private clients = new Map<string, RegisteredClient>();

  register(input: { redirect_uris: string[] }): RegisteredClient {
    const client: RegisteredClient = {
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
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
