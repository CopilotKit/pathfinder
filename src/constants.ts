// Shared constants used across indexing and MCP tool modules

export const INDEXED_REPOS = [
    'https://github.com/CopilotKit/CopilotKit.git',
    'https://github.com/CopilotKit/with-agno.git',
    'https://github.com/CopilotKit/with-crewai-flows.git',
    'https://github.com/CopilotKit/with-langgraph-fastapi.git',
    'https://github.com/CopilotKit/with-langgraph-js.git',
    'https://github.com/CopilotKit/with-langgraph-python.git',
    'https://github.com/CopilotKit/with-llamaindex.git',
    'https://github.com/CopilotKit/with-mastra.git',
] as const;

export type IndexedRepo = typeof INDEXED_REPOS[number];
