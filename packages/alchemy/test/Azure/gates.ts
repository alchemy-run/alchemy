import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * The testing subscription is pay-as-you-go. Quotas a test needs beyond the
 * new-subscription defaults are raised by the test itself (see `quota.ts`)
 * and preview features are registered by it (see `features.ts`).
 *
 * Every resource keeps a full lifecycle test. Lifecycles that would cost
 * more than about $1 per run, or take longer than ~10 minutes to provision,
 * are written in full but only run with `AZURE_TEST_EXPENSIVE=1`. Record
 * the estimated cost/time in a comment above the test.
 */
export const runExpensive = !!process.env.AZURE_TEST_EXPENSIVE;

/**
 * Lifecycles that need a paid subscription or something beyond Azure itself
 * (marketplace/partner SaaS, dedicated hardware, gated previews,
 * enterprise-only features). They run only with `AZURE_TEST_PAID=1`. Keep an
 * ungated probe test that asserts the exact typed error otherwise returned.
 */
export const runPaidOnly = !!process.env.AZURE_TEST_PAID;

/**
 * Regional vCPU budget for one `pnpm test test/Azure` run (the testing
 * subscription's eastus limit is 100). Tests that create VMs, scale sets,
 * or node pools hold one slot per vCPU for their whole body so one run
 * never exceeds the quota.
 */
const vcpus = Semaphore.makeUnsafe(64);

/** Run a test body while holding `count` regional vCPUs. */
export const withVcpus =
  (count: number) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    vcpus.withPermits(count)(self);

/**
 * Public IP budget for one run. Tests that create public IPs (directly, or
 * via load balancers, NAT gateways, bastions, gateways) hold one slot per IP
 * for their whole body.
 */
const publicIps = Semaphore.makeUnsafe(20);

/** Run a test body while holding `count` regional public IP addresses. */
export const withPublicIps =
  (count: number) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    publicIps.withPermits(count)(self);

/**
 * Container Apps caps managed environments per region
 * (`MaxNumberOfRegionalEnvironmentsInSubscription`). Tests that create an
 * environment hold a slot for their whole body.
 */
const managedEnvironments = Semaphore.makeUnsafe(4);

/** Run a test body while holding the one Container Apps environment slot. */
export const withManagedEnvironment = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => managedEnvironments.withPermits(1)(self);
