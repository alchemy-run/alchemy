import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** CloudNumberRegistry resources the generated bindings bind, mirroring each resource suite's smallest shape. */
export const ProbeRegistryBook = GCP.CloudNumberRegistry.RegistryBook("ProbeRegistryBook", {
  location: "global",
});
export const ProbeRealm = Effect.gen(function* () {
  const book = yield* ProbeRegistryBook;
  return yield* GCP.CloudNumberRegistry.Realm("ProbeRealm", {
    location: "global",
    registryBook: book.name,
    trafficType: "PRIVATE",
    managementType: "USER",
    ipVersion: "IPV4",
  });
});
export const ProbeCustomRange = Effect.gen(function* () {
  const realm = yield* ProbeRealm;
  return yield* GCP.CloudNumberRegistry.CustomRange("ProbeCustomRange", {
    location: "global",
    realm: realm.name,
    ipv4CidrRange: "10.251.0.0/22",
  });
});
