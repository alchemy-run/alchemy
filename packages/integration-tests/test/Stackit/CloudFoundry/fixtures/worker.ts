import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Org = Stackit.CloudFoundry.Organization("CloudFoundryBindingsOrg", {});

export const Dev = Effect.gen(function* () {
  const organization = yield* Org;
  return yield* Stackit.CloudFoundry.Space("CloudFoundryBindingsSpace", {
    organizationId: organization.organizationId,
    forceDestroy: true,
  });
});

/**
 * A Cloudflare Worker with every Cloud Foundry binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class CloudFoundryBindingsWorker extends Cloudflare.Worker<CloudFoundryBindingsWorker>()(
  "StackitCloudFoundryBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const organization = yield* Org;
    const space = yield* Dev;
    const getOrganization = yield* Stackit.CloudFoundry.GetOrganization(organization);
    const listOrganizations = yield* Stackit.CloudFoundry.ListOrganizations(organization);
    const applyQuota = yield* Stackit.CloudFoundry.ApplyOrganizationQuota(organization);
    const getOrganizationQuota = yield* Stackit.CloudFoundry.GetOrganizationQuota(organization);
    const listOrganizationQuotas = yield* Stackit.CloudFoundry.ListOrganizationQuotas(organization);
    const getUsage = yield* Stackit.CloudFoundry.GetOrganizationUsageSummary(organization);
    const getSpace = yield* Stackit.CloudFoundry.GetSpace(space);
    const listSpaces = yield* Stackit.CloudFoundry.ListSpaces(organization);
    const getPlatform = yield* Stackit.CloudFoundry.GetPlatform(organization);
    const listPlatforms = yield* Stackit.CloudFoundry.ListPlatforms(organization);
    const getPlatformQuota = yield* Stackit.CloudFoundry.GetPlatformQuota(organization);
    const listPlatformQuotas = yield* Stackit.CloudFoundry.ListPlatformQuotas(organization);

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
        const quotaId = url.searchParams.get("quotaId") ?? "";
        switch (url.pathname) {
          case "/get-organization":
            return yield* respond(getOrganization());
          case "/list-organizations":
            return yield* respond(listOrganizations({ withDetails: true }));
          case "/apply-organization-quota":
            return yield* respond(applyQuota({ quotaId }));
          case "/get-organization-quota":
            return yield* respond(getOrganizationQuota({ quotaId }));
          case "/list-organization-quotas":
            return yield* respond(listOrganizationQuotas());
          case "/get-organization-usage-summary":
            return yield* respond(getUsage());
          case "/get-space":
            return yield* respond(getSpace());
          case "/list-spaces":
            return yield* respond(listSpaces());
          case "/get-platform":
            return yield* respond(getPlatform());
          case "/list-platforms":
            return yield* respond(listPlatforms());
          case "/get-platform-quota":
            return yield* respond(getPlatformQuota({ quotaId }));
          case "/list-platform-quotas":
            return yield* respond(listPlatformQuotas());
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide([
      Stackit.CloudFoundry.GetOrganizationHttp,
      Stackit.CloudFoundry.ListOrganizationsHttp,
      Stackit.CloudFoundry.ApplyOrganizationQuotaHttp,
      Stackit.CloudFoundry.GetOrganizationQuotaHttp,
      Stackit.CloudFoundry.ListOrganizationQuotasHttp,
      Stackit.CloudFoundry.GetOrganizationUsageSummaryHttp,
      Stackit.CloudFoundry.GetSpaceHttp,
      Stackit.CloudFoundry.ListSpacesHttp,
      Stackit.CloudFoundry.GetPlatformHttp,
      Stackit.CloudFoundry.ListPlatformsHttp,
      Stackit.CloudFoundry.GetPlatformQuotaHttp,
      Stackit.CloudFoundry.ListPlatformQuotasHttp,
    ]),
  ),
) {}
