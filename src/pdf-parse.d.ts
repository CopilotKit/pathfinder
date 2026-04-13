// Type declarations for optional peer dependency pdf-parse
declare module "pdf-parse" {
  interface PdfData {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
  }
  function pdfParse(buffer: Buffer): Promise<PdfData>;
  export default pdfParse;
}
