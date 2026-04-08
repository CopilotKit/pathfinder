import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { verifySlackSignature, createSlackWebhookHandler, type SlackReindexOrchestrator } from '../webhooks/slack.js';

// Mock config
vi.mock('../config.js', () => ({
    getConfig: vi.fn().mockReturnValue({
        slackSigningSecret: 'test-signing-secret',
        slackBotToken: 'xoxb-test',
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
        sources: [
            {
                name: 'slack-support',
                type: 'slack',
                channels: ['C001', 'C002'],
                confidence_threshold: 0.7,
                trigger_emoji: 'pathfinder',
                min_thread_replies: 2,
                chunk: {},
            },
        ],
        tools: [],
    }),
}));

// Helper to create a valid Slack signature
function signPayload(body: string, secret: string, timestamp: string): string {
    const sigBasestring = `v0:${timestamp}:${body}`;
    return 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');
}

// Helper to create mock request/response
function mockReqRes(body: object, headers: Record<string, string> = {}) {
    const bodyStr = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signPayload(bodyStr, 'test-signing-secret', timestamp);

    const req = {
        body: Buffer.from(bodyStr),
        headers: {
            'x-slack-request-timestamp': timestamp,
            'x-slack-signature': signature,
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

describe('verifySlackSignature', () => {
    const secret = 'test-secret';

    it('verifies valid signature', () => {
        const body = Buffer.from('{"test": true}');
        const timestamp = String(Math.floor(Date.now() / 1000));
        const sigBasestring = `v0:${timestamp}:${body.toString('utf-8')}`;
        const signature = 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');

        expect(verifySlackSignature(body, timestamp, signature, secret)).toBe(true);
    });

    it('rejects invalid signature', () => {
        const body = Buffer.from('{"test": true}');
        const timestamp = String(Math.floor(Date.now() / 1000));
        expect(verifySlackSignature(body, timestamp, 'v0=invalid', secret)).toBe(false);
    });

    it('rejects missing timestamp', () => {
        const body = Buffer.from('{"test": true}');
        expect(verifySlackSignature(body, undefined, 'v0=sig', secret)).toBe(false);
    });

    it('rejects missing signature', () => {
        const body = Buffer.from('{"test": true}');
        const timestamp = String(Math.floor(Date.now() / 1000));
        expect(verifySlackSignature(body, timestamp, undefined, secret)).toBe(false);
    });

    it('rejects expired timestamp (>5 minutes old)', () => {
        const body = Buffer.from('{"test": true}');
        const oldTimestamp = String(Math.floor(Date.now() / 1000) - 400);
        const sigBasestring = `v0:${oldTimestamp}:${body.toString('utf-8')}`;
        const signature = 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');

        expect(verifySlackSignature(body, oldTimestamp, signature, secret)).toBe(false);
    });
});

describe('createSlackWebhookHandler', () => {
    let orchestrator: SlackReindexOrchestrator;
    let handler: ReturnType<typeof createSlackWebhookHandler>;

    beforeEach(() => {
        vi.clearAllMocks();
        orchestrator = {
            queueSourceReindex: vi.fn(),
        };
        handler = createSlackWebhookHandler(orchestrator);
    });

    it('responds to URL verification challenge', async () => {
        const { req, res } = mockReqRes({
            type: 'url_verification',
            challenge: 'abc123',
        });
        // URL verification doesn't need signature
        req.body = Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'abc123' }));

        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ challenge: 'abc123' });
    });

    it('triggers reindex on matching reaction_added event', async () => {
        const { req, res } = mockReqRes({
            type: 'event_callback',
            event: {
                type: 'reaction_added',
                reaction: 'pathfinder',
                item: { type: 'message', channel: 'C001', ts: '1234.5678' },
            },
        });

        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(orchestrator.queueSourceReindex).toHaveBeenCalledWith('slack-support');
    });

    it('ignores reactions with non-matching emoji', async () => {
        const { req, res } = mockReqRes({
            type: 'event_callback',
            event: {
                type: 'reaction_added',
                reaction: 'thumbsup',
                item: { type: 'message', channel: 'C001', ts: '1234.5678' },
            },
        });

        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(orchestrator.queueSourceReindex).not.toHaveBeenCalled();
    });

    it('ignores reactions from non-configured channels', async () => {
        const { req, res } = mockReqRes({
            type: 'event_callback',
            event: {
                type: 'reaction_added',
                reaction: 'pathfinder',
                item: { type: 'message', channel: 'C999', ts: '1234.5678' },
            },
        });

        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(orchestrator.queueSourceReindex).not.toHaveBeenCalled();
    });

    it('rejects request with invalid signature', async () => {
        const bodyStr = JSON.stringify({
            type: 'event_callback',
            event: { type: 'reaction_added', reaction: 'pathfinder', item: { channel: 'C001', ts: '1' } },
        });

        const req = {
            body: Buffer.from(bodyStr),
            headers: {
                'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
                'x-slack-signature': 'v0=invalidsig',
            },
        } as any;

        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects non-Buffer request body', async () => {
        const req = { body: '{"test": true}', headers: {} } as any;
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(500);
    });

    it('acknowledges unknown event types', async () => {
        const { req, res } = mockReqRes({
            type: 'event_callback',
            event: { type: 'message' },
        });

        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ignored: true }));
    });
});
