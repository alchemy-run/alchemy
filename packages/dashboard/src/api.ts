import type { DashboardGraph, DashboardMeta, DashboardPlan } from "./types.ts";

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
};

export const fetchMeta = () => get<DashboardMeta>("/api/meta");

export const fetchGraph = (stage?: string) =>
  get<DashboardGraph>(
    stage ? `/api/graph?stage=${encodeURIComponent(stage)}` : "/api/graph",
  );

export const fetchPlan = () => get<DashboardPlan>("/api/plan");

export const fetchOutputs = (stage?: string) =>
  get<unknown>(
    stage ? `/api/outputs?stage=${encodeURIComponent(stage)}` : "/api/outputs",
  );
