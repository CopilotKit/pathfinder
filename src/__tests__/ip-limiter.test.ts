import { describe, it, expect, beforeEach } from 'vitest';
import { IpSessionLimiter } from '../ip-limiter.js';

describe('IpSessionLimiter', () => {
    let limiter: IpSessionLimiter;

    beforeEach(() => {
        limiter = new IpSessionLimiter(3); // max 3 sessions per IP
    });

    it('allows sessions up to the limit', () => {
        expect(limiter.tryAdd('1.2.3.4', 'sess-1')).toBe(true);
        expect(limiter.tryAdd('1.2.3.4', 'sess-2')).toBe(true);
        expect(limiter.tryAdd('1.2.3.4', 'sess-3')).toBe(true);
    });

    it('rejects sessions beyond the limit', () => {
        limiter.tryAdd('1.2.3.4', 'sess-1');
        limiter.tryAdd('1.2.3.4', 'sess-2');
        limiter.tryAdd('1.2.3.4', 'sess-3');
        expect(limiter.tryAdd('1.2.3.4', 'sess-4')).toBe(false);
    });

    it('tracks IPs independently', () => {
        limiter.tryAdd('1.2.3.4', 'sess-1');
        limiter.tryAdd('1.2.3.4', 'sess-2');
        limiter.tryAdd('1.2.3.4', 'sess-3');
        expect(limiter.tryAdd('5.6.7.8', 'sess-4')).toBe(true);
    });

    it('frees slots on remove', () => {
        limiter.tryAdd('1.2.3.4', 'sess-1');
        limiter.tryAdd('1.2.3.4', 'sess-2');
        limiter.tryAdd('1.2.3.4', 'sess-3');
        limiter.remove('sess-2');
        expect(limiter.tryAdd('1.2.3.4', 'sess-4')).toBe(true);
    });

    it('cleans up empty IP entries', () => {
        limiter.tryAdd('1.2.3.4', 'sess-1');
        limiter.remove('sess-1');
        expect(limiter.getSessionCount('1.2.3.4')).toBe(0);
    });

    it('returns 0 for unknown IPs', () => {
        expect(limiter.getSessionCount('9.9.9.9')).toBe(0);
    });

    it('does not double-count duplicate session IDs', () => {
        limiter.tryAdd('1.2.3.4', 'sess-1');
        limiter.tryAdd('1.2.3.4', 'sess-1');
        expect(limiter.getSessionCount('1.2.3.4')).toBe(1);
    });

    it('getMax returns configured limit', () => {
        expect(limiter.getMax()).toBe(3);
    });

    it('remove with unknown session is a no-op', () => {
        expect(() => limiter.remove('nonexistent')).not.toThrow();
    });
});
