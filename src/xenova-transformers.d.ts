// Type declarations for optional peer dependency @xenova/transformers
declare module "@xenova/transformers" {
  export function pipeline(
    task: string,
    model: string,
  ): Promise<{
    _call(
      texts: string[],
      options: { pooling: string; normalize: boolean },
    ): Promise<{ tolist(): number[][] }>;
  }>;
}
