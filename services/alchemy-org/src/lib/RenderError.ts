/**
 * Render an unknown error into a string the MODEL can act on. Errors
 * that cross an RPC hop (Worker → DO → container) are deserialized as
 * plain objects — `String(error)` on those yields "[object Object]",
 * which destroys the signal and leaves agents retrying blind.
 */
export const renderError = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error === null || error === undefined) return String(error);
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const tag = typeof obj._tag === "string" ? obj._tag : undefined;
    const message = typeof obj.message === "string" ? obj.message : undefined;
    const head = [tag, message].filter(Boolean).join(": ");
    let rest: string | undefined;
    try {
      const seen = new WeakSet<object>();
      rest = JSON.stringify(obj, (key, value) => {
        if (key === "stack") return undefined;
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[circular]";
          seen.add(value);
        }
        return value;
      });
    } catch {
      // unserializable — the head is all we have
    }
    if (head.length > 0) return rest ? `${head} ${rest}` : head;
    return rest ?? String(error);
  }
  return String(error);
};
