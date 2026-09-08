/**
 * The CURSOR PROTOCOL — one resumable shape for every log-like stream
 * the org serves (today: the channel; the session transcript has its
 * own equivalent in the driver).
 *
 * A stream is an append-only sequence with a DENSE `seq` (1, 2, 3 …
 * no gaps) minted by its owning Durable Object. Two surfaces expose
 * it:
 *
 * - `GET …?after=<seq>&limit=<n>` → a {@link CursorPage}: `items` are
 *   contiguous `after+1 … after+n`, `head` is the current tail, and
 *   `next` is the last seq returned (`null` when caught up). Paging is
 *   by `seq`, never by time.
 * - WS `subscribe { after }` → replay `after+1 … head` as `batch`
 *   frames, then a `live` marker, then each append as an `item` frame.
 *   Replay and the switch to live run inside the DO's single-threaded
 *   turn, so an append during replay lands in the replay or the first
 *   live frame — never between.
 *
 * Clients assert `item.seq === last + 1`; on a gap or a reconnect they
 * re-subscribe with `after: last`. Dense seq makes a gap DETECTABLE,
 * not merely suspected. Push only makes delivery sooner — a consumer
 * that keeps its own `after` and re-pages from it is always correct.
 *
 * `update` is the one impurity: a row already delivered may be
 * amended in place (a thread tag landing retroactively). An update
 * frame re-delivers the row under its
 * ORIGINAL seq; a client that missed it converges on the next replay,
 * because replay always reads current rows.
 */

/** Anything the protocol can carry: a row with its dense position. */
export interface Sequenced {
  readonly seq: number;
}

export interface CursorPage<T extends Sequenced> {
  /** Contiguous `after+1 … after+n`, oldest first. */
  readonly items: ReadonlyArray<T>;
  /** The stream's current tail (0 when empty). */
  readonly head: number;
  /** The last seq in `items` — page again from here; `null` = caught up. */
  readonly next: number | null;
}

/** What the server sends over the socket. */
export type CursorServerFrame<T extends Sequenced> =
  | { readonly type: "batch"; readonly items: ReadonlyArray<T>; readonly head: number }
  | { readonly type: "live"; readonly seq: number }
  | { readonly type: "item"; readonly item: T }
  | { readonly type: "update"; readonly item: T };

/** What the client sends: one subscribe, repeated on gap/reconnect. */
export interface CursorClientFrame {
  readonly type: "subscribe";
  readonly after: number;
}

/** How many rows one GET page or one replay batch carries at most. */
export const CURSOR_PAGE_LIMIT = 200;

/** Shape a contiguous slice into the page the GET surface answers. */
export const cursorPage = <T extends Sequenced>(
  items: ReadonlyArray<T>,
  head: number,
): CursorPage<T> => ({
  items,
  head,
  next:
    items.length === 0 || items[items.length - 1]!.seq >= head
      ? null
      : items[items.length - 1]!.seq,
});
