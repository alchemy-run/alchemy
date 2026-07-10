import * as AWS from "@/AWS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class VerifiedPermissionsTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "VerifiedPermissionsTestFunction",
) {}

export default VerifiedPermissionsTestFunction.make(
  {
    main,
    url: true,
    // isAuthorized fans out an AVP API call; the 3s default is too tight
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const store = yield* AWS.VerifiedPermissions.PolicyStore("Store", {
      validationMode: "OFF",
    });
    // permit only alice to view photos
    yield* AWS.VerifiedPermissions.Policy("AllowAlice", {
      policyStoreId: store.policyStoreId,
      statement: `permit(
        principal == PhotoApp::User::"alice",
        action == PhotoApp::Action::"viewPhoto",
        resource
      );`,
    });

    const authz = yield* AWS.VerifiedPermissions.IsAuthorized(store);
    const PolicyStoreId = yield* store.policyStoreId;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/info") {
          const policyStoreId = yield* PolicyStoreId;
          return yield* HttpServerResponse.json({ policyStoreId });
        }

        // /authorize?user=alice -> ALLOW, any other user -> DENY
        if (request.method === "GET" && pathname === "/authorize") {
          const user = url.searchParams.get("user") ?? "alice";
          const result = yield* authz.isAuthorized({
            principal: { entityType: "PhotoApp::User", entityId: user },
            action: {
              actionType: "PhotoApp::Action",
              actionId: "viewPhoto",
            },
            resource: {
              entityType: "PhotoApp::Photo",
              entityId: "vacation.jpg",
            },
          });
          return yield* HttpServerResponse.json({
            decision: result.decision,
          });
        }

        // /batch -> two decisions for one resource, alice + bob
        if (request.method === "GET" && pathname === "/batch") {
          const result = yield* authz.batchIsAuthorized({
            requests: [
              {
                principal: { entityType: "PhotoApp::User", entityId: "alice" },
                action: {
                  actionType: "PhotoApp::Action",
                  actionId: "viewPhoto",
                },
                resource: {
                  entityType: "PhotoApp::Photo",
                  entityId: "vacation.jpg",
                },
              },
              {
                principal: { entityType: "PhotoApp::User", entityId: "bob" },
                action: {
                  actionType: "PhotoApp::Action",
                  actionId: "viewPhoto",
                },
                resource: {
                  entityType: "PhotoApp::Photo",
                  entityId: "vacation.jpg",
                },
              },
            ],
          });
          return yield* HttpServerResponse.json({
            decisions: result.results.map((r) => r.decision),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(AWS.VerifiedPermissions.IsAuthorizedHttp)),
);
