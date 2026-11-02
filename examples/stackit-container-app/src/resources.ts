import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { Apps } from "./registry.ts";

/** The zone the API reads through a binding. */
export const Domain = Stackit.DNS.Zone("Domain", {});

/** A public image, with no build: one instance of nginx. */
export const Web = Effect.gen(function* () {
  const apps = yield* Apps;
  return yield* Stackit.ContainerApplications.Application("Web", {
    environmentId: apps.environmentId,
    image: "nginxinc/nginx-unprivileged",
    scaling: { type: "manual", instances: 1 },
  });
});
