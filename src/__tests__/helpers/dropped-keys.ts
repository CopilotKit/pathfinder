/**
 * Paths of keys present in `input` but missing from the parsed `output`.
 *
 * zod strips unknown keys instead of rejecting them, so a successful parse
 * alone passes a config with a misspelled or renamed key. Compare the input
 * with the parse result to find the keys the parse dropped.
 */
export function droppedKeys(
  input: unknown,
  output: unknown,
  path = "",
): string[] {
  if (Array.isArray(input)) {
    const outArr = Array.isArray(output) ? output : [];
    return input.flatMap((v, i) => droppedKeys(v, outArr[i], `${path}[${i}]`));
  }
  if (input === null || typeof input !== "object") return [];
  const outObj =
    output !== null && typeof output === "object"
      ? (output as Record<string, unknown>)
      : {};
  return Object.entries(input as Record<string, unknown>).flatMap(([k, v]) =>
    k in outObj ? droppedKeys(v, outObj[k], `${path}.${k}`) : [`${path}.${k}`],
  );
}
