import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AnalyticsBlob,
  AnalyticsPoint,
  AnalyticsEngineServiceProps,
} from "./AnalyticsEngineOptions.shared.ts";
interface Env {
  OBJECT: DurableObjectNamespace<AnalyticsEngineObject>;
}
export default class extends WorkerEntrypoint<
  Env,
  AnalyticsEngineServiceProps
> {
  async fetch(request: Request) {
    const headers = new Headers(request.headers);
    headers.set("X-Analytics-Dataset", this.ctx.props.dataset);
    return this.env.OBJECT.getByName(this.ctx.props.dataset).fetch(
      new Request(request, { headers }),
    );
  }
}
const sqlValue = (value: AnalyticsBlob | undefined) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return Uint8Array.from(atob(value.base64), (c) => c.charCodeAt(0)).buffer;
};
const jsonValue = (value: unknown) =>
  value instanceof ArrayBuffer
    ? { base64: btoa(String.fromCharCode(...new Uint8Array(value))) }
    : value;
const columns = [
  "timestamp",
  "_sample_interval",
  "index1",
  ...Array.from({ length: 20 }, (_, i) => `blob${i + 1}`),
  ...Array.from({ length: 20 }, (_, i) => `double${i + 1}`),
];

export class AnalyticsEngineObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, timestamp INTEGER NOT NULL, _sample_interval INTEGER NOT NULL, index1 BLOB, ${Array.from({ length: 20 }, (_, i) => `blob${i + 1} BLOB`).join(",")}, ${Array.from({ length: 20 }, (_, i) => `double${i + 1} REAL`).join(",")})`,
    );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const sql = this.ctx.storage.sql;
      // Keep the documented three-month retention as a rolling 92-day local
      // approximation; production retention is controlled by the service.
      sql.exec(
        "DELETE FROM events WHERE timestamp < ?",
        Math.floor(Date.now() / 1000) - 92 * 86400,
      );
      if (url.pathname === "/points" && request.method === "POST") {
        const points = await request.json<AnalyticsPoint[]>();
        this.ctx.storage.transactionSync(() => {
          for (const point of points) {
            const values = [
              Math.floor(Date.now() / 1000),
              1,
              sqlValue(point.indexes[0]),
              ...Array.from({ length: 20 }, (_, i) => sqlValue(point.blobs[i])),
              ...Array.from({ length: 20 }, (_, i) => point.doubles[i] ?? 0),
            ];
            sql.exec(
              `INSERT INTO events (payload, ${columns.join(",")}) VALUES (${Array.from({ length: values.length + 1 }, () => "?").join(",")})`,
              JSON.stringify(point),
              ...values,
            );
          }
        });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/points") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const after = Number(url.searchParams.get("after") ?? 0);
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 1000 ||
          !Number.isInteger(after) ||
          after < 0
        )
          throw new Error("Invalid analytics inspection limit/cursor");
        const rows = sql
          .exec<{ sequence: number; timestamp: number; payload: string }>(
            "SELECT sequence, timestamp, payload FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?",
            after,
            limit,
          )
          .toArray();
        const data = rows.map(({ payload, ...row }) => ({
          ...JSON.parse(payload),
          ...row,
        }));
        return Response.json({
          data,
          ...(rows.length ? { cursor: rows.at(-1)!.sequence } : {}),
        });
      }
      if (url.pathname === "/query") {
        const query = (await request.text()).trim().replace(/;$/, "");
        if (!/^SELECT\s/i.test(query) || query.includes(";"))
          throw new Error(
            "Local Analytics Engine supports one SELECT statement",
          );
        const dataset = request.headers.get("X-Analytics-Dataset")!;
        if (dataset !== "events")
          sql.exec(
            `CREATE VIEW IF NOT EXISTS "${dataset.replaceAll('"', '""')}" AS SELECT ${columns.join(",")} FROM events`,
          );
        const rows = sql.exec(`SELECT * FROM (${query}) LIMIT 1000`).toArray();
        const data = rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, jsonValue(v)]),
          ),
        );
        return Response.json({ data, rows: data.length });
      }
      return new Response("Unknown analytics inspection operation", {
        status: 404,
      });
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : String(error),
        { status: 400 },
      );
    }
  }
}
