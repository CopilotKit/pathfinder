// Type declarations for optional peer dependency mammoth
declare module "mammoth" {
  interface ExtractionResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  const mammoth: {
    extractRawText(options: { path: string }): Promise<ExtractionResult>;
  };
  export default mammoth;
}
