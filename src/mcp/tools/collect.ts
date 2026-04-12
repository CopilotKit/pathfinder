import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectToolConfig } from "../../types.js";
import { insertCollectedData } from "../../db/queries.js";

type FieldDef = CollectToolConfig["schema"][string];

/**
 * Convert a YAML-defined schema (record of field definitions) into a Zod shape record.
 */
export function yamlSchemaToZod(
  schema: CollectToolConfig["schema"],
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [fieldName, field] of Object.entries(schema) as [
    string,
    FieldDef,
  ][]) {
    let fieldSchema: z.ZodTypeAny;

    switch (field.type) {
      case "string":
        fieldSchema = z.string();
        break;
      case "number":
        fieldSchema = z.number();
        break;
      case "enum":
        fieldSchema = z.enum(field.values as [string, ...string[]]);
        break;
      default:
        throw new Error(
          `Unsupported field type "${field.type}" for field "${fieldName}"`,
        );
    }

    if (field.description) {
      fieldSchema = fieldSchema.describe(field.description);
    }

    if (!field.required) {
      fieldSchema = fieldSchema.optional();
    }

    shape[fieldName] = fieldSchema;
  }

  return shape;
}

/**
 * Register a collect tool on the MCP server.
 * The tool validates inputs against the YAML-defined schema and writes to the DB.
 */
export function registerCollectTool(
  server: McpServer,
  toolConfig: CollectToolConfig,
): void {
  const zodShape = yamlSchemaToZod(toolConfig.schema);

  server.tool(
    toolConfig.name,
    toolConfig.description,
    zodShape,
    async (input) => {
      try {
        await insertCollectedData(toolConfig.name, input);
        return {
          content: [{ type: "text" as const, text: toolConfig.response }],
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(
          `[${toolConfig.name}] Error inserting collected data: ${detail}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Failed to store data. Please try again later.",
            },
          ],
          isError: true,
        };
      }
    },
  );
}
