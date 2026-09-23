import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const FLYCAST_API_PORT = 3000;
export const FLYCAST_BODY = "hello-over-flycast";

export const FlycastSite = Fly.App("FlycastSite");

/** Service published as plain HTTP on port 80, reachable over Flycast. */
export default class FlycastApi extends Fly.Service<FlycastApi>()(
  "FlycastApi",
  {
    app: FlycastSite,
    main: import.meta.url,
    region: "iad",
    port: FLYCAST_API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
    services: [
      {
        protocol: "tcp",
        internalPort: FLYCAST_API_PORT,
        ports: [{ port: 80, handlers: ["http"] }],
        autostart: true,
        autostop: "off",
      },
    ],
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text(FLYCAST_BODY)),
    };
  }),
) {}
