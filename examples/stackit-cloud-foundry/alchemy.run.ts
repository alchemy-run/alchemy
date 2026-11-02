import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Stage } from "./src/deployer.ts";
import { Web } from "./src/resources.ts";

export default Alchemy.Stack(
  "StackitCloudFoundryExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const web = yield* Web;
    const api = yield* Api;

    return {
      url: api.url,
      webUrl: web.url,
      projectId: stage.organization.projectId,
      region: stage.organization.region,
      organizationId: stage.organization.organizationId,
      spaceId: stage.space.spaceId,
    };
  }),
);
