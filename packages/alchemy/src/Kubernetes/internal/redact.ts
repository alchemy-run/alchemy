import * as Redacted from "effect/Redacted";
import { isPlainObject } from "../../Util/data.ts";

/** Plaintext strings wrapped in {@link Redacted}, including nested containers. */
export const collectRedactedSecrets = (value: unknown): string[] => {
  const out: string[] = [];
  const visit = (current: unknown, sensitive: boolean): void => {
    if (Redacted.isRedacted(current)) {
      visit(Redacted.value(current), true);
      return;
    }

    if (typeof current === "number") {
      if (!sensitive) return;
      const text = String(current);
      if (text.length === 0) return;
      out.push(text);
      return;
    }

    if (typeof current === "string") {
      if (!sensitive || current.length === 0) return;
      out.push(current);
      // Env values are strings, so a redacted object arrives as JSON.
      // Parse it so an echoed inner secret still scrubs.
      const head = current.charCodeAt(0);
      if (head !== 123 && head !== 91) return;
      try {
        const parsed: unknown = JSON.parse(current);
        if (parsed !== null && typeof parsed === "object") visit(parsed, true);
      } catch {
        // Not JSON. The string itself is the secret.
      }
      return;
    }

    if (Array.isArray(current)) {
      for (const item of current) visit(item, sensitive);
      return;
    }

    if (isPlainObject(current)) {
      for (const item of Object.values(current)) visit(item, sensitive);
    }
  };

  visit(value, false);
  return out;
};

const tokenNeedles = (secret: string): string[] => [
  ...new Set(
    [secret, Buffer.from(secret).toString("base64"), JSON.stringify(secret).slice(1, -1)].filter(
      (needle) => needle.length > 0,
    ),
  ),
];

// Secrets shorter than 4 stay token-bounded so "42" does not eat "14293".
// Longer secrets match as substrings (`printf "prefix%ssuffix"`).
const replaceToken = (text: string, needle: string, whole: boolean): string => {
  if (needle.length === 0 || !text.includes(needle)) return text;
  if (whole) return text.replaceAll(needle, "<redacted>");
  const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![A-Za-z0-9_])${pattern}(?![A-Za-z0-9_])`, "g"), "<redacted>");
};

const scrubText = (text: string, secrets: readonly string[]): string => {
  // One secret can be a prefix of another. Replace the longest needle first
  // or the shorter one splits the longer one and leaves the suffix behind.
  const byNeedle = new Map<string, boolean>();
  for (const secret of secrets) {
    const whole = secret.length >= 4;
    for (const needle of tokenNeedles(secret)) {
      byNeedle.set(needle, byNeedle.get(needle) === true || whole);
    }
  }
  const ordered = [...byNeedle.entries()].sort((left, right) => right[0].length - left[0].length);
  let out = text;
  for (const [needle, whole] of ordered) out = replaceToken(out, needle, whole);
  return out;
};

const scrubNode = (value: unknown, secrets: readonly string[]): unknown => {
  if (typeof value === "string") return scrubText(value, secrets);
  if (typeof value === "number" && secrets.some((secret) => secret === String(value))) {
    return "<redacted>";
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubNode(item, secrets));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, scrubNode(child, secrets)]),
    );
  }
  return value;
};

/** Replace secret leaves, their base64, and bounded tokens with `<redacted>`. */
export const scrubSecrets = (text: string, secrets: readonly string[]): string => {
  if (secrets.length === 0 || text.length === 0) return text;
  try {
    return JSON.stringify(scrubNode(JSON.parse(text), secrets));
  } catch {
    return scrubText(text, secrets);
  }
};
