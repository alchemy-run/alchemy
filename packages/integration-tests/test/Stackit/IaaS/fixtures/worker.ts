import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The newest public Ubuntu image of the region, resolved at plan. */
const ubuntuImage = Output.fromEffect(
  Effect.gen(function* () {
    const { projectId, region } = yield* Stackit.StackitEnvironment.current;
    const { items } = yield* iaas.listImages({ projectId, region, all: true });
    return items
      .filter((image) => image.scope === "public" && /ubuntu/i.test(image.name) && image.id)
      .sort((a, b) => b.name.localeCompare(a.name))[0]!.id!;
  }).pipe(Effect.orDie),
);

export const Network = Stackit.IaaS.Network("IaasBindingsNetwork", {
  ipv4: { prefix: "10.231.47.0/24" },
});

export const Nic = Network.pipe(
  Effect.flatMap((network) =>
    Stackit.IaaS.NetworkInterface("IaasBindingsNic", { networkId: network.networkId }),
  ),
);

/** No `networkInterfaceId`: the association belongs to the binding. */
export const Address = Stackit.IaaS.PublicIp("IaasBindingsAddress", {});

export const Web = Network.pipe(
  Effect.flatMap((network) =>
    Stackit.IaaS.Server("IaasBindingsServer", {
      machineType: "g1.1",
      bootVolume: {
        size: 10,
        source: { type: "image", id: ubuntuImage },
        deleteOnTermination: true,
      },
      networking: { networkId: network.networkId },
    }),
  ),
);

/** An unattached volume, since restoring needs the volume detached. */
export const Data = Stackit.IaaS.Volume("IaasBindingsVolume", { size: 1 });

export const DataBackup = Data.pipe(
  Effect.flatMap((volume) =>
    Stackit.IaaS.Backup("IaasBindingsBackup", {
      source: { type: "volume", id: volume.volumeId },
    }),
  ),
);

/**
 * A Cloudflare Worker using the IaaS bindings. STACKIT has no native host yet, so
 * the bindings grant on the service account Alchemy creates for the Worker. One
 * route per binding; each answers `{ ok, result | error }` so a failure surfaces
 * the STACKIT error in the test.
 */
export default class IaasBindingsWorker extends Cloudflare.Worker<IaasBindingsWorker>()(
  "StackitIaasBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const server = yield* Web;
    const reboot = yield* Stackit.IaaS.RebootServer(server);
    const rescue = yield* Stackit.IaaS.RescueServer(server);
    const unrescue = yield* Stackit.IaaS.UnrescueServer(server);
    const getConsole = yield* Stackit.IaaS.GetServerConsole(server);
    const getLog = yield* Stackit.IaaS.GetServerLog(server);
    const restore = yield* Stackit.IaaS.RestoreBackup(yield* DataBackup);
    const associate = yield* Stackit.IaaS.AssociatePublicIp(yield* Address);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/reboot":
            return yield* respond(reboot({ action: "soft" }));
          case "/rescue":
            return yield* respond(rescue({ image: param("image") }));
          case "/unrescue":
            return yield* respond(unrescue());
          case "/console":
            return yield* respond(getConsole());
          case "/log":
            return yield* respond(getLog({ length: 100 }));
          case "/restore":
            return yield* respond(restore());
          case "/associate":
            return yield* respond(associate({ networkInterface: param("nic") || null }));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.IaaS.RebootServerHttp,
        Stackit.IaaS.RescueServerHttp,
        Stackit.IaaS.UnrescueServerHttp,
        Stackit.IaaS.GetServerConsoleHttp,
        Stackit.IaaS.GetServerLogHttp,
        Stackit.IaaS.RestoreBackupHttp,
        Stackit.IaaS.AssociatePublicIpHttp,
      ),
    ),
  ),
) {}
