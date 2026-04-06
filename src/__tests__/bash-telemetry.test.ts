import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BashTelemetry } from '../mcp/tools/bash-telemetry.js';

describe('BashTelemetry', () => {
    let telemetry: BashTelemetry;
    const mockInsert = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
        vi.clearAllMocks();
        telemetry = new BashTelemetry(mockInsert);
    });

    it('records a file access event', () => {
        telemetry.recordFileAccess('/docs/quickstart.mdx', 'cat');
        const events = telemetry.getEvents();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'file_access', path: '/docs/quickstart.mdx', command: 'cat' });
    });

    it('records a grep miss event', () => {
        telemetry.recordGrepMiss('useCoAgent', 'grep -r "useCoAgent" /docs');
        const events = telemetry.getEvents();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'grep_miss', pattern: 'useCoAgent' });
    });

    it('records a command event', () => {
        telemetry.recordCommand('find / -name "*.ts"');
        const events = telemetry.getEvents();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'command', command: 'find / -name "*.ts"' });
    });

    it('flush writes events to DB and clears buffer', async () => {
        telemetry.recordCommand('ls /');
        telemetry.recordCommand('cat /docs/a.md');
        await telemetry.flush();
        expect(mockInsert).toHaveBeenCalledTimes(1);
        expect(mockInsert).toHaveBeenCalledWith('_telemetry', expect.objectContaining({
            events: expect.arrayContaining([expect.objectContaining({ type: 'command' })]),
        }));
        expect(telemetry.getEvents()).toHaveLength(0);
    });

    it('flush is a no-op with empty buffer', async () => {
        await telemetry.flush();
        expect(mockInsert).not.toHaveBeenCalled();
    });

    it('flush re-buffers on failure', async () => {
        mockInsert.mockRejectedValueOnce(new Error('DB down'));
        telemetry.recordCommand('ls /');
        await telemetry.flush();
        expect(telemetry.getEvents()).toHaveLength(1);
    });

    it('caps buffer at MAX_BUFFER_SIZE', () => {
        const smallTracker = new BashTelemetry(mockInsert);
        for (let i = 0; i < 10001; i++) {
            smallTracker.recordCommand(`cmd ${i}`);
        }
        expect(smallTracker.getEvents().length).toBeLessThanOrEqual(10000);
    });

    it('getStats returns command counts', () => {
        telemetry.recordCommand('ls /');
        telemetry.recordCommand('ls /docs');
        telemetry.recordFileAccess('/a.md', 'cat');
        telemetry.recordGrepMiss('pattern', 'grep pattern /');
        const stats = telemetry.getStats();
        expect(stats.totalCommands).toBe(4);
        expect(stats.fileAccesses).toBe(1);
        expect(stats.grepMisses).toBe(1);
    });
});
