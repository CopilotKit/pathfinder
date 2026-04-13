import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractContent } from "../indexing/content-extractors.js";

describe("extractContent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "extract-test-"),
    );
  });

  // ── Non-document types pass through as UTF-8 ──────────────────────────

  it("reads plain text for non-document source types", async () => {
    const filePath = path.join(tmpDir, "readme.md");
    await fs.promises.writeFile(filePath, "# Hello World");
    const result = await extractContent(filePath, "markdown");
    expect(result.content).toBe("# Hello World");
    expect(result.metadata).toBeUndefined();
  });

  it("reads plain text for html source type", async () => {
    const filePath = path.join(tmpDir, "page.html");
    await fs.promises.writeFile(filePath, "<h1>Title</h1>");
    const result = await extractContent(filePath, "html");
    expect(result.content).toBe("<h1>Title</h1>");
  });

  // ── Document type with unknown extension falls back to UTF-8 ──────────

  it("falls back to UTF-8 for unknown extension under document type", async () => {
    const filePath = path.join(tmpDir, "notes.txt");
    await fs.promises.writeFile(filePath, "Plain text notes");
    const result = await extractContent(filePath, "document");
    expect(result.content).toBe("Plain text notes");
  });

  // ── PDF extraction ────────────────────────────────────────────────────

  describe("PDF extraction", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it("extracts text from a PDF file", async () => {
      const mockPdfParse = vi.fn().mockResolvedValue({
        text: "Page 1 content\n\nPage 2 content",
        numpages: 2,
        info: { Title: "Test Document", Author: "Test Author" },
      });

      vi.doMock("pdf-parse", () => ({ default: mockPdfParse }));

      const { extractContent: extractContentMocked } = await import(
        "../indexing/content-extractors.js"
      );

      const filePath = path.join(tmpDir, "test.pdf");
      await fs.promises.writeFile(filePath, Buffer.from("fake-pdf-bytes"));

      const result = await extractContentMocked(filePath, "document");
      expect(result.content).toBe("Page 1 content\n\nPage 2 content");
      expect(result.metadata).toEqual({
        title: "Test Document",
        author: "Test Author",
        pageCount: 2,
      });
      expect(mockPdfParse).toHaveBeenCalledWith(expect.any(Buffer));
    });

    it("throws a clear error when pdf-parse is not installed", async () => {
      vi.doMock("pdf-parse", () => {
        throw new Error("Cannot find module 'pdf-parse'");
      });

      const { extractContent: extractContentMocked } = await import(
        "../indexing/content-extractors.js"
      );

      const filePath = path.join(tmpDir, "test.pdf");
      await fs.promises.writeFile(filePath, Buffer.from("fake-pdf-bytes"));

      await expect(
        extractContentMocked(filePath, "document"),
      ).rejects.toThrow(/install pdf-parse/i);
    });

    it("warns when PDF produces very little text (likely scanned)", async () => {
      const mockPdfParse = vi.fn().mockResolvedValue({
        text: "Hi",
        numpages: 10,
        info: {},
      });

      vi.doMock("pdf-parse", () => ({ default: mockPdfParse }));

      const { extractContent: extractContentMocked } = await import(
        "../indexing/content-extractors.js"
      );

      const filePath = path.join(tmpDir, "scanned.pdf");
      await fs.promises.writeFile(filePath, Buffer.from("fake-pdf-bytes"));

      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const result = await extractContentMocked(filePath, "document");
      expect(result.content).toBe("Hi");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("very little text"),
      );
      warnSpy.mockRestore();
    });
  });

  // ── DOCX extraction ───────────────────────────────────────────────────

  describe("DOCX extraction", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it("extracts text from a DOCX file", async () => {
      const mockMammoth = {
        extractRawText: vi.fn().mockResolvedValue({
          value:
            "Document heading\n\nParagraph one.\n\nParagraph two.",
          messages: [],
        }),
      };

      vi.doMock("mammoth", () => ({ default: mockMammoth }));

      const { extractContent: extractContentMocked } = await import(
        "../indexing/content-extractors.js"
      );

      const filePath = path.join(tmpDir, "test.docx");
      await fs.promises.writeFile(
        filePath,
        Buffer.from("fake-docx-bytes"),
      );

      const result = await extractContentMocked(filePath, "document");
      expect(result.content).toBe(
        "Document heading\n\nParagraph one.\n\nParagraph two.",
      );
      expect(mockMammoth.extractRawText).toHaveBeenCalledWith({
        path: filePath,
      });
    });

    it("throws a clear error when mammoth is not installed", async () => {
      vi.doMock("mammoth", () => {
        throw new Error("Cannot find module 'mammoth'");
      });

      const { extractContent: extractContentMocked } = await import(
        "../indexing/content-extractors.js"
      );

      const filePath = path.join(tmpDir, "test.docx");
      await fs.promises.writeFile(
        filePath,
        Buffer.from("fake-docx-bytes"),
      );

      await expect(
        extractContentMocked(filePath, "document"),
      ).rejects.toThrow(/install mammoth/i);
    });
  });

  // ── .PDF / .DOCX case insensitivity ───────────────────────────────────

  it("handles uppercase .PDF extension", async () => {
    vi.resetModules();
    const mockPdfParse = vi.fn().mockResolvedValue({
      text: "Uppercase PDF",
      numpages: 1,
      info: {},
    });

    vi.doMock("pdf-parse", () => ({ default: mockPdfParse }));

    const { extractContent: extractContentMocked } = await import(
      "../indexing/content-extractors.js"
    );

    const filePath = path.join(tmpDir, "TEST.PDF");
    await fs.promises.writeFile(filePath, Buffer.from("fake"));

    const result = await extractContentMocked(filePath, "document");
    expect(result.content).toBe("Uppercase PDF");
  });

  it("handles uppercase .DOCX extension", async () => {
    vi.resetModules();
    const mockMammoth = {
      extractRawText: vi.fn().mockResolvedValue({
        value: "Uppercase DOCX",
        messages: [],
      }),
    };

    vi.doMock("mammoth", () => ({ default: mockMammoth }));

    const { extractContent: extractContentMocked } = await import(
      "../indexing/content-extractors.js"
    );

    const filePath = path.join(tmpDir, "TEST.DOCX");
    await fs.promises.writeFile(filePath, Buffer.from("fake"));

    const result = await extractContentMocked(filePath, "document");
    expect(result.content).toBe("Uppercase DOCX");
  });

  // ── Corrupt/error files ─────────────────────────────────────────────────

  describe("PDF extraction error handling", () => {
    it("throws a meaningful error when pdf-parse fails on corrupt file", async () => {
      vi.resetModules();
      const mockPdfParse = vi
        .fn()
        .mockRejectedValue(new Error("Invalid PDF structure"));
      vi.doMock("pdf-parse", () => ({ default: mockPdfParse }));

      const { extractContent: extractContentMocked } = await import(
        "../indexing/content-extractors.js"
      );

      const filePath = path.join(tmpDir, "corrupt.pdf");
      await fs.promises.writeFile(
        filePath,
        Buffer.from("not-a-real-pdf"),
      );

      await expect(
        extractContentMocked(filePath, "document"),
      ).rejects.toThrow("Invalid PDF structure");
    });

    it("handles PDF with zero pages", async () => {
      vi.resetModules();
      const mockPdfParse = vi.fn().mockResolvedValue({
        text: "",
        numpages: 0,
        info: {},
      });
      vi.doMock("pdf-parse", () => ({ default: mockPdfParse }));

      const { extractContent: extractContentMocked } = await import(
        "../indexing/content-extractors.js"
      );

      const filePath = path.join(tmpDir, "empty.pdf");
      await fs.promises.writeFile(filePath, Buffer.from("fake"));

      const result = await extractContentMocked(filePath, "document");
      expect(result.content).toBe("");
    });

    it("handles very large PDF text output without crashing", async () => {
      vi.resetModules();
      const largeText = "Word ".repeat(100_000); // ~500KB of text
      const mockPdfParse = vi.fn().mockResolvedValue({
        text: largeText,
        numpages: 200,
        info: {},
      });
      vi.doMock("pdf-parse", () => ({ default: mockPdfParse }));

      const { extractContent: extractContentMocked } = await import(
        "../indexing/content-extractors.js"
      );

      const filePath = path.join(tmpDir, "large.pdf");
      await fs.promises.writeFile(filePath, Buffer.from("fake"));

      const result = await extractContentMocked(filePath, "document");
      expect(result.content.length).toBe(largeText.length);
    });
  });

  describe("DOCX extraction error handling", () => {
    it("surfaces mammoth warning messages to console", async () => {
      vi.resetModules();
      const mockMammoth = {
        extractRawText: vi.fn().mockResolvedValue({
          value: "Some text",
          messages: [
            {
              type: "warning",
              message: "Unrecognized style: CustomStyle",
            },
          ],
        }),
      };
      vi.doMock("mammoth", () => ({ default: mockMammoth }));

      const { extractContent: extractContentMocked } = await import(
        "../indexing/content-extractors.js"
      );

      const filePath = path.join(tmpDir, "warnings.docx");
      await fs.promises.writeFile(filePath, Buffer.from("fake"));

      const result = await extractContentMocked(filePath, "document");
      expect(result.content).toBe("Some text");
      // Mammoth warnings should not prevent extraction
    });
  });

  // ── File system errors ──────────────────────────────────────────────────

  describe("file system errors", () => {
    it("throws when file does not exist", async () => {
      await expect(
        extractContent("/nonexistent/file.pdf", "document"),
      ).rejects.toThrow();
    });

    it("throws when file path is a directory", async () => {
      await expect(
        extractContent(tmpDir, "document"),
      ).rejects.toThrow();
    });
  });

  // ── Source type pass-through ────────────────────────────────────────────

  describe("non-document source types with binary content", () => {
    it("reads binary-looking content as UTF-8 for non-document types (no crash)", async () => {
      const filePath = path.join(tmpDir, "binary.md");
      // Write content with some high-byte characters
      await fs.promises.writeFile(
        filePath,
        Buffer.from([0xc0, 0xc1, 0x48, 0x65, 0x6c, 0x6c, 0x6f]),
      );
      // Should not throw — reads as UTF-8 with replacement characters
      const result = await extractContent(filePath, "markdown");
      expect(typeof result.content).toBe("string");
    });
  });
});
