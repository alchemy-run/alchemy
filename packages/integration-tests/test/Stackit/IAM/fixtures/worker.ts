import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The account the bindings read: its project is the scope, its keys the data. */
export const Subject = Stackit.IAM.ServiceAccount("IamBindingsSubject", {});

/** The custom role `GetRole` reads. */
export const InspectedRole = Stackit.IAM.CustomRole("IamBindingsInspectedRole", {
  description: "Alchemy IAM bindings test role",
  permissions: ["iam.role.get"],
});

/**
 * A Cloudflare Worker using the IAM bindings. STACKIT has no native host yet, so
 * the bindings grant on the service account Alchemy creates for the Worker. One
 * route per binding; each answers `{ ok, result | error }` so a failure surfaces
 * the STACKIT error in the test.
 */
export default class IamBindingsWorker extends Cloudflare.Worker<IamBindingsWorker>()(
  "StackitIamBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const subject = yield* Subject;
    const scope = { resourceType: "project", resourceId: subject.projectId } as const;

    const listMembers = yield* Stackit.IAM.ListMembers(scope);
    const listRoles = yield* Stackit.IAM.ListRoles(scope);
    const getRole = yield* Stackit.IAM.GetRole(yield* InspectedRole);
    const listPermissions = yield* Stackit.IAM.ListPermissions();
    const listUserMemberships = yield* Stackit.IAM.ListUserMemberships(scope);
    const listUserPermissions = yield* Stackit.IAM.ListUserPermissions(scope);
    const getJWKS = yield* Stackit.IAM.GetJWKS(subject);
    const listKeys = yield* Stackit.IAM.ListServiceAccountKeys(subject);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const email = url.searchParams.get("email") ?? "";
        switch (url.pathname) {
          case "/members":
            return yield* respond(listMembers({ subject: email }));
          case "/roles":
            return yield* respond(listRoles());
          case "/role":
            return yield* respond(getRole());
          case "/permissions":
            return yield* respond(listPermissions({ resourceType: "project" }));
          case "/user-memberships":
            return yield* respond(listUserMemberships({ email }));
          case "/user-permissions":
            return yield* respond(
              listUserPermissions({
                email,
                permissions: url.searchParams.getAll("permission"),
              }),
            );
          case "/jwks":
            return yield* respond(getJWKS());
          case "/keys":
            return yield* respond(listKeys());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.IAM.ListMembersHttp,
        Stackit.IAM.ListRolesHttp,
        Stackit.IAM.GetRoleHttp,
        Stackit.IAM.ListPermissionsHttp,
        Stackit.IAM.ListUserMembershipsHttp,
        Stackit.IAM.ListUserPermissionsHttp,
        Stackit.IAM.GetJWKSHttp,
        Stackit.IAM.ListServiceAccountKeysHttp,
      ),
    ),
  ),
) {}
