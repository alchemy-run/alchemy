import * as web3 from "@distilled.cloud/cloudflare/web3";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { fromEnv } from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

const show =
  (label: string) =>
  <A, E, R>(e: Effect.Effect<A, E, R>) =>
    e.pipe(
      Effect.match({
        onSuccess: (a) => console.log(label, "OK", JSON.stringify(a, null, 2)),
        onFailure: (err) =>
          console.log(
            label,
            "ERR",
            JSON.stringify(err, null, 2),
            (err as any)._tag,
          ),
      }),
    );

const main = Effect.gen(function* () {
  const zs = yield* zones.listZones({ name: "alchemy-test-2.us" });
  const zone = zs.result[0];
  if (!zone) throw new Error("zone not found");
  console.log("zoneId:", zone.id);

  yield* web3.listHostnames({ zoneId: zone.id }).pipe(show("list"));

  yield* web3
    .createHostname({
      zoneId: zone.id,
      name: "alchemy-web3-probe.alchemy-test-2.us",
      target: "ipfs",
      dnslink: "/ipns/onboarding.ipfs.cloudflare.com",
      description: "probe",
    })
    .pipe(show("create"));
});

main
  .pipe(
    Effect.provide(Layer.mergeAll(fromEnv(), FetchHttpClient.layer)),
    Effect.runPromise,
  )
  .catch((e) => console.error("FAILED", e));
