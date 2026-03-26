// Integration test: indexes real content, verifies search through DB and MCP HTTP layers
//
// Prerequisites:
//   - Running DB: docker compose up db
//   - OPENAI_API_KEY set in environment (or .env)
//   - GITHUB_WEBHOOK_SECRET set (or defaults to "test-secret" below)
//
// Usage:
//   npx tsx scripts/integration-test.ts

import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initializeSchema, getPool } from "../src/db/client.js";
import { getConfig } from "../src/config.js";
import { EmbeddingClient } from "../src/indexing/embeddings.js";
import { createMcpServer } from "../src/mcp/server.js";
import {
    upsertDocChunks,
    upsertCodeChunks,
    searchDocChunks,
    searchCodeChunks,
} from "../src/db/queries.js";
import type { DocChunk, CodeChunk } from "../src/db/queries.js";
import type { Server } from "node:http";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Unique prefix so we can clean up without touching real data
const TEST_PREFIX = "__integration_test__";
const TEST_DOC_PATH_PREFIX = `${TEST_PREFIX}/docs/`;
const TEST_CODE_REPO = `${TEST_PREFIX}/repo`;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const DOC_CONTENTS: Array<{ title: string; content: string; fileName: string }> = [
    {
        title: "Getting Started with CopilotKit",
        fileName: "getting-started.mdx",
        content: `# Getting Started with CopilotKit

Install CopilotKit in your React project:

\`\`\`bash
npm install @copilotkit/react-core @copilotkit/react-ui
\`\`\`

Wrap your application with the CopilotKit provider:

\`\`\`tsx
import { CopilotKit } from "@copilotkit/react-core";

function App() {
    return (
        <CopilotKit runtimeUrl="/api/copilotkit">
            <YourApp />
        </CopilotKit>
    );
}
\`\`\`

This sets up the CopilotKit context and connects to your backend runtime.`,
    },
    {
        title: "useCopilotAction Hook",
        fileName: "use-copilot-action.mdx",
        content: `# useCopilotAction

The \`useCopilotAction\` hook lets you define actions that the AI copilot can invoke on behalf of the user.

\`\`\`tsx
import { useCopilotAction } from "@copilotkit/react-core";

useCopilotAction({
    name: "addTodo",
    description: "Add a new todo item to the list",
    parameters: [
        { name: "title", type: "string", description: "The todo title", required: true },
    ],
    handler: async ({ title }) => {
        addTodoItem(title);
    },
});
\`\`\`

Actions are automatically registered with the copilot and can be triggered during conversation.`,
    },
    {
        title: "CopilotRuntime Configuration",
        fileName: "copilot-runtime.mdx",
        content: `# CopilotRuntime Configuration

The CopilotRuntime is the server-side component that connects your application to LLM providers.

\`\`\`typescript
import { CopilotRuntime, OpenAIAdapter } from "@copilotkit/runtime";

const runtime = new CopilotRuntime({
    actions: [
        {
            name: "fetchWeather",
            description: "Get current weather for a city",
            parameters: [{ name: "city", type: "string" }],
            handler: async ({ city }) => {
                return await getWeather(city);
            },
        },
    ],
});
\`\`\`

Configure the runtime with your preferred LLM adapter (OpenAI, Anthropic, Google, etc.) and register server-side actions.`,
    },
];

