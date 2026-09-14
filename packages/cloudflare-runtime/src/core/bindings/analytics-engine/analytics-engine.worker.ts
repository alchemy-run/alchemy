// Extension modules can import only internal built-ins. This is the same
// request-lifetime primitive exported publicly by cloudflare:workers.
// @ts-expect-error workerd internal module is intentionally not public types
import entrypoints from "cloudflare-internal:workers";
import type {
  AnalyticsBlob,
  AnalyticsPoint,
  LocalAnalyticsEngineInspector,
} from "./AnalyticsEngineOptions.shared.ts";
interface Env {
  dataset: string;
  store: Fetcher;
}
const encoder = new TextEncoder();
const bytes = (value: string | ArrayBuffer | null): number =>
  value === null
    ? 0
    : typeof value === "string"
      ? encoder.encode(value).length
      : value.byteLength;
const encodeBlob = (value: string | ArrayBuffer | null): AnalyticsBlob => {
  if (value === null || typeof value === "string") return value;
  if (!(value instanceof ArrayBuffer))
    throw new TypeError(
      "Analytics Engine blobs and indexes must be strings, ArrayBuffers or null",
    );
  return { base64: btoa(String.fromCharCode(...new Uint8Array(value))) };
};
function normalize(event: AnalyticsEngineDataPoint = {}): AnalyticsPoint {
  const { blobs = [], doubles = [], indexes = [] } = event;
  if (!Array.isArray(blobs) || blobs.length > 20)
    throw new Error("Analytics Engine accepts at most 20 blobs");
  if (
    !Array.isArray(doubles) ||
    doubles.length > 20 ||
    doubles.some((n) => typeof n !== "number" || !Number.isFinite(n))
  )
    throw new Error("Analytics Engine accepts at most 20 finite doubles");
  if (!Array.isArray(indexes) || indexes.length > 1)
    throw new Error("Analytics Engine accepts at most one index");
  const normalized = {
    blobs: blobs.map(encodeBlob),
    indexes: indexes.map(encodeBlob),
    doubles: [...doubles],
  };
  if (blobs.reduce((sum, blob) => sum + bytes(blob), 0) > 16384)
    throw new Error("Analytics Engine blobs exceed 16 KiB");
  if (indexes.some((index) => bytes(index) > 96))
    throw new Error("Analytics Engine index exceeds 96 bytes");
  return normalized;
}

class LocalAnalyticsEngineDataset
  implements AnalyticsEngineDataset, LocalAnalyticsEngineInspector
{
  private pending = new Set<Promise<void>>();
  constructor(private env: Env) {}
  writeDataPoint(event?: AnalyticsEngineDataPoint): void {
    const point = normalize(event);
    const write = this.env.store
      .fetch("http://analytics/points", {
        method: "POST",
        body: JSON.stringify([point]),
      })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `Local Analytics Engine write failed: ${await response.text()}`,
          );
        await response.arrayBuffer();
      });
    this.pending.add(write);
    entrypoints.waitUntil(write.finally(() => this.pending.delete(write)));
  }
  async getDataPoints(options: { limit?: number; after?: number } = {}) {
    await Promise.all(this.pending);
    const response = await this.env.store.fetch(
      `http://analytics/points?limit=${options.limit ?? 100}&after=${options.after ?? 0}`,
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json<
      Awaited<ReturnType<LocalAnalyticsEngineInspector["getDataPoints"]>>
    >();
  }
  async query(sql: string) {
    await Promise.all(this.pending);
    const response = await this.env.store.fetch("http://analytics/query", {
      method: "POST",
      body: sql,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json<
      Awaited<ReturnType<LocalAnalyticsEngineInspector["query"]>>
    >();
  }
}

export default function makeBinding(
  env: Env,
): AnalyticsEngineDataset & LocalAnalyticsEngineInspector {
  return new LocalAnalyticsEngineDataset(env);
}
