/**
 * SELECTION — the multi-select model every list in the app shares
 * (channel messages, the sidebar's threads, a thread's transcript).
 * The gestures are the ones IDEs and mail clients taught everyone:
 *
 * - click       → select just this item (the anchor for ranges)
 * - ⌘/ctrl+click → toggle this item, keeping the rest
 * - ⇧+click     → select the range from the anchor to this item
 * - right-click → an item outside the selection replaces it; an item
 *                 inside leaves it — the menu acts on the whole set
 * - Escape      → clear; Delete/Backspace → the caller's delete
 *
 * Items are addressed by id; `order` (the ids as displayed, top to
 * bottom) is what ranges and the menu's ordering are computed over.
 * Ids that leave `order` (deleted rows) leave the selection with it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface Modifiers {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

export interface Selection {
  readonly selected: ReadonlySet<string>;
  readonly has: (id: string) => boolean;
  /**
   * A click on an item. Returns `true` when it was a SELECTION gesture
   * (⌘ or ⇧) — the caller then skips its plain-click action (opening
   * a thread, say). A plain click selects the one item AND returns
   * `false` so the plain action runs too.
   */
  readonly click: (id: string, mods: Modifiers) => boolean;
  /**
   * A right-click on an item: the ids the menu acts on, in display
   * order. Outside the selection the item replaces it; inside, the
   * selection stands.
   */
  readonly target: (id: string) => ReadonlyArray<string>;
  /** The selection in display order. */
  readonly ordered: ReadonlyArray<string>;
  readonly clear: () => void;
}

/** `true` when the key event belongs to something that edits text —
 *  the list must not steal its Delete/Escape. */
const inEditor = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable=true]") !==
      null
  );
};

/** Clicks that land on something interactive (a link, a button, the
 *  composer) are that thing's — never a selection gesture. */
export const onInteractive = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest("a, button, input, textarea, select, [role=button]") !==
    null;

/**
 * `onContextMenuCapture` for a list's menu trigger: a right-click ON
 * A LINK is the browser's (open in new tab, copy address…) — stop it
 * in the capture phase so neither the row nor the menu sees it, and
 * the native menu opens untouched.
 */
export const yieldLinkContextMenu = (event: {
  readonly target: EventTarget | null;
  stopPropagation(): void;
}): void => {
  if (
    event.target instanceof Element &&
    event.target.closest("a[href]") !== null
  ) {
    event.stopPropagation();
  }
};

interface RowMouseEvent extends Modifiers {
  readonly target: EventTarget | null;
  preventDefault(): void;
}

/**
 * `true` when a click on a row is NOT a selection gesture: it hit
 * something interactive, or (a plain click) it ended a drag that
 * selected text — copying a line must not also select the row.
 */
export const skipRowClick = (event: RowMouseEvent): boolean =>
  onInteractive(event.target) ||
  (!event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    (window.getSelection()?.toString() ?? "").length > 0);

/** `onMouseDown` for a row: ⇧ must range-select rows, not extend the
 *  browser's text selection from wherever the caret last was. */
export const onRowMouseDown = (event: RowMouseEvent): void => {
  if (event.shiftKey && !onInteractive(event.target)) event.preventDefault();
};

export const useSelection = (
  order: ReadonlyArray<string>,
  options: {
    /** Delete/Backspace with a selection (outside an editor). */
    readonly onDelete?: (ids: ReadonlyArray<string>) => void;
  } = {},
): Selection => {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const anchorRef = useRef<string | undefined>(undefined);
  const orderRef = useRef(order);
  orderRef.current = order;

  // rows that vanished (deleted under us) leave the selection
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const alive = new Set(order);
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [order]);

  const ordered = useMemo(
    () => order.filter((id) => selected.has(id)),
    [order, selected],
  );

  const click = useCallback((id: string, mods: Modifiers): boolean => {
    if (mods.shiftKey) {
      const list = orderRef.current;
      const anchor = anchorRef.current ?? id;
      const from = list.indexOf(anchor);
      const to = list.indexOf(id);
      if (from === -1 || to === -1) {
        setSelected(new Set([id]));
      } else {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelected(
          (current) => new Set([...current, ...list.slice(lo, hi + 1)]),
        );
      }
      // the anchor stays — successive ⇧-clicks re-range from it
      return true;
    }
    if (mods.metaKey || mods.ctrlKey) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchorRef.current = id;
      return true;
    }
    setSelected(new Set([id]));
    anchorRef.current = id;
    return false;
  }, []);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const target = useCallback((id: string): ReadonlyArray<string> => {
    const list = orderRef.current;
    if (selectedRef.current.has(id)) {
      return list.filter((entry) => selectedRef.current.has(entry));
    }
    setSelected(new Set([id]));
    anchorRef.current = id;
    return [id];
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchorRef.current = undefined;
  }, []);

  const onDelete = options.onDelete;
  useEffect(() => {
    if (ordered.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (inEditor(event.target)) return;
      if (event.key === "Escape") {
        clear();
      } else if (
        (event.key === "Delete" || event.key === "Backspace") &&
        onDelete !== undefined
      ) {
        event.preventDefault();
        onDelete(ordered);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ordered, onDelete, clear]);

  return useMemo(
    () => ({
      selected,
      has: (id: string) => selected.has(id),
      click,
      target,
      ordered,
      clear,
    }),
    [selected, click, target, ordered, clear],
  );
};
