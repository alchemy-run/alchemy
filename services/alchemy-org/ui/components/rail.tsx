/**
 * The RAIL — a side column: the agent's chat beside a Work item or the
 * Triage page (on the right), the sidebar of items or sessions (on the
 * left). Resizable by dragging its inner edge; each rail's width is one
 * remembered setting keyed by its `storageKey`, so every rail of a kind
 * opens at the size the user last chose. Double-click the edge to go
 * back to the default.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const RAIL_DEFAULT_WIDTH = 440;
/** Never wider than this share of the window — the page must stay usable. */
const MAX_SHARE = 0.6;

interface Bounds {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
}

const clamp = (width: number, { minWidth }: Bounds) =>
  Math.round(
    Math.min(
      Math.max(width, minWidth),
      Math.max(minWidth, window.innerWidth * MAX_SHARE),
    ),
  );

const readWidth = (bounds: Bounds): number => {
  try {
    const raw = localStorage.getItem(bounds.storageKey);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed)
      ? clamp(parsed, bounds)
      : bounds.defaultWidth;
  } catch {
    return bounds.defaultWidth;
  }
};

/** The rail width, shared across every rail with this key and remembered. */
const useRailWidth = (bounds: Bounds): [number, (next: number) => void] => {
  const [width, setWidth] = useState<number>(() => readWidth(bounds));
  const { storageKey, defaultWidth, minWidth } = bounds;
  useEffect(() => {
    // another rail (or tab) changed it — follow
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) {
        setWidth(readWidth({ storageKey, defaultWidth, minWidth }));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey, defaultWidth, minWidth]);
  const update = (next: number) => {
    const clamped = clamp(next, bounds);
    setWidth(clamped);
    try {
      localStorage.setItem(bounds.storageKey, String(clamped));
    } catch {
      // storage disabled — the width still applies, unremembered
    }
  };
  return [width, update];
};

export const Rail = ({
  label,
  side = "right",
  storageKey = "rail-width",
  defaultWidth = RAIL_DEFAULT_WIDTH,
  minWidth = 320,
  children,
  className,
}: {
  /** The accessible name — "Steward", "Triage agent", "Sidebar". */
  label: string;
  /** Which edge of the page it hangs on; the grab edge is the other one. */
  side?: "left" | "right";
  storageKey?: string;
  defaultWidth?: number;
  minWidth?: number;
  children: ReactNode;
  className?: string;
}) => {
  const bounds: Bounds = { storageKey, defaultWidth, minWidth };
  const [width, setWidth] = useRailWidth(bounds);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | undefined>(
    undefined,
  );
  return (
    <aside
      aria-label={label}
      style={{ width }}
      className={cn(
        "relative flex shrink-0 flex-col bg-sidebar",
        side === "right" ? "border-l border-border" : "border-r border-border",
        className,
      )}
    >
      {/* the grab edge: a thin strip over the border, wider hit area */}
      <div
        role="separator"
        aria-label={`Resize the ${label} rail`}
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={minWidth}
        title="Drag to resize · double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { startX: event.clientX, startWidth: width };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (state === undefined) return;
          const delta = event.clientX - state.startX;
          // on the right, dragging left widens; on the left, dragging right
          setWidth(state.startWidth + (side === "right" ? -delta : delta));
        }}
        onPointerUp={(event) => {
          drag.current = undefined;
          setDragging(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          setDragging(false);
        }}
        onDoubleClick={() => setWidth(defaultWidth)}
        className={cn(
          "absolute top-0 bottom-0 z-10 w-2 cursor-col-resize select-none",
          "after:absolute after:top-0 after:bottom-0 after:w-px after:bg-transparent after:transition-colors",
          side === "right" ? "-left-1 after:left-1" : "-right-1 after:right-1",
          "hover:after:bg-primary/60",
          dragging && "after:bg-primary",
        )}
      />
      {children}
    </aside>
  );
};
