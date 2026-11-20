import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../Utils/Telemetry.ts";

/** Published host port; distinct from the other platform fixtures'. */
export const TRACED_EXTERNAL_PORT = 43118;

/** A swarm service program that exports one span per `/work` request over OTLP. */
export default class TracedService extends Docker.Service<TracedService>()(
  "DockerTracedService",
  {
    main: import.meta.filename,
    port: 3000,
    ports: [{ external: TRACED_EXTERNAL_PORT, internal: 3000 }],
    replicas: 1,
  },
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("docker-service-e2e")),
  ),
) {}
