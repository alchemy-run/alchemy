import { isAgent } from "./Agent.ts";
import { kernelPrompts } from "./KernelPrompts.ts";

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
 * - **Control refs render their model-facing prose IN PLACE** (§A): a
 *   `Halt` renders its halt-contract block (or the perpetual note),
 *   `Budget` renders the ceilings, `Concurrency`/`Trigger` render
 *   inline. This is why the kernel no longer re-appends a separate
 *   `# Halt condition` heading — the author's `${AI.until(…)}` /
 *   `${AI.budget(…)}` placement IS the rendered contract. (Before this,
 *   every control ref rendered to the empty string and the budget was
 *   never shown to the model at all.)
 * - `Check` / `Fold` render the empty string in the HOST prompt: their
 *   prose is recipient-scoped (it renders into the verifier's / fold
 *   agent's prompt, not the worker's). `Observe` renders nothing.
 */
export const renderTemplate = (
  template: TemplateStringsArray | ReadonlyArray<string>,
  refs: ReadonlyArray<unknown>,
  /**
   * Resolves a dynamic-prose `Value` ref to its string (reassess §F).
   * The kernel supplies this at interpretation time, having resolved
   * each Value's service tag from ambient context. Absent (topology,
   * static previews) ⇒ the Value renders as a `{…}` hole.
   */
  resolveValue?: (ref: unknown) => string | undefined,
): string => {
  let out = template[0] ?? "";
  refs.forEach((ref, index) => {
    out += displayRef(ref, resolveValue) + (template[index + 1] ?? "");
  });
  return normalize(out);
};

const displayRef = (
  ref: unknown,
  resolveValue?: (ref: unknown) => string | undefined,
): string => {
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
    case "Value": {
      const resolved = resolveValue?.(ref);
      if (resolved !== undefined) return resolved;
      // no context (topology/preview): a typed hole
      const tag = (ref as { tag?: { key?: string } }).tag;
      return `{${tag?.key ?? "value"}}`;
    }
    case "Halt": {
      const halt = ref as {
        mode: "until" | "never";
        schema: unknown;
        template: TemplateStringsArray;
        refs: ReadonlyArray<unknown>;
      };
      const prose = renderTemplate(halt.template, halt.refs);
      return halt.mode === "never"
        ? kernelPrompts.perpetualNote({ healthProse: prose })
        : kernelPrompts.haltContract({
            haltProse: prose,
            hasSchema: halt.schema !== undefined,
          });
    }
    case "Budget":
      return kernelPrompts.budgetNote((ref as { limits: any }).limits);
    case "Concurrency":
      return kernelPrompts.concurrencyNote((ref as { n: number }).n);
    case "Trigger": {
      const trigger = ref as {
        mode: "on" | "each" | "every";
        sources: ReadonlyArray<Record<string, unknown>>;
      };
      const sources = trigger.sources
        .map((source) =>
          source["~alchemy/Kind"] === "Cron"
            ? String(source.expression)
            : String(source["~alchemy/Name"] ?? ""),
        )
        .filter((label) => label.length > 0)
        .join(", ");
      return kernelPrompts.triggerNote({ mode: trigger.mode, sources });
    }
    // Check/Fold prose is recipient-scoped; Observe is silent.
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
