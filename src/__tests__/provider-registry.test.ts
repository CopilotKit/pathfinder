import { describe, it, expect, beforeEach } from 'vitest';
import { registerProvider, getProvider } from '../indexing/providers/index.js';
import type { DataProvider, ProviderOptions } from '../indexing/providers/types.js';
import type { SourceConfig } from '../types.js';

describe('provider registry', () => {
    it('registers and retrieves a provider factory', () => {
        const mockFactory = (config: SourceConfig, options: ProviderOptions): DataProvider => ({
            fullAcquire: async () => ({ items: [], removedIds: [], stateToken: 'test' }),
            incrementalAcquire: async () => ({ items: [], removedIds: [], stateToken: 'test' }),
            getCurrentStateToken: async () => 'test',
        });

        registerProvider('test-type', mockFactory);
        const factory = getProvider('test-type');
        expect(factory).toBe(mockFactory);
    });

    it('throws for unknown provider type', () => {
        expect(() => getProvider('nonexistent')).toThrow('Unknown provider type: "nonexistent"');
    });
});
