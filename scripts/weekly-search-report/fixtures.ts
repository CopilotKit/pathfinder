/// <reference types="node" />
/**
 * Recorded analytics-API JSON fixtures for the weekly-search-report tests.
 *
 * These match the API CONTRACT exactly (see weekly-search-report.ts types):
 *   summary           → AnalyticsSummary
 *   /queries          → TopQuery[]    (only queries with >=1 result)
 *   /empty-queries    → EmptyQuery[]
 *   /tool-breakdown   → ToolBreakdownRow[] (count desc)
 */

import type {
  AnalyticsSummary,
  TopQuery,
  EmptyQuery,
  ToolBreakdownRow,
} from "./weekly-search-report.js";

export const SUMMARY_FIXTURE: AnalyticsSummary = {
  total_queries_window: 1234,
  unique_ip_count_window: 87,
  unique_session_count_window: 142,
  empty_result_count_window: 96,
  empty_result_rate_window: 0.0778,
  low_confidence_count_window: 30,
  low_confidence_rate_window: 0.0243,
  avg_latency_ms_window: 412,
  p95_latency_ms_window: 1180,
  queries_by_source: [
    { source_name: "claude-code", count: 800 },
    { source_name: "cursor", count: 434 },
  ],
  queries_per_day_window: [
    { day: "2026-06-15", count: 210 },
    { day: "2026-06-16", count: 188 },
    { day: "2026-06-17", count: 175 },
    { day: "2026-06-18", count: 160 },
    { day: "2026-06-19", count: 199 },
    { day: "2026-06-20", count: 150 },
    { day: "2026-06-21", count: 152 },
  ],
  earliest_query_day: "2026-06-15",
};

export const QUERIES_FIXTURE: TopQuery[] = [
  {
    query_text: "how to use CoAgents with LangGraph",
    tool_name: "search-docs",
    count: 50,
    avg_result_count: 4.2,
    avg_top_score: 0.81,
  },
  {
    query_text: "useCopilotAction frontend tool example",
    tool_name: "search-docs",
    count: 40,
    avg_result_count: 3.1,
    avg_top_score: 0.77,
  },
  {
    query_text: "CopilotKit runtime backend setup",
    tool_name: "search-code",
    count: 30,
    avg_result_count: 5.0,
    avg_top_score: 0.9,
  },
  {
    query_text: "ag-ui protocol event types",
    tool_name: "search-ag-ui-docs",
    count: 25,
    avg_result_count: 2.0,
    avg_top_score: 0.7,
  },
  {
    query_text: "generative ui rendering custom component",
    tool_name: "search-docs",
    count: 20,
    avg_result_count: 1.5,
    avg_top_score: 0.66,
  },
  {
    query_text: "v2 migration useCopilotChat hook",
    tool_name: "search-docs",
    count: 18,
    avg_result_count: 2.2,
    avg_top_score: 0.72,
  },
  {
    query_text: "how to theme the chat ui with css",
    tool_name: "search-docs",
    count: 15,
    avg_result_count: 3.0,
    avg_top_score: 0.69,
  },
  {
    query_text: "MCP middleware configuration",
    tool_name: "search-code",
    count: 12,
    avg_result_count: 4.0,
    avg_top_score: 0.83,
  },
  {
    query_text: "human in the loop interrupt approval",
    tool_name: "search-docs",
    count: 10,
    avg_result_count: 1.0,
    avg_top_score: 0.6,
  },
  {
    query_text: "streaming events tool call output",
    tool_name: "search-docs",
    count: 8,
    avg_result_count: 2.5,
    avg_top_score: 0.71,
  },
  {
    query_text: "shared state useCoAgent context",
    tool_name: "search-docs",
    count: 7,
    avg_result_count: 2.0,
    avg_top_score: 0.74,
  },
  {
    query_text: "getting started quickstart install",
    tool_name: "search-docs",
    count: 6,
    avg_result_count: 6.0,
    avg_top_score: 0.92,
  },
  {
    query_text: "something completely unrelated and weird",
    tool_name: "search-docs",
    count: 3,
    avg_result_count: 1.0,
    avg_top_score: 0.5,
  },
];

export const EMPTY_QUERIES_FIXTURE: EmptyQuery[] = [
  {
    query_text: "copilotkit stripe billing integration",
    tool_name: "search-docs",
    source_name: "claude-code",
    count: 14,
    last_seen: "2026-06-21T10:00:00Z",
  },
  {
    query_text: "deploy copilotkit to cloudflare workers",
    tool_name: "search-docs",
    source_name: "cursor",
    count: 9,
    last_seen: "2026-06-20T09:00:00Z",
  },
  {
    query_text: "websocket transport custom adapter",
    tool_name: "search-code",
    source_name: "claude-code",
    count: 4,
    last_seen: "2026-06-19T11:00:00Z",
  },
];

export const TOOL_BREAKDOWN_FIXTURE: ToolBreakdownRow[] = [
  { tool_name: "search-docs", count: 700 },
  { tool_name: "search-code", count: 300 },
  { tool_name: "search-ag-ui-docs", count: 120 },
  { tool_name: "explore-bash", count: 80 },
  { tool_name: "explore-grep", count: 34 },
];
