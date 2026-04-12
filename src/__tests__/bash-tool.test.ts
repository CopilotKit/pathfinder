import { describe, it, expect } from "vitest";
import { Bash } from "just-bash";
import { formatBashResult, parseBareCD } from "../mcp/tools/bash.js";

describe("parseBareCD", () => {
  it("parses cd with absolute path", () => {
    expect(parseBareCD("cd /docs")).toBe("/docs");
  });
  it("parses cd with relative path", () => {
    expect(parseBareCD("cd guides")).toBe("guides");
  });
  it("parses cd with no args (goes to /)", () => {
    expect(parseBareCD("cd")).toBe("/");
  });
  it("parses cd with .. path", () => {
    expect(parseBareCD("cd ..")).toBe("..");
  });
  it("returns null for cd in pipeline", () => {
    expect(parseBareCD("cd /docs && ls")).toBeNull();
  });
  it("returns null for cd with semicolon", () => {
    expect(parseBareCD("cd /docs; ls")).toBeNull();
  });
  it("returns null for cd with pipe", () => {
    expect(parseBareCD("echo foo | cd /docs")).toBeNull();
  });
  it("returns null for non-cd command", () => {
    expect(parseBareCD("ls /docs")).toBeNull();
  });
  it("handles whitespace around command", () => {
    expect(parseBareCD("  cd /docs  ")).toBe("/docs");
  });
});

describe("formatBashResult", () => {
  it("formats successful output", () => {
    const result = formatBashResult("ls /", {
      stdout: "file.txt\ndir\n",
      stderr: "",
      exitCode: 0,
    });
    expect(result).toBe("$ ls /\nfile.txt\ndir\n");
  });

  it("includes stderr and exit code on failure", () => {
    const result = formatBashResult("cat /missing", {
      stdout: "",
      stderr: "cat: /missing: No such file or directory\n",
      exitCode: 1,
    });
    expect(result).toBe(
      "$ cat /missing\ncat: /missing: No such file or directory\n\n[exit code 1]",
    );
  });

  it("includes both stdout and stderr on failure", () => {
    const result = formatBashResult("grep pattern /", {
      stdout: "some output\n",
      stderr: "grep: warning\n",
      exitCode: 2,
    });
    expect(result).toBe(
      "$ grep pattern /\nsome output\n\ngrep: warning\n\n[exit code 2]",
    );
  });

  it("handles exit code 0 with stderr (warnings)", () => {
    const result = formatBashResult("ls /", {
      stdout: "file.txt\n",
      stderr: "ls: warning\n",
      exitCode: 0,
    });
    expect(result).toBe("$ ls /\nfile.txt\n\nls: warning\n");
  });

  it("handles empty stdout and stderr with non-zero exit", () => {
    const result = formatBashResult("false", {
      stdout: "",
      stderr: "",
      exitCode: 1,
    });
    expect(result).toBe("$ false\n[exit code 1]");
  });
});

describe("Bash integration", () => {
  const files: Record<string, string> = {
    "/docs/quickstart.mdx": "# Quickstart\nGet started here.",
    "/docs/guides/streaming.mdx": "# Streaming\nHow to stream.",
    "/code/src/index.ts": "export function main() {}",
  };

  it("find lists all files", async () => {
    const bash = new Bash({ files });
    const result = await bash.exec("find / -type f | sort");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/docs/quickstart.mdx");
    expect(result.stdout).toContain("/docs/guides/streaming.mdx");
    expect(result.stdout).toContain("/code/src/index.ts");
  });

  it("cat reads file contents", async () => {
    const bash = new Bash({ files });
    const result = await bash.exec("cat /docs/quickstart.mdx");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Quickstart");
  });

  it("grep finds patterns across files", async () => {
    const bash = new Bash({ files });
    const result = await bash.exec('grep -rl "Streaming" /');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/docs/guides/streaming.mdx");
  });

  it("filesystem persists across exec calls", async () => {
    const bash = new Bash({ files });
    await bash.exec('echo "new content" > /tmp/test.txt');
    const result = await bash.exec("cat /tmp/test.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("new content");
  });

  it("just-bash resets cwd between exec calls", async () => {
    const bash = new Bash({ files, cwd: "/" });
    await bash.exec("cd /docs");
    const result = await bash.exec("pwd");
    expect(result.stdout.trim()).toBe("/");
  });

  it("grep commands pass through to bash unchanged (no interception)", async () => {
    const bash = new Bash({ files });
    const result = await bash.exec('grep -rl "Streaming" /');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/docs/guides/streaming.mdx");
  });
});
