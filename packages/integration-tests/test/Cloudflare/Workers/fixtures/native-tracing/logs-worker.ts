import * as Cloudflare from "@alchemy.run/cloudflare";
import type { CloudflareTelemetryProps } from "@alchemy.run/cloudflare/Workers/Telemetry";
import type { WorkerProps } from "@alchemy.run/cloudflare/Workers/Worker";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Live-test Worker whose Workers Logs settings come from
 * `Cloudflare.Telemetry({ logs })`. The runtime half doesn't read the
 * options, so every instance shares this module.
 */
export const makeLogsWorker = (
  id: string,
  telemetry: CloudflareTelemetryProps = {},
  props: Partial<WorkerProps> = {},
) =>
  Cloudflare.Worker(
    id,
    {
      ...props,
      main: import.meta.url,
      compatibility: { date: "2026-08-25" },
    },
    Effect.succeed({
      fetch: Effect.succeed(HttpServerResponse.text("logs-ok")),
    }).pipe(Effect.provide(Cloudflare.Telemetry(telemetry))),
  );

export default makeLogsWorker("NativeTracingLogs");
