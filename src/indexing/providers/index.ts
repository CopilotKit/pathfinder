// Provider registry — maps source type to a DataProvider factory.

import type { DataProviderFactory } from "./types.js";

const registry = new Map<string, DataProviderFactory>();

export function registerProvider(
  type: string,
  factory: DataProviderFactory,
): void {
  registry.set(type, factory);
}

export function getProvider(type: string): DataProviderFactory {
  const factory = registry.get(type);
  if (!factory) {
    throw new Error(
      `Unknown provider type: "${type}". Available: ${[...registry.keys()].join(", ")}`,
    );
  }
  return factory;
}

export type {
  DataProvider,
  DataProviderFactory,
  ProviderOptions,
  ContentItem,
  AcquisitionResult,
} from "./types.js";

// Register built-in providers
import { FileDataProvider } from "./file.js";

for (const type of ["markdown", "code", "raw-text", "html", "document"]) {
  registerProvider(
    type,
    (config, options) => new FileDataProvider(config, options),
  );
}

import { SlackDataProvider } from "./slack.js";

registerProvider(
  "slack",
  (config, options) => new SlackDataProvider(config, options),
);

import { DiscordDataProvider } from "./discord.js";

registerProvider(
  "discord",
  (config, options) => new DiscordDataProvider(config, options),
);

import { NotionDataProvider } from "./notion.js";

registerProvider(
  "notion",
  (config, options) => new NotionDataProvider(config, options),
);
