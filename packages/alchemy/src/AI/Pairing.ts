import * as Prompt from "effect/unstable/ai/Prompt";

/**
 * The tool-pairing invariant, enforced as **repair-on-read** (§2.4, §9.3):
 * a pure, deterministic, idempotent normalization pass over Trace-derived
 * messages, run every time a prompt is materialized for a model call —
 * after any fold, trim, or compaction, composing with all of them.
 *
 * Rules (each a purchased lesson from the harness survey):
 *
 * - **Orphaned tool calls get synthetic failed results**, inserted
 *   immediately after the calling message. A skipped call with no result
 *   makes the model invent success (the confabulation trap); an explicit
 *   "aborted" result keeps it honest. Because effect/ai tool results key
 *   on the call id alone, synthetic fills are cache-stable by
 *   construction (their content is a pure function of the orphaned call).
 * - **Provider-executed calls are exempt** — their results arrive in-band
 *   from the provider and may legitimately defer (the typed exemption).
 * - **Orphaned tool results are dropped** — a result whose call was
 *   trimmed away would otherwise fail provider validation.
 * - **Approval parts are stripped** (defense-in-depth for the G1
 *   landmine, §2.6 build order: prompts must never carry approval parts —
 *   effect/ai's approval pre-resolution executes approved tools even with
 *   tool-call resolution disabled; our durable Ask owns that lifecycle,
 *   and model-visible denials render as ordinary failed results).
 * - Messages left empty by stripping/dropping are removed.
 */

/**
 * The deterministic content of a synthetic result. Changing this string
 * changes model-visible history and invalidates prompt caches — treat it
 * like a wire format.
 */
export const SYNTHETIC_ABORTED = "aborted";

type AnyPart = { readonly type: string } & Record<string, any>;

const partsOf = (message: Prompt.Message): ReadonlyArray<AnyPart> =>
  message.content as unknown as ReadonlyArray<AnyPart>;

const isApprovalPart = (part: AnyPart): boolean =>
  part.type === "tool-approval-request" ||
  part.type === "tool-approval-response";

/**
 * Repair a Trace-derived message list into a well-paired prompt.
 * Pure, deterministic, idempotent; property-tested for all three plus
 * composition with arbitrary trims.
 */
export const repairToolPairing = (
  messages: ReadonlyArray<Prompt.Message>,
): ReadonlyArray<Prompt.Message> => {
  // 1. index every kernel-executed tool call (provider-executed exempt)
  const callIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of partsOf(message)) {
      if (part.type === "tool-call" && !part.providerExecuted) {
        callIds.add(part.id as string);
      }
    }
  }

  // 2. strip approval parts; drop results whose call was trimmed away;
  //    drop messages left empty
  const cleaned: Prompt.Message[] = [];
  for (const message of messages) {
    const kept = partsOf(message).filter((part) => {
      if (isApprovalPart(part)) return false;
      if (part.type === "tool-result" && message.role === "tool") {
        // keep only results answering a surviving kernel-executed call or
        // a provider-executed call embedded in an assistant message
        return callIds.has(part.id as string);
      }
      return true;
    });
    if (kept.length === 0) continue;
    cleaned.push(
      kept.length === partsOf(message).length
        ? message
        : (Prompt.makeMessage(message.role, {
            ...message,
            content: kept,
          } as never) as Prompt.Message),
    );
  }

  // 3. index surviving results
  const resultIds = new Set<string>();
  for (const message of cleaned) {
    for (const part of partsOf(message)) {
      if (part.type === "tool-result") resultIds.add(part.id as string);
    }
  }

  // 4. synthesize failed results for orphaned calls, inserted immediately
  //    after the calling message (reverse order keeps indices stable)
  const inserts: Array<[index: number, message: Prompt.Message]> = [];
  cleaned.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const orphans = partsOf(message).filter(
      (part) =>
        part.type === "tool-call" &&
        !part.providerExecuted &&
        !resultIds.has(part.id as string),
    );
    if (orphans.length === 0) return;
    inserts.push([
      index,
      Prompt.makeMessage("tool", {
        content: orphans.map((orphan) =>
          Prompt.makePart("tool-result", {
            id: orphan.id as string,
            name: orphan.name as string,
            isFailure: true,
            result: SYNTHETIC_ABORTED,
          }),
        ),
      }) as Prompt.Message,
    ]);
  });

  const repaired = [...cleaned];
  for (const [index, message] of inserts.reverse()) {
    repaired.splice(index + 1, 0, message);
  }
  return repaired;
};
