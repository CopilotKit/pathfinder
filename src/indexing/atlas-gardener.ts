import { createHash } from "node:crypto";

import {
  clearAtlasCachePageStale,
  listStaleAtlasCachePages,
  recordAtlasCachePageGenerationError,
} from "../db/atlas.js";
import type { AtlasCachePage } from "../db/atlas.js";

export interface AtlasGardenerGeneratedPage {
  content: string;
  contentHash?: string;
  generatedSeedIds?: number[];
  provenance?: Record<string, unknown>;
}

export interface GardenAtlasCachePagesOptions {
  sourceName?: string;
  generatePage?: (
    page: AtlasCachePage,
  ) => Promise<AtlasGardenerGeneratedPage> | AtlasGardenerGeneratedPage;
}

export interface GardenAtlasCachePagesSummary {
  regenerated: number;
  failed: number;
}

function stableContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function defaultGeneratePage(page: AtlasCachePage): AtlasGardenerGeneratedPage {
  const content = [
    `# ${page.title}`,
    "",
    `Atlas cache page placeholder for ${page.pageKey}.`,
    "",
    "A domain-specific generator can replace this deterministic content.",
  ].join("\n");
  return { content };
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Atlas cache page generation failed";
}

export async function gardenAtlasCachePages(
  options: GardenAtlasCachePagesOptions = {},
): Promise<GardenAtlasCachePagesSummary> {
  const pages = await listStaleAtlasCachePages({
    sourceName: options.sourceName,
  });
  const generatePage = options.generatePage ?? defaultGeneratePage;
  let regenerated = 0;
  let failed = 0;

  for (const page of pages) {
    try {
      const generated = await generatePage(page);
      await clearAtlasCachePageStale({
        pageKey: page.pageKey,
        content: generated.content,
        contentHash:
          generated.contentHash ?? stableContentHash(generated.content),
        generatedSeedIds: generated.generatedSeedIds,
        provenance: generated.provenance,
      });
      regenerated++;
    } catch (error) {
      failed++;
      await recordAtlasCachePageGenerationError(
        page.pageKey,
        errorMessageFromUnknown(error),
      );
    }
  }

  return { regenerated, failed };
}
