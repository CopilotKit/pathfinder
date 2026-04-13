// CLI init --from logic: crawl a URL and generate pathfinder.yaml.

import fs from "fs";
import path from "path";
import { crawlSite, type CrawlOptions } from "./crawl.js";
import { generateConfigYaml, detectSourceType } from "./config-generator.js";

/**
 * Validate that the input URL is a valid HTTP(S) URL.
 */
export function validateInitUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Invalid URL: "${url}". Please provide a full URL like https://docs.example.com`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL must be http or https, got: ${parsed.protocol}`);
  }
}

/**
 * Write generated config YAML to the target directory.
 */
export function writeGeneratedConfig(
  targetDir: string,
  yamlContent: string,
  force: boolean = false,
): void {
  const dest = path.join(targetDir, "pathfinder.yaml");
  if (fs.existsSync(dest) && !force) {
    throw new Error(
      `pathfinder.yaml already exists at ${dest}. Use --force to overwrite.`,
    );
  }
  fs.writeFileSync(dest, yamlContent, "utf-8");
}

/**
 * Run the full init-from-url flow: crawl, generate config, write file.
 */
export async function initFromUrl(options: {
  url: string;
  targetDir: string;
  rateLimit?: number;
  maxPages?: number;
  force?: boolean;
}): Promise<void> {
  const { url, targetDir, rateLimit, maxPages, force } = options;

  validateInitUrl(url);

  const hostname = new URL(url).hostname;
  const cacheDir = path.join(targetDir, ".pathfinder", "cache", hostname);

  console.log(`\nCrawling ${url}...`);
  console.log(`  Rate limit: ${rateLimit ?? 500}ms between requests`);
  console.log(`  Max pages: ${maxPages ?? 500}`);
  console.log(`  Cache dir: ${cacheDir}\n`);

  const crawlOptions: CrawlOptions = {
    rateLimit: rateLimit ?? 500,
    maxPages: maxPages ?? 500,
    cacheDir,
  };

  const result = await crawlSite(url, crawlOptions);

  if (result.pages.length === 0) {
    console.error("\nNo pages were successfully crawled.");
    if (result.failedUrls.length > 0) {
      console.error(`\nFailed URLs (${result.failedUrls.length}):`);
      for (const failed of result.failedUrls.slice(0, 10)) {
        console.error(`  ${failed.status} ${failed.url} (${failed.reason})`);
      }
    }
    process.exit(1);
  }

  console.log(
    `\nCrawled ${result.pages.length} pages via ${result.discoveryMethod}.`,
  );

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of result.warnings) {
      console.log(`  Warning: ${warning}`);
    }
  }

  if (result.failedUrls.length > 0) {
    console.log(`\nFailed to fetch ${result.failedUrls.length} URLs:`);
    for (const failed of result.failedUrls.slice(0, 5)) {
      console.log(`  ${failed.status} ${failed.url} (${failed.reason})`);
    }
    if (result.failedUrls.length > 5) {
      console.log(`  ... and ${result.failedUrls.length - 5} more`);
    }
  }

  const yamlContent = generateConfigYaml(result, url);
  writeGeneratedConfig(targetDir, yamlContent, force);

  const sourceType =
    result.pages.length > 0 ? detectSourceType(result.pages) : "unknown";
  console.log(`\nGenerated pathfinder.yaml`);
  console.log(`  Source type: ${sourceType}`);
  console.log(`  Pages cached: ${result.pages.length} in ${cacheDir}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review pathfinder.yaml and adjust if needed`);
  console.log(`  2. Set OPENAI_API_KEY and DATABASE_URL in .env`);
  console.log(`  3. Run: pathfinder serve`);
}
