import type { UIRegistry } from "alchemy/UI/UIProvider";
import { useEffect, useMemo, useState } from "react";
import { fetchGraph, fetchMeta, fetchPlan } from "./api.ts";
import { mergePlan } from "./plan.ts";
import { loadRegistry } from "./registry.ts";
import type { DashboardGraph, DashboardMeta, DashboardPlan } from "./types.ts";
import { Canvas } from "./ui/Canvas.tsx";
import { Inspector } from "./ui/Inspector.tsx";
import { ListView } from "./ui/ListView.tsx";
import { TopBar, type View } from "./ui/TopBar.tsx";

export function App() {
  const [meta, setMeta] = useState<DashboardMeta>();
  const [graph, setGraph] = useState<DashboardGraph>();
  const [plan, setPlan] = useState<DashboardPlan>();
  const [registry, setRegistry] = useState<UIRegistry>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<View>("canvas");
  const [query, setQuery] = useState("");

  useEffect(() => {
    Promise.all([fetchMeta(), fetchGraph(), loadRegistry()])
      .then(([meta, graph, registry]) => {
        setMeta(meta);
        setGraph(graph);
        setRegistry(registry);
      })
      .catch((e) => setError(String(e)));
    // the plan can take a while (it diffs the whole stack) and can be
    // unavailable (no credentials) — load it independently, best-effort
    fetchPlan()
      .then(setPlan)
      .catch(() => undefined);
  }, []);

  const merged = useMemo(
    () => (graph ? mergePlan(graph, plan) : undefined),
    [graph, plan],
  );

  const filtered = useMemo(() => {
    if (!merged) {
      return undefined;
    }
    if (!query.trim()) {
      return merged;
    }
    const q = query.toLowerCase();
    const nodes = merged.nodes.filter(
      (n) =>
        n.fqn.toLowerCase().includes(q) || n.type.toLowerCase().includes(q),
    );
    const keep = new Set(nodes.map((n) => n.fqn));
    return {
      nodes,
      edges: merged.edges.filter(
        (e) => keep.has(e.source) && keep.has(e.target),
      ),
    };
  }, [merged, query]);

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
  if (!meta || !filtered || !registry) {
    return (
      <Center>
        <p className="text-sm text-zinc-500">Loading stack…</p>
      </Center>
    );
  }

  const selectedNode = filtered.nodes.find((n) => n.fqn === selected);

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        meta={meta}
        plan={plan}
        view={view}
        onView={setView}
        query={query}
        onQuery={setQuery}
      />
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          {filtered.nodes.length === 0 ? (
            <Center>
              <p className="text-sm text-zinc-500">
                No resources in {meta.stack}/{meta.stage}
              </p>
              <p className="mt-2 text-[12px] text-zinc-600">
                Deploy the stack first: <code>bun alchemy deploy</code>
              </p>
            </Center>
          ) : view === "canvas" ? (
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
