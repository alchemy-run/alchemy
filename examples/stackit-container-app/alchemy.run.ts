import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Domain, Web } from "./src/resources.ts";

export default Alchemy.Stack(
  "StackitContainerAppExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const domain = yield* Domain;
    const web = yield* Web;
    const api = yield* Api;

    return {
      url: api.url,
      webUrl: web.url,
      projectId: api.projectId,
      region: api.region,
      environmentId: api.environmentId,
      apiId: api.applicationId,
      webId: web.applicationId,
      zoneId: domain.zoneId,
    };
  }),
);
