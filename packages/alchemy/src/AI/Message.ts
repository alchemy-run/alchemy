/**
 * One MESSAGE crossing a session boundary — the unit every
 * conversational surface speaks: `Sessions.send`/`dispatch` inputs,
 * a dispatch's pre-history, the durable inbox, and the `input`
 * observation all carry this shape. Standardizing it gives every
 * message a stable identity from birth (callers that own identity —
 * a chat storing its own posts — pass their id; everything else gets
 * one minted at the door) and an optional author, so multi-party
 * conversations are attributed structurally instead of by in-band
 * text conventions.
 *
 * `Content` is `string` on the public surface (chat). The engine's
 * internal rows widen it to `unknown` so typed event payloads
 * (`AI.Event`) keep flowing to charters structurally — they are
 * wrapped, never stringified, at the door.
 */
export interface Message<Content = string> {
  /**
   * Globally unique, stable from birth — the handle a client, a
   * projection, or a domain store uses to reference this message
   * forever. Caller-supplied when the caller owns identity;
   * engine-minted (`m-…`) otherwise. Re-sending a message whose id
   * is still PENDING in a session's inbox is idempotent: the row is
   * not duplicated.
   */
  readonly id: string;
  /**
   * Who said it — a session name, a human, a role. Absent for
   * driver-authored provenance (reminders, recovery notes) and for
   * callers with nothing to attribute. An authored message renders
   * into the model's thread as `author: content`.
   */
  readonly author?: string;
  readonly content: Content;
}

/**
 * Structural check for a message envelope: an `id` string and a
 * `content` key, without an event payload's `_tag` (tagged event
 * payloads are their own admission alphabet and must never be
 * mistaken for an envelope).
 */
export const isMessage = (value: unknown): value is Message<unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    id?: unknown;
    author?: unknown;
    _tag?: unknown;
  };
  return (
    typeof record.id === "string" &&
    "content" in value &&
    record._tag === undefined &&
    (record.author === undefined || typeof record.author === "string")
  );
};

/** Mint a message id at the door — time-ordered prefix + entropy,
 *  unique across processes. */
export const mintMessageId = (): string =>
  `m-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
