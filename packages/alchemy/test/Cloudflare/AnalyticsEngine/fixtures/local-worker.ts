/// <reference types="@cloudflare/workers-types" />
import type { LocalAnalyticsEngineInspector } from "@alchemy.run/cloudflare-runtime/core/bindings/analytics-engine";
export default {
  async fetch(
    request: Request,
    env: {
      EVENTS: AnalyticsEngineDataset & LocalAnalyticsEngineInspector;
      REVISION: string;
    },
  ) {
    const path = new URL(request.url).pathname;
    if (path === "/revision") return new Response(env.REVISION);
    if (path === "/write") {
      env.EVENTS.writeDataPoint({
        indexes: ["tenant"],
        blobs: ["signup", new Uint8Array([0, 255]).buffer],
        doubles: [3],
      });
      env.EVENTS.writeDataPoint({
        indexes: ["tenant"],
        blobs: ["purchase"],
        doubles: [7],
      });
      return Response.json(
        await env.EVENTS.query(
          "SELECT count() AS count, sum(double1) AS total FROM local_analytics_fixture",
        ),
      );
    }
    if (path === "/invalid") {
      let rejected = 0;
      for (const event of [
        { blobs: Array(21).fill("x") },
        { doubles: [NaN] },
        { indexes: ["x".repeat(97)] },
        { blobs: ["x".repeat(16385)] },
      ]) {
        try {
          env.EVENTS.writeDataPoint(event);
        } catch {
          rejected++;
        }
      }
      return Response.json({ rejected });
    }
    if (path === "/points")
      return Response.json(await env.EVENTS.getDataPoints({ limit: 1 }));
    return Response.json(
      await env.EVENTS.query(
        "SELECT count() AS count, sum(double1) AS total FROM local_analytics_fixture",
      ),
    );
  },
};
