// Shared constants used across indexing and MCP tool modules

// All demo repos (with-agno, with-crewai-flows, etc.) were consolidated
// into CopilotKit/CopilotKit. Only the main repo needs indexing.
export const INDEXED_REPOS = [
    'https://github.com/CopilotKit/CopilotKit.git',
] as const;

export type IndexedRepo = typeof INDEXED_REPOS[number];