const CODE_CONTENTS: Array<{
    filePath: string;
    content: string;
    language: string;
    startLine: number;
    endLine: number;
}> = [
    {
        filePath: "packages/runtime/src/lib/copilot-runtime.ts",
        language: "typescript",
        startLine: 1,
        endLine: 35,
        content: `export class CopilotRuntime {
    private actions: Action[];
    private adapter: LLMAdapter;

    constructor(options: CopilotRuntimeOptions) {
        this.actions = options.actions ?? [];
        this.adapter = options.adapter ?? new OpenAIAdapter();
    }

    async process(request: CopilotRequest): Promise<CopilotResponse> {
        const messages = request.messages;
        const availableActions = this.actions.map((a) => ({
            name: a.name,
            description: a.description,
            parameters: a.parameters,
        }));

        const response = await this.adapter.complete({
            messages,
            tools: availableActions,
        });

        return { messages: response.messages };
    }

    registerAction(action: Action): void {
        this.actions.push(action);
    }
}`,
    },
    {
        filePath: "examples/next-app/src/app/page.tsx",
        language: "typescriptreact",
        startLine: 1,
        endLine: 30,
        content: `"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { useCopilotAction } from "@copilotkit/react-core";

export default function Home() {
    useCopilotAction({
        name: "setBackground",
        description: "Change the page background color",
        parameters: [
            { name: "color", type: "string", description: "CSS color value" },
        ],
        handler: async ({ color }) => {
            document.body.style.backgroundColor = color;
        },
    });

    return (
        <CopilotKit runtimeUrl="/api/copilotkit">
            <CopilotSidebar>
                <main>
                    <h1>CopilotKit Demo</h1>
                </main>
            </CopilotSidebar>
        </CopilotKit>
    );
}`,
    },
    {
        filePath: "examples/python-agent/agent.py",
        language: "python",
        startLine: 1,
        endLine: 25,
        content: `from copilotkit import CopilotKitSDK, Action
from copilotkit.langgraph import copilotkit_customize_config

sdk = CopilotKitSDK(
    actions=[
        Action(
            name="search_knowledge_base",
            description="Search the internal knowledge base for relevant information",
            parameters=[
                {"name": "query", "type": "string", "description": "Search query"},
            ],
            handler=search_handler,
        ),
    ],
)

async def search_handler(query: str) -> str:
    results = await vector_store.similarity_search(query)
    return "\\n".join([r.page_content for r in results])`,
    },
];

// ---------------------------------------------------------------------------
// Test assertion helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        passed++;
        console.log(`  PASS: ${message}`);
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
    }
}

function assertContains(text: string, substring: string, label: string): void {
    assert(
        text.toLowerCase().includes(substring.toLowerCase()),
        `${label} — contains "${substring}"`,
    );
}

// ---------------------------------------------------------------------------
// Phase 1: Index test data
// ---------------------------------------------------------------------------

async function indexTestData(embeddingClient: EmbeddingClient): Promise<void> {
    console.log("\n=== Phase 1: Indexing test data ===\n");

    // Generate doc embeddings
    console.log("Generating doc embeddings...");
    const docTexts = DOC_CONTENTS.map((d) => `${d.title}\n\n${d.content}`);
    const docEmbeddings = await embeddingClient.embedBatch(docTexts);

    const docChunks: DocChunk[] = DOC_CONTENTS.map((d, i) => ({
        source_url: `https://docs.copilotkit.ai/${d.fileName}`,
        title: d.title,
        content: d.content,
        embedding: docEmbeddings[i],
        file_path: `${TEST_DOC_PATH_PREFIX}${d.fileName}`,
        chunk_index: 0,
        metadata: { integration_test: true },
        commit_sha: "test-sha-000",
    }));

    await upsertDocChunks(docChunks);
    console.log(`Upserted ${docChunks.length} doc chunks.`);

    // Generate code embeddings
    console.log("Generating code embeddings...");
    const codeTexts = CODE_CONTENTS.map((c) => `${c.filePath}\n\n${c.content}`);
    const codeEmbeddings = await embeddingClient.embedBatch(codeTexts);

    const codeChunks: CodeChunk[] = CODE_CONTENTS.map((c, i) => ({
        repo_url: TEST_CODE_REPO,
        file_path: c.filePath,
        content: c.content,
        embedding: codeEmbeddings[i],
        start_line: c.startLine,
        end_line: c.endLine,
        language: c.language,
        chunk_index: 0,
        metadata: { integration_test: true },
        commit_sha: "test-sha-000",
    }));

    await upsertCodeChunks(codeChunks);
    console.log(`Upserted ${codeChunks.length} code chunks.`);
}

