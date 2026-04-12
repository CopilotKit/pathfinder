import { describe, it, expect } from "vitest";
import {
  SourceConfigSchema,
  DiscordSourceConfigSchema,
  DiscordChannelConfigSchema,
} from "../types.js";

describe("DiscordChannelConfigSchema", () => {
  it("accepts valid text channel", () => {
    const result = DiscordChannelConfigSchema.safeParse({
      id: "111",
      type: "text",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid forum channel", () => {
    const result = DiscordChannelConfigSchema.safeParse({
      id: "222",
      type: "forum",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty id", () => {
    const result = DiscordChannelConfigSchema.safeParse({
      id: "",
      type: "text",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid channel type", () => {
    const result = DiscordChannelConfigSchema.safeParse({
      id: "111",
      type: "voice",
    });
    expect(result.success).toBe(false);
  });
});

describe("DiscordSourceConfigSchema", () => {
  it("accepts valid discord source config", () => {
    const config = {
      name: "discord-test",
      type: "discord",
      guild_id: "123456789012345678",
      channels: [
        { id: "111111111111111111", type: "text" },
        { id: "222222222222222222", type: "forum" },
      ],
      chunk: {},
    };
    const result = SourceConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "discord") {
      expect(result.data.guild_id).toBe("123456789012345678");
      expect(result.data.channels).toHaveLength(2);
      expect(result.data.confidence_threshold).toBe(0.7); // default
      expect(result.data.min_thread_replies).toBe(2); // default
      expect(result.data.category).toBe("faq"); // default
    }
  });

  it("accepts discord source with all optional fields", () => {
    const config = {
      name: "discord-full",
      type: "discord",
      guild_id: "123456789012345678",
      channels: [{ id: "111", type: "text" }],
      confidence_threshold: 0.5,
      min_thread_replies: 3,
      distiller_model: "gpt-4o",
      chunk: { target_tokens: 800 },
    };
    const result = SourceConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "discord") {
      expect(result.data.confidence_threshold).toBe(0.5);
      expect(result.data.min_thread_replies).toBe(3);
      expect(result.data.distiller_model).toBe("gpt-4o");
    }
  });

  it("rejects missing guild_id", () => {
    const config = {
      name: "discord-bad",
      type: "discord",
      channels: [{ id: "111", type: "text" }],
      chunk: {},
    };
    const result = SourceConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("rejects empty channels array", () => {
    const config = {
      name: "discord-empty",
      type: "discord",
      guild_id: "123",
      channels: [],
      chunk: {},
    };
    const result = SourceConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("rejects confidence_threshold out of range", () => {
    const config = {
      name: "discord-bad-threshold",
      type: "discord",
      guild_id: "123",
      channels: [{ id: "111", type: "text" }],
      confidence_threshold: 1.5,
      chunk: {},
    };
    const result = SourceConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("resolves correctly in discriminated union", () => {
    const config = {
      name: "discord-union",
      type: "discord",
      guild_id: "123",
      channels: [{ id: "111", type: "forum" }],
      chunk: {},
    };
    const result = SourceConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("discord");
    }
  });

  it("does not accept trigger_emoji (Discord-specific exclusion)", () => {
    const config = {
      name: "discord-no-emoji",
      type: "discord",
      guild_id: "123",
      channels: [{ id: "111", type: "text" }],
      trigger_emoji: "pathfinder",
      chunk: {},
    };
    // Zod strips unknown keys in strict mode, but with passthrough the schema
    // simply won't include trigger_emoji in the parsed output
    const result = SourceConfigSchema.safeParse(config);
    if (result.success && result.data.type === "discord") {
      expect("trigger_emoji" in result.data).toBe(false);
    }
  });

  it("discord source does not require path or file_patterns", () => {
    const config = {
      name: "discord-minimal",
      type: "discord",
      guild_id: "123",
      channels: [{ id: "111", type: "text" }],
      chunk: {},
    };
    const result = SourceConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});
