import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EuCustomers } from "./src/Governance.ts";

export default Alchemy.Stack(
  "StarburstGalaxyGovernanceExample",
  {
    providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { crm, pii, euOnly, hashed, analysts, policy } = yield* EuCustomers;
    return {
      catalogId: crm.catalogId,
      tagId: pii.tagId,
      rowFilterId: euOnly.rowFilterId,
      columnMaskId: hashed.columnMaskId,
      roleId: analysts.roleId,
      policyId: policy.policyId,
    };
  }),
);