// ---------------------------------------------------------------------------
// Phase 2: Direct DB search
// ---------------------------------------------------------------------------

async function testDirectSearch(embeddingClient: EmbeddingClient): Promise<void> {
    console.log("\n=== Phase 2: Direct DB search ===\n");

    // Test 1: "how to get started" should return Getting Started doc
    {
        console.log('Query: "how to get started with copilotkit"');
        const embedding = await embeddingClient.embed("how to get started with copilotkit");
        const results = await searchDocChunks(embedding, 5);
        assert(results.length > 0, "Got doc results");

        const topResult = results[0];
        assertContains(topResult.title, "Getting Started", "Top result title");
        assertContains(topResult.content, "npm install", "Top result content");
    }

    // Test 2: "useCopilotAction" should return the action hook doc
    {
        console.log('Query: "useCopilotAction hook for defining actions"');
        const embedding = await embeddingClient.embed("useCopilotAction hook for defining actions");
        const results = await searchDocChunks(embedding, 5);
        assert(results.length > 0, "Got doc results");

        const topResult = results[0];
        assertContains(topResult.title, "useCopilotAction", "Top result title");
        assertContains(topResult.content, "handler", "Top result mentions handler");
    }

    // Test 3: "CopilotRuntime class implementation" should return the runtime code
    {
        console.log('Query: "CopilotRuntime class implementation"');
        const embedding = await embeddingClient.embed("CopilotRuntime class implementation");
        const results = await searchCodeChunks(embedding, 5, TEST_CODE_REPO);
        assert(results.length > 0, "Got code results");

        const topResult = results[0];
        assertContains(topResult.content, "CopilotRuntime", "Top result contains CopilotRuntime");
        assertContains(topResult.file_path, "copilot-runtime", "Top result file path");
    }

    // Test 4: "python agent example" should return the Python snippet
    {
        console.log('Query: "python copilotkit agent sdk"');
        const embedding = await embeddingClient.embed("python copilotkit agent sdk");
        const results = await searchCodeChunks(embedding, 5, TEST_CODE_REPO);
        assert(results.length > 0, "Got code results");

        const found = results.some((r) => r.language === "python");
        assert(found, "Found a Python code result");
    }

    // Test 5: "React hook usage" should return the Next.js example
    {
        console.log('Query: "React hook copilot sidebar example"');
        const embedding = await embeddingClient.embed("React hook copilot sidebar example");
        const results = await searchCodeChunks(embedding, 5, TEST_CODE_REPO);
        assert(results.length > 0, "Got code results");

        const found = results.some((r) => r.file_path.includes("page.tsx"));
        assert(found, "Found the React page example");
    }
}

// ---------------------------------------------------------------------------
// Phase 3: MCP HTTP endpoint
// ---------------------------------------------------------------------------

async function startTestServer(): Promise<{ server: Server; port: number }> {
    const app = express();
    app.use(cors({ origin: "*", exposedHeaders: ["Mcp-Session-Id"] }));
    app.use(express.json());

    app.post("/mcp", async (req, res) => {
        try {
            const mcpServer = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            console.error("[test-server/MCP] Error:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
        }
    });

    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });

    return new Promise((resolve) => {
        // Use port 0 for OS-assigned ephemeral port
        const server = app.listen(0, () => {
            const addr = server.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            resolve({ server, port });
        });
    });
}

async function mcpRequest(
    baseUrl: string,
    body: unknown,
): Promise<Record<string, unknown>> {
    const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
    }

    // The stateless MCP transport returns SSE-formatted responses.
    // Parse the SSE stream to extract JSON-RPC messages.
    const text = await response.text();
    const messages: Record<string, unknown>[] = [];

    for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data) {
                messages.push(JSON.parse(data) as Record<string, unknown>);
            }
        }
    }

    if (messages.length === 0) {
        // Might be plain JSON (e.g. for errors)
        try {
            return JSON.parse(text) as Record<string, unknown>;
        } catch {
            throw new Error(`No parseable response: ${text.slice(0, 500)}`);
        }
    }

    // Return the last message (the tool call response, after any notifications)
    return messages[messages.length - 1];
}

