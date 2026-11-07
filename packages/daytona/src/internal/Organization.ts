import * as apiKeys from "@distilled.cloud/daytona/api_keys";
import { Credentials } from "@distilled.cloud/daytona/Credentials";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { resolved, type Ref } from "./Ref.ts";

/** The credentials don't name an organization and the API key reports none. */
export class OrganizationUnknown extends Data.TaggedError("Daytona.OrganizationUnknown")<{}> {
  override get message() {
    return "Could not determine the Daytona organization: set organizationId in the profile or use an organization API key";
  }
}

/**
 * The organization the credentials act on: the profile's `organizationId`,
 * else the organization the API key belongs to.
 */
export const currentOrganizationId = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const config = yield* credentials;
  if (config.organizationId) return config.organizationId;
  const key = yield* apiKeys.getCurrentApiKey({});
  if (!key.organizationId) return yield* new OrganizationUnknown();
  return key.organizationId;
});

/** An organization, by id. Accepts a `Daytona.Organization` or `{ organizationId }`. */
export type OrganizationRef = { readonly organizationId: string };

/** The organization a resource acts on: its `organization` prop, else the credentials'. */
export const organizationIdFor = (organization: Ref<OrganizationRef> | undefined) =>
  organization === undefined
    ? currentOrganizationId
    : Effect.succeed(resolved(organization).organizationId);

/** Whether the props now point the resource at a different organization (a replacement). */
export const movesOrganization = (
  organization: Ref<OrganizationRef> | undefined,
  output: { readonly organizationId: string },
) => Effect.map(organizationIdFor(organization), (id) => id !== output.organizationId);
