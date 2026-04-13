#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const program = new Command();

program
  .name("pathfinder")
  .description("The knowledge server for AI agents")
  .version("1.11.0");

program
  .command("init")
  .description(
    "Scaffold a new Pathfinder project (use --from <url> to auto-generate from a docs site)",
  )
  .option(
    "--from <url>",
    "Auto-generate config by crawling a documentation URL",
  )
  .option(
    "--rate-limit <ms>",
    "Milliseconds between requests (default: 500)",
    parseInt,
  )
  .option("--max-pages <n>", "Maximum pages to crawl (default: 500)", parseInt)
  .option("--force", "Overwrite existing pathfinder.yaml")
  .action(async (opts) => {
    const cwd = process.cwd();

    if (opts.from) {
      // Auto-generate from URL
      const { initFromUrl } = await import("./cli-init.js");
      await initFromUrl({
        url: opts.from,
        targetDir: cwd,
        rateLimit: opts.rateLimit,
        maxPages: opts.maxPages,
        force: opts.force,
      });
      return;
    }

    // Original scaffold behavior
    const yamlDest = path.join(cwd, "pathfinder.yaml");
    if (fs.existsSync(yamlDest)) {
      console.log("pathfinder.yaml already exists, skipping.");
    } else {
      const templatePath = path.join(
        __dirname,
        "..",
        "pathfinder.example.yaml",
      );
      if (!fs.existsSync(templatePath)) {
        console.error("Could not find pathfinder.example.yaml template.");
        process.exit(1);
      }
      fs.copyFileSync(templatePath, yamlDest);
      console.log("Created pathfinder.yaml");
    }

    const envDest = path.join(cwd, ".env");
    if (fs.existsSync(envDest)) {
      console.log(".env already exists, skipping.");
    } else {
      const envTemplatePath = path.join(__dirname, "..", ".env.example");
      if (fs.existsSync(envTemplatePath)) {
        fs.copyFileSync(envTemplatePath, envDest);
        console.log("Created .env from template");
      } else {
        console.log("No .env.example found, skipping .env creation.");
      }
    }

    console.log("\nEdit pathfinder.yaml to configure your docs sources.");
    console.log("Then run: pathfinder serve");
  });

program
  .command("serve")
  .description("Start the Pathfinder MCP server")
  .option("-p, --port <port>", "Port to listen on", parseInt)
  .option("-c, --config <path>", "Path to pathfinder.yaml")
  .action(async (opts) => {
    const { startServer } = await import("./server.js");
    await startServer({
      port: opts.port,
      configPath: opts.config,
    });
  });

program
  .command("validate")
  .description("Validate config and probe source connectivity")
  .option("-c, --config <path>", "Path to pathfinder.yaml")
  .action(async (opts) => {
    const { validateConfig, formatValidationResult } =
      await import("./validate.js");
    const result = await validateConfig(opts.config);
    console.log(formatValidationResult(result));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });

program.parse();
