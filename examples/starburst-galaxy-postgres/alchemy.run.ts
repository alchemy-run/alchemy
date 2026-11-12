import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Reporting } from "./src/Reporting.ts";

export default Alchemy.Stack(
  "StarburstGalaxyPostgresExample",
  {
    providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { shop, cluster, reporting, reporter } = yield* Reporting;
    return {
      catalogId: shop.catalogId,
      catalog: shop.name,
      clusterId: cluster.clusterId,
      trinoUri: cluster.trinoUri,
      roleId: reporting.roleId,
      // Log in with this user name and the password's `trinoPassword`.
      userName: reporter.userName,
    };
  }),
);
