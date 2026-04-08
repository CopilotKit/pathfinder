import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyDiscordSignature, createDiscordWebhookHandler, type DiscordReindexOrchestrator } from '../webhooks/discord.js';

// Mock discord-interactions
vi.mock('discord-interactions', () => ({
    verifyKey: vi.fn(),
}));

// Mock config
vi.mock('../config.js', () => ({
    getConfig: vi.fn().mockReturnValue({
        discordPublicKey: 'test-public-key-hex',
        slackBotToken: '',
        slackSigningSecret: '',
        discordBotToken: 'test-bot-token',
        openaiApiKey: 'test-key',
        databaseUrl: 'postgresql://test',
        githubToken: '',
        githubWebhookSecret: '',
        port: 3001,
        nodeEnv: 'test',
        logLevel: 'info',
        cloneDir: '/tmp/test',
    }),
    getServerConfig: vi.fn().mockReturnValue({
        server: { name: 'test', version: '1.0' },
        sources: [],
        tools: [],
    }),
}));

import { verifyKey } from 'discord-interactions';

function mockReqRes(body: object, headers: Record<string, string> = {}) {
    const bodyStr = JSON.stringify(body);
    const req = {
        body: Buffer.from(bodyStr),
        headers: {
            'x-signature-ed25519': 'valid-sig',
            'x-signature-timestamp': String(Math.floor(Date.now() / 1000)),
            ...headers,
        },
    } as any;

    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        headersSent: false,
    } as any;

    return { req, res };
}

describe('verifyDiscordSignature', () => {
    it('returns true for valid signature', async () => {
        (verifyKey as ReturnType<typeof vi.fn>).mockResolvedValue(true);

        const result = await verifyDiscordSignature(
            Buffer.from('body'),
            'valid-sig',
            '12345',
            'public-key',
        );
        expect(result).toBe(true);
        expect(verifyKey).toHaveBeenCalledWith(
            Buffer.from('body'),
            'valid-sig',
            '12345',
            'public-key',
        );
    });

    it('returns false for invalid signature', async () => {
        (verifyKey as ReturnType<typeof vi.fn>).mockResolvedValue(false);

        const result = await verifyDiscordSignature(
            Buffer.from('body'),
            'bad-sig',
            '12345',
            'public-key',
        );
        expect(result).toBe(false);
    });

    it('returns false when signature is missing', async () => {
        const result = await verifyDiscordSignature(
            Buffer.from('body'),
            undefined,
            '12345',
            'public-key',
        );
        expect(result).toBe(false);
    });

    it('returns false when timestamp is missing', async () => {
        const result = await verifyDiscordSignature(
            Buffer.from('body'),
            'sig',
            undefined,
            'public-key',
        );
        expect(result).toBe(false);
    });

    it('returns false when verifyKey throws', async () => {
        const { verifyKey } = await import('discord-interactions');
        (verifyKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('crypto failure'));

        const result = await verifyDiscordSignature(
            Buffer.from('body'),
            'sig',
            'timestamp',
            'bad-key',
        );
        expect(result).toBe(false);
    });
});

describe('createDiscordWebhookHandler', () => {
    let orchestrator: DiscordReindexOrchestrator;
    let handler: ReturnType<typeof createDiscordWebhookHandler>;

    beforeEach(() => {
        vi.clearAllMocks();
        (verifyKey as ReturnType<typeof vi.fn>).mockResolvedValue(true);
        orchestrator = { queueSourceReindex: vi.fn() };
        handler = createDiscordWebhookHandler(orchestrator);
    });

    it('responds to PING interaction with type 1', async () => {
        const { req, res } = mockReqRes({ type: 1 });
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ type: 1 });
    });

    it('acknowledges non-PING interactions with 200', async () => {
        const { req, res } = mockReqRes({ type: 2, data: { name: 'test' } });
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('rejects request with invalid signature', async () => {
        (verifyKey as ReturnType<typeof vi.fn>).mockResolvedValue(false);

        const { req, res } = mockReqRes({ type: 1 });
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects non-Buffer request body', async () => {
        const req = { body: '{"type":1}', headers: {} } as any;
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(500);
    });

    it('handles malformed JSON', async () => {
        (verifyKey as ReturnType<typeof vi.fn>).mockResolvedValue(true);

        const req = {
            body: Buffer.from('not json'),
            headers: {
                'x-signature-ed25519': 'sig',
                'x-signature-timestamp': '12345',
            },
        } as any;
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
    });
});
