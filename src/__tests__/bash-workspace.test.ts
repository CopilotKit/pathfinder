import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceTracker } from '../mcp/tools/bash-session.js';

describe('WorkspaceTracker', () => {
    let tracker: WorkspaceTracker;

    beforeEach(() => {
        tracker = new WorkspaceTracker(1024); // 1KB limit for tests
    });

    it('starts with 0 bytes used', () => {
        expect(tracker.getUsedBytes()).toBe(0);
    });

    it('trackWrite accepts writes within budget', () => {
        expect(tracker.trackWrite(500)).toBe(true);
        expect(tracker.getUsedBytes()).toBe(500);
    });

    it('trackWrite rejects writes exceeding budget', () => {
        tracker.trackWrite(800);
        expect(tracker.trackWrite(300)).toBe(false);
        expect(tracker.getUsedBytes()).toBe(800); // unchanged
    });

    it('trackWrite accepts write exactly at limit', () => {
        expect(tracker.trackWrite(1024)).toBe(true);
        expect(tracker.getUsedBytes()).toBe(1024);
    });

    it('reset clears usage', () => {
        tracker.trackWrite(500);
        tracker.reset();
        expect(tracker.getUsedBytes()).toBe(0);
    });

    it('default max is 1MB', () => {
        const defaultTracker = new WorkspaceTracker();
        expect(defaultTracker.getMaxBytes()).toBe(1024 * 1024);
    });
});
