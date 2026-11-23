import * as Archil from "@alchemy.run/archil";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import * as E2B from "@alchemy.run/e2b";
import * as Modal from "@alchemy.run/modal";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "CloudflarePi",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      // One per sandbox platform a workspace runs on.
      E2B.providers(),
      Daytona.providers(),
      Boat.providers(),
      Archil.providers(),
      Modal.providers(),
      // The Worker acts with your Modal token, which works on every plan. On
      // a Team or Enterprise workspace, drop Modal.DeployerHostIdentity to
      // give it its own scoped service user instead.
      Modal.DeployerHostIdentity,
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
