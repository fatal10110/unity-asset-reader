/** A command line the CLI refuses: printed with the usage text, exit status 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** An error's message, for a report line. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `JSON.stringify` replacer for type tree values (the core README's
 * `unityJsonReplacer`): a `bigint` becomes its decimal string, a byte array
 * (`Uint8Array`) its bytes in hex.
 *
 * @param _key the property name, unused
 * @param value the value to write
 * @returns the value to write instead
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return value;
}
