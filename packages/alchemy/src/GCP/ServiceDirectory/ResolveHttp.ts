import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Resolve, type ResolveRequest } from "./Resolve.ts";
import type { Service } from "./Service.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link Resolve}.
 *
 * @layer
 * @provides GCP.ServiceDirectory.Resolve
 */
export const ResolveHttp = Layer.effect(
  Resolve,
  Effect.gen(function* () {
    const resolveProjectsLocationsNamespacesServices =
      yield* servicedirectory.resolveProjectsLocationsNamespacesServices;
    return Effect.fn(function* <S extends Service>(service: S) {
      yield* bindGcpHost({
        tag: "GCP.ServiceDirectory.Resolve",
        resource: service,
        iam: [{ role: defaultRoleFor("GCP.ServiceDirectory.Resolve") }],
      });
      const name = yield* service.name;
      return Effect.fn(`GCP.ServiceDirectory.Resolve(${service.LogicalId})`)(
        function* (request?: ResolveRequest) {
          return yield* resolveProjectsLocationsNamespacesServices({
            ...request,
            name: yield* name,
          });
        },
      );
    });
  }),
);
