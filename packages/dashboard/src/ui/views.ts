import type { ViewKind } from "../store.ts";

/**
 * The three views, in tab order. Internal keys keep their historical names
 * ("canvas", "summary") — only the labels are user-facing.
 */
export const VIEW_ORDER: readonly ViewKind[] = ["summary", "list", "canvas"];

export const VIEW_LABELS: Record<ViewKind, string> = {
  summary: "Status",
  list: "List",
  canvas: "Graph",
};
