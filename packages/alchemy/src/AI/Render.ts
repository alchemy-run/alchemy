import { isAgent } from "./Agent.ts";

/**
 * The interim deterministic renderer (design §1.6): flattens a term's
 * tagged template into prose by substituting each interpolated ref with
 * its display form. Same term ⇒ same string ⇒ same `promptHash`.
 *
 * Display policy:
 *
 * - `Parameter` refs render as `{name}` — the placeholder the model is
 *   told to fill.
 * - `Tool` / `Agent` / `Process` refs render as their declared name — prose
 *   mentions the collaborator; wiring stays out of band.
 * - Control refs (`Trigger`, `Halt`, `Fold`, `Check`, `Budget`,
 *   `Observe`, `Concurrency`) render as the empty string — they are
 *   wiring, not prose. (The renderer proper will inline `until`'s nested
 *   template into halt-tool descriptions; Phase 1 backlog.)
 */
export const renderTemplate = (
  template: TemplateStringsArray | ReadonlyArray<string>,
  refs: ReadonlyArray<unknown>,
): string => {
  let out = template[0] ?? "";
  refs.forEach((ref, index) => {
    out += displayRef(ref) + (template[index + 1] ?? "");
  });
  return normalize(out);
};

const displayRef = (ref: unknown): string => {
  if (typeof ref === "string" || typeof ref === "number") return String(ref);
  if (ref === null || (typeof ref !== "object" && typeof ref !== "function")) {
    return "";
  }
  const record = ref as Record<string, unknown>;
  const kind = record["~alchemy/Kind"];
  const name = record["~alchemy/Name"];
  switch (kind) {
    case "Param":
      return `{${String(name)}}`;
    case "Tool":
      return String(name);
    default:
      return isAgent(ref) || kind === "Process" ? String(name) : "";
  }
};

/** Collapse the whitespace artifacts left by elided control refs. */
const normalize = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