async function testMcpEndpoint(port: number): Promise<void> {
    console.log("\n=== Phase 3: MCP HTTP endpoint ===\n");
    const baseUrl = `http://localhost:${port}/mcp`;

    // Each POST creates a fresh server, so we must initialize first.
    // The stateless transport handles initialize + tool call as a batch or sequentially.

    // Test 1: Initialize handshake
    {
        console.log("MCP initialize...");
        const result = await mcpRequest(baseUrl, {
            jsonrpc: "2.0",
            method: "initialize",
            id: 1,
            params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "integration-test", version: "1.0.0" },
            },
        });
        assert(result.result !== undefined, "Initialize returned a result");
        const initResult = result.result as Record<string, unknown>;
        assert(
            typeof initResult.serverInfo === "object",
            "Initialize result has serverInfo",
        );
    }

    // Test 2: search-docs via MCP tool call
    {
        console.log('MCP search-docs: "how to get started"');

        // Initialize first (stateless = fresh server each time)
        await mcpRequest(baseUrl, {
            jsonrpc: "2.0",
            method: "initialize",
            id: 10,
            params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "integration-test", version: "1.0.0" },
            },
        });

        // Hmm, stateless means we can't do initialize then tool call on the same server.
        // Let's test with a JSON-RPC batch: [initialize, notifications/initialized, tools/call]
    }

    // Actually, for stateless mode, send a batch request:
    // [initialize, notifications/initialized, tools/call]
    // The server processes them in order on the same server instance.

    // Test 2 (batch): search-docs
    {
        console.log('MCP batch: search-docs "how to get started"');
        const batchBody = [
            {
                jsonrpc: "2.0",
                method: "initialize",
                id: 20,
                params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "integration-test", version: "1.0.0" },
                },
            },
            {
                jsonrpc: "2.0",
                method: "notifications/initialized",
            },
            {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 21,
                params: {
                    name: "search-docs",
                    arguments: { query: "how to get started" },
                },
            },
        ];

        const response = await fetch(baseUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(batchBody),
        });

        assert(response.ok, `Batch request succeeded (status ${response.status})`);

        const text = await response.text();
        const messages: Record<string, unknown>[] = [];
        for (const line of text.split("\n")) {
            if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data) {
                    messages.push(JSON.parse(data) as Record<string, unknown>);
                }
            }
        }

        // Find the tools/call response (id: 21)
        const toolResponse = messages.find((m) => m.id === 21);
        assert(toolResponse !== undefined, "Got tool call response (id 21)");

        if (toolResponse) {
            const toolResult = toolResponse.result as Record<string, unknown>;
            const content = toolResult?.content as Array<Record<string, unknown>>;
            assert(content !== undefined && content.length > 0, "Tool returned content");

            if (content && content.length > 0) {
                const resultText = content[0].text as string;
                assertContains(resultText, "Getting Started", "MCP search-docs result");
            }
        }
    }

    // Test 3 (batch): search-code
    {
        console.log('MCP batch: search-code "CopilotRuntime class"');
        const batchBody = [
            {
                jsonrpc: "2.0",
                method: "initialize",
                id: 30,
                params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "integration-test", version: "1.0.0" },
                },
            },
            {
                jsonrpc: "2.0",
                method: "notifications/initialized",
            },
            {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 31,
                params: {
                    name: "search-code",
                    arguments: { query: "CopilotRuntime class" },
                },
            },
        ];

        const response = await fetch(baseUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(batchBody),
        });

        assert(response.ok, `Batch request succeeded (status ${response.status})`);

        const text = await response.text();
        const messages: Record<string, unknown>[] = [];
        for (const line of text.split("\n")) {
            if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data) {
                    messages.push(JSON.parse(data) as Record<string, unknown>);
                }
            }
        }

        const toolResponse = messages.find((m) => m.id === 31);
        assert(toolResponse !== undefined, "Got tool call response (id 31)");

        if (toolResponse) {
            const toolResult = toolResponse.result as Record<string, unknown>;
            const content = toolResult?.content as Array<Record<string, unknown>>;
            assert(content !== undefined && content.length > 0, "Tool returned content");

            if (content && content.length > 0) {
                const resultText = content[0].text as string;
                assertContains(resultText, "CopilotRuntime", "MCP search-code result");
            }
        }
    }

    // Test 4 (batch): search-docs for useCopilotAction
    {
        console.log('MCP batch: search-docs "useCopilotAction"');
        const batchBody = [
            {
                jsonrpc: "2.0",
                method: "initialize",
                id: 40,
                params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "integration-test", version: "1.0.0" },
                },
            },
            {
                jsonrpc: "2.0",
                method: "notifications/initialized",
            },
            {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 41,
                params: {
                    name: "search-docs",
                    arguments: { query: "useCopilotAction" },
                },
            },
        ];

        const response = await fetch(baseUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(batchBody),
        });

        assert(response.ok, `Batch request succeeded (status ${response.status})`);

        const text = await response.text();
        const messages: Record<string, unknown>[] = [];
        for (const line of text.split("\n")) {
            if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data) {
                    messages.push(JSON.parse(data) as Record<string, unknown>);
                }
            }
        }

        const toolResponse = messages.find((m) => m.id === 41);
        assert(toolResponse !== undefined, "Got tool call response (id 41)");

        if (toolResponse) {
            const toolResult = toolResponse.result as Record<string, unknown>;
            const content = toolResult?.content as Array<Record<string, unknown>>;
            assert(content !== undefined && content.length > 0, "Tool returned content");

            if (content && content.length > 0) {
                const resultText = content[0].text as string;
                assertContains(resultText, "useCopilotAction", "MCP search-docs result");
            }
        }
    }

    // Test 5: Health endpoint
    {
        console.log("Health check...");
        const healthRes = await fetch(`http://localhost:${port}/health`);
        assert(healthRes.ok, "Health endpoint returns 200");
        const healthBody = (await healthRes.json()) as Record<string, unknown>;
        assert(healthBody.status === "ok", "Health status is ok");
    }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupTestData(): Promise<void> {
    console.log("\n=== Cleanup ===\n");
    const pool = getPool();

    const docResult = await pool.query(
        "DELETE FROM doc_chunks WHERE file_path LIKE $1",
        [`${TEST_DOC_PATH_PREFIX}%`],
    );
    console.log(`Deleted ${docResult.rowCount} test doc chunks.`);

    const codeResult = await pool.query(
        "DELETE FROM code_chunks WHERE repo_url = $1",
        [TEST_CODE_REPO],
    );
    console.log(`Deleted ${codeResult.rowCount} test code chunks.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const overallStart = Date.now();
    console.log("=== Integration Test ===");
    console.log(`Started at ${new Date().toISOString()}\n`);

    // Ensure required env vars for config validation
    if (!process.env.GITHUB_WEBHOOK_SECRET) {
        process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    }

    const config = getConfig();

    console.log("Initializing database schema...");
    await initializeSchema();
    console.log("Schema ready.");

    const embeddingClient = new EmbeddingClient(
        config.openaiApiKey,
        config.embeddingModel,
        config.embeddingDimensions,
    );

    let httpServer: Server | undefined;

    try {
        // Phase 1: Index test data
        await indexTestData(embeddingClient);

        // Phase 2: Direct DB search
        await testDirectSearch(embeddingClient);

        // Phase 3: MCP HTTP endpoint
        const { server, port } = await startTestServer();
        httpServer = server;
        console.log(`Test server listening on port ${port}`);
        await testMcpEndpoint(port);
    } finally {
        // Always clean up
        await cleanupTestData();

        if (httpServer) {
            httpServer.close();
        }

        await getPool().end();
    }

    // Report
    const elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
    console.log(`\n=== Results: ${passed} passed, ${failed} failed (${elapsed}s) ===`);

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
