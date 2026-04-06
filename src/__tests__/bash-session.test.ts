import { describe, it, expect, beforeEach } from 'vitest';
import { BashSessionState, SessionStateManager } from '../mcp/tools/bash-session.js';

describe('BashSessionState', () => {
    let state: BashSessionState;
    beforeEach(() => { state = new BashSessionState(); });

    it('starts with CWD at /', () => { expect(state.getCwd()).toBe('/'); });
    it('setCwd updates CWD', () => { state.setCwd('/docs/guides'); expect(state.getCwd()).toBe('/docs/guides'); });
    it('resolvePath resolves absolute paths as-is', () => { state.setCwd('/docs'); expect(state.resolvePath('/code/src')).toBe('/code/src'); });
    it('resolvePath resolves relative paths against CWD', () => { state.setCwd('/docs'); expect(state.resolvePath('guides')).toBe('/docs/guides'); });
    it('resolvePath resolves .. in relative paths', () => { state.setCwd('/docs/guides'); expect(state.resolvePath('../api')).toBe('/docs/api'); });
    it('resolvePath resolves . as CWD', () => { state.setCwd('/docs'); expect(state.resolvePath('.')).toBe('/docs'); });
    it('resolvePath normalizes trailing slashes', () => { state.setCwd('/docs/'); expect(state.resolvePath('guides/')).toBe('/docs/guides'); });
});

describe('SessionStateManager', () => {
    let manager: SessionStateManager;
    beforeEach(() => { manager = new SessionStateManager(); });

    it('getOrCreate returns new state for unknown session', () => { const s = manager.getOrCreate('s1'); expect(s).toBeInstanceOf(BashSessionState); expect(s.getCwd()).toBe('/'); });
    it('getOrCreate returns same state for same session', () => { manager.getOrCreate('s1').setCwd('/docs'); expect(manager.getOrCreate('s1').getCwd()).toBe('/docs'); });
    it('different sessions have independent state', () => { manager.getOrCreate('s1').setCwd('/docs'); expect(manager.getOrCreate('s2').getCwd()).toBe('/'); });
    it('cleanup removes a session', () => { manager.getOrCreate('s1').setCwd('/docs'); manager.cleanup('s1'); expect(manager.getOrCreate('s1').getCwd()).toBe('/'); });
    it('cleanupAll removes all sessions', () => { manager.getOrCreate('s1').setCwd('/a'); manager.getOrCreate('s2').setCwd('/b'); manager.cleanupAll(); expect(manager.getOrCreate('s1').getCwd()).toBe('/'); });
    it('size returns session count', () => { expect(manager.size).toBe(0); manager.getOrCreate('s1'); expect(manager.size).toBe(1); manager.cleanup('s1'); expect(manager.size).toBe(0); });
});
