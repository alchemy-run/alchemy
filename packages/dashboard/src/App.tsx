import { memo, type CSSProperties } from "react";
import {
  useConnection,
  useFilterCounts,
  useHydrated,
  useMeta,
  useView,
} from "./store.ts";
import { ActivityFeed } from "./ui/ActivityFeed.tsx";
import { ApprovalBanner } from "./ui/ApprovalBanner.tsx";
import { Canvas } from "./ui/Canvas.tsx";
import { Inspector } from "./ui/Inspector.tsx";
import { ListView } from "./ui/ListView.tsx";
import { TopBar } from "./ui/TopBar.tsx";
import { AnnotationsView } from "./views/Annotations.tsx";
import { SummaryView } from "./views/Summary.tsx";
import { TableView } from "./views/Table.tsx";
import { WaterfallView } from "./views/Waterfall.tsx";

/**
 * v2 shell. App itself subscribes ONLY to the hydration gate; everything
 * else (top bar, views, inspector, feed, approval) subscribes to its own
 * store slice, so live patches re-render exactly the affected leaves.
 * Data flows exclusively through store hooks — no scene objects, no
 * prop-drilled meta.
 */
export function App() {
  const hydrated = useHydrated();
  if (!hydrated) {
    return <BootScreen />;
  }
  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <ApprovalBanner />
        <ActivityFeed />
        <ViewHost />
        <Inspector />
      </div>
    </div>
  );
}

/** Pre-hydration gate: waiting for the first snapshot frame. */
function BootScreen() {
  const connection = useConnection();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      {connection.status === "error" ? (
        <>
          <p className="text-sm text-red-400">
            Cannot reach the dashboard server
          </p>
          <p className="mt-2 text-[12px] text-zinc-500">
            Is <code>alchemy dashboard</code> running? Retrying…
          </p>
        </>
      ) : (
        <p className="animate-pulse text-sm text-zinc-500">Loading stack…</p>
      )}
    </div>
  );
}

const CANVAS_VISIBLE: CSSProperties = { visibility: "visible" };
// visibility (not display) keeps React Flow's container measured, so
// returning to the canvas restores the exact viewport with zero jump
const CANVAS_HIDDEN: CSSProperties = { visibility: "hidden" };

/**
 * Main content area. The Canvas is ALWAYS mounted — other views render in
 * an overlay above it while it is CSS-hidden, so switching views never
 * unmounts React Flow state (positions/viewport survive by identity).
 */
const ViewHost = memo(function ViewHost() {
  const view = useView();
  return (
    <main className="relative min-w-0 flex-1">
      <div
        className="absolute inset-0"
        style={view === "canvas" ? CANVAS_VISIBLE : CANVAS_HIDDEN}
      >
        <Canvas />
      </div>
      {view === "canvas" && <CanvasEmptyState />}
      {view !== "canvas" && (
        <div className="absolute inset-0 z-10 overflow-y-auto bg-[#0b0b10]">
          {view === "summary" ? (
            <SummaryView />
          ) : view === "list" ? (
            <ListView />
          ) : view === "table" ? (
            <TableView />
          ) : view === "waterfall" ? (
            <WaterfallView />
          ) : (
            <AnnotationsView />
          )}
        </div>
      )}
    </main>
  );
});

/** Shown over the (empty) canvas when the document has no structure yet. */
const CanvasEmptyState = memo(function CanvasEmptyState() {
  const counts = useFilterCounts();
  const meta = useMeta();
  if (counts.total > 0) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
      <p className="animate-pulse text-sm text-zinc-500">
        Waiting for resources…
      </p>
      <p className="mt-2 text-[12px] text-zinc-600">
        {meta.stack}/{meta.stage}
      </p>
    </div>
  );
});
