import type { UIRegistry } from "alchemy/UI/UIProvider";
import { useEffect, useMemo, useState } from "react";
import { loadRegistry } from "./registry.ts";
import { useScene } from "./scene.ts";
import type { DashboardMeta } from "./types.ts";
import { ActivityFeed } from "./ui/ActivityFeed.tsx";
import { ApprovalBanner } from "./ui/ApprovalBanner.tsx";
import { Canvas } from "./ui/Canvas.tsx";
import { Inspector } from "./ui/Inspector.tsx";
import { ListView } from "./ui/ListView.tsx";
import { TopBar, type View } from "./ui/TopBar.tsx";

export function App() {
  const [stageOverride, setStageOverride] = useState<string>();
  const [registry, setRegistry] = useState<UIRegistry>();
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<View>("canvas");
  const [query, setQuery] = useState("");
  const [dismissedSession, setDismissedSession] = useState<string>();

  const { scene, error, decide } = useScene(stageOverride);

  useEffect(() => {
    loadRegistry()
      .then(setRegistry)
      .catch(() => undefined);
  }, []);

  const filtered = useMemo(() => {
    if (!scene) {
      return undefined;
    }
    if (!query.trim()) {
      return { nodes: scene.nodes, edges: scene.edges };
    }
    const q = query.toLowerCase();
    const nodes = scene.nodes.filter(
      (n) =>
        n.fqn.toLowerCase().includes(q) || n.type.toLowerCase().includes(q),
    );
    const keep = new Set(nodes.map((n) => n.fqn));
    return {
      nodes,
      edges: scene.edges.filter(
        (e) => keep.has(e.source) && keep.has(e.target),
      ),
    };
  }, [scene, query]);

  if (error) {
    return (
      <Center>
        <p className="text-sm text-red-400">Failed to load: {error}</p>
        <p className="mt-2 text-[12px] text-zinc-500">
          Is <code>alchemy dashboard</code> running?
        </p>
      </Center>
    );
  }
  if (!scene || !filtered || !registry) {
    return (
      <Center>
        <p className="text-sm text-zinc-500">Loading stack…</p>
      </Center>
    );
  }

  const meta: DashboardMeta = {
    stack: scene.stack,
    stage: scene.stage,
    stages: scene.stages,
  };
  const selectedNode = filtered.nodes.find((n) => n.fqn === selected);
  const session =
    scene.session && scene.session.id !== dismissedSession
      ? scene.session
      : null;

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        meta={meta}
        stage={scene.stage}
        onStage={setStageOverride}
        nodes={scene.nodes}
        planReady={scene.planReady}
        view={view}
        onView={setView}
        query={query}
        onQuery={setQuery}
        shown={filtered.nodes.length}
        total={scene.nodes.length}
      />
      <div className="relative flex min-h-0 flex-1">
        {scene.approval && (
          <ApprovalBanner
            nodes={scene.nodes}
            onDecide={(approved) => decide(scene.approval!.id, approved)}
          />
        )}
        {session && (
          <ActivityFeed
            session={session}
            onDismiss={() => setDismissedSession(session.id)}
          />
        )}
        <main className="relative min-w-0 flex-1">
          {/* keep the canvas mounted even when the node list is transiently
              empty — unmount/remount pops the whole scene in and out */}
          {view === "canvas" ? (
            <Canvas
              graph={filtered}
              registry={registry}
              meta={meta}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            <ListView
              nodes={filtered.nodes}
              registry={registry}
              meta={meta}
              selected={selected}
              onSelect={setSelected}
            />
          )}
          {filtered.nodes.length === 0 &&
            (scene.planReady ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <p className="text-sm text-zinc-500">
                  This stack defines no resources
                </p>
                <p className="mt-2 text-[12px] text-zinc-600">
                  {scene.stack}/{scene.stage}
                </p>
              </div>
            ) : (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <p className="animate-pulse text-sm text-zinc-500">
                  Evaluating stack…
                </p>
                <p className="mt-2 text-[12px] text-zinc-600">
                  {scene.stack}/{scene.stage}
                </p>
              </div>
            ))}
        </main>
        {selectedNode && (
          <Inspector
            node={selectedNode}
            registry={registry}
            meta={meta}
            onClose={() => setSelected(undefined)}
          />
        )}
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      {children}
    </div>
  );
}
