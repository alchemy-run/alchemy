import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeEnvironmentHttpBinding } from "./BindingHttp.ts";
import { ListEnvironmentSecrets } from "./ListEnvironmentSecrets.ts";

/**
 * HTTP implementation of {@link ListEnvironmentSecrets}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.ListEnvironmentSecrets
 */
export const ListEnvironmentSecretsHttp = Layer.effect(
  ListEnvironmentSecrets,
  makeEnvironmentHttpBinding({
    tag: "Stackit.ContainerApplications.ListEnvironmentSecrets",
    permissions: ["sca.environment.secret.list"],
    operation: sca.listEnvironmentSecrets,
  }),
);
