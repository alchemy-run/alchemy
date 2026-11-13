/**
 * Fly add-on calls (Tigris buckets, Upstash Redis) through the Fly GraphQL
 * Query SDK. One field selection serves every call, so Bucket and Redis
 * read the same row shape from lists, lookups, creates and updates.
 */
import { Query, type UnwrapPlan } from "@distilled.cloud/core/query";
import {
  Fly,
  GraphQLLive,
  type AddOn,
  type AddOnPlan,
  type AddOnType,
  type CreateAddOnInput,
  type CreateExtensionTosAgreementInput,
  type DeleteAddOnInput,
  type GqlTransport,
  type GraphQLRequirements,
  type UpdateAddOnInput,
} from "@distilled.cloud/fly-io/GraphQL";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Run a Query SDK effect with the Fly transport. The transport reads the
 * provider's `Credentials` and `HttpClient`, so the result requires them.
 */
const withGraphQL = <A, E>(
  effect: Effect.Effect<A, E, GqlTransport>,
): Effect.Effect<A, E, GraphQLRequirements> => Effect.provide(effect, GraphQLLive);

const addOnFields = (addOn: Query<AddOn>) => ({
  id: addOn.id,
  name: addOn.name,
  primaryRegion: addOn.primaryRegion,
  readRegions: addOn.readRegions,
  status: addOn.status,
  errorMessage: addOn.errorMessage,
  publicUrl: addOn.publicUrl,
  privateIp: addOn.privateIp,
  password: addOn.password,
  ssoLink: addOn.ssoLink,
  environment: addOn.environment,
  options: addOn.options,
  metadata: addOn.metadata,
  createdAt: addOn.createdAt,
  updatedAt: addOn.updatedAt,
  addOnPlanName: addOn.addOnPlanName,
  addOnPlanId: addOn.addOnPlan.id,
  orgSlug: addOn.organization.slug,
  orgRawSlug: addOn.organization.rawSlug,
});

/** One add-on as Bucket and Redis read it. Secrets are `Redacted`. */
export type AddOnRow = UnwrapPlan<ReturnType<typeof addOnFields>>;

const planFields = (plan: Query<AddOnPlan>) => ({
  id: plan.id,
  name: plan.name,
  displayName: plan.displayName,
  description: plan.description,
  maxDataSize: plan.maxDataSize,
  pricePerMonth: plan.pricePerMonth,
});

/** One add-on plan. */
export type AddOnPlanRow = UnwrapPlan<ReturnType<typeof planFields>>;

/** Every add-on of `type` in the token's organizations, across all pages. */
export const listAddOns = (type: AddOnType) =>
  Query.items(Fly.addOns({ type, first: 50 }).pipe(Query.map(addOnFields))).pipe(
    Stream.runCollect,
    withGraphQL,
  );

/** Every plan for add-ons of `type`, across all pages. */
export const listAddOnPlans = (type: AddOnType) =>
  Query.items(Fly.addOnPlans({ type, first: 50 }).pipe(Query.map(planFields))).pipe(
    Stream.runCollect,
    withGraphQL,
  );

/** One add-on by id or name, or `undefined` when Fly returns none. */
export const getAddOn = (input: { id?: string; name?: string; provider?: string }) =>
  Query.fn(() => Fly.addOn(input).pipe(Query.map(addOnFields)))().pipe(
    Effect.map((row) => row ?? undefined),
    withGraphQL,
  );

/** The organization's id and slug, or `undefined` when Fly returns none. */
export const getOrganization = (slug: string) =>
  Query.fn(() =>
    Fly.organization({ slug }).pipe(
      Query.map((org) => ({ id: org.id, slug: org.slug, rawSlug: org.rawSlug })),
    ),
  )().pipe(
    Effect.map((org) => org ?? undefined),
    withGraphQL,
  );

/** Whether the organization agreed to the add-on provider's terms of service. */
export const agreedToProviderTos = (slug: string, providerName: string) =>
  Query.fn(() => Fly.organization({ slug }).agreedToProviderTos({ providerName }))().pipe(
    withGraphQL,
  );

export const createExtensionTosAgreement = (input: CreateExtensionTosAgreementInput) =>
  Query.fn(() => ({
    clientMutationId: Fly.createExtensionTosAgreement({ input }).clientMutationId,
  }))().pipe(withGraphQL);

/** Create an add-on; the row carries `environment`, which list and get omit after create. */
export const createAddOn = (input: CreateAddOnInput) =>
  Query.fn(() => Fly.createAddOn({ input }).addOn.pipe(Query.map(addOnFields)))().pipe(
    Effect.map((row) => row ?? undefined),
    withGraphQL,
  );

export const updateAddOn = (input: UpdateAddOnInput) =>
  Query.fn(() => Fly.updateAddOn({ input }).addOn.pipe(Query.map(addOnFields)))().pipe(
    Effect.map((row) => row ?? undefined),
    withGraphQL,
  );

export const deleteAddOn = (input: DeleteAddOnInput) =>
  Query.fn(() => Fly.deleteAddOn({ input }).deletedAddOnName)().pipe(withGraphQL);
