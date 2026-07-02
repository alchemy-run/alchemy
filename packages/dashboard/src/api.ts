import type { DashboardGraph, DashboardMeta, DashboardPlan } from "./types.ts";

/**
 * Fetch with retries: while a deploy runs in the serving process, requests
 * can transiently stall or get reset — never take the whole app down over
 * one dropped request.
 */
const get = async <T>(path: string, attempts = 4): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(path);
      if (!res.ok) {
        throw new Error(`${path} -> ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (error) {
      if (attempt >= attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
  }
};

export const fetchMeta = () => get<DashboardMeta>("/api/meta");

export const fetchGraph = (stage?: string) =>
  get<DashboardGraph>(
    stage ? `/api/graph?stage=${encodeURIComponent(stage)}` : "/api/graph",
  );

export const fetchPlan = (stage?: string) =>
  get<DashboardPlan>(
    stage ? `/api/plan?stage=${encodeURIComponent(stage)}` : "/api/plan",
  );

export const fetchOutputs = (stage?: string) =>
  get<unknown>(
    stage ? `/api/outputs?stage=${encodeURIComponent(stage)}` : "/api/outputs",
  );
