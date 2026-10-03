import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * The testing subscription is an Azure free trial with a spending limit
 * (~$200 credit, ~4 regional vCPUs, marketplace offers blocked).
 *
 * Every resource keeps a full lifecycle test. Lifecycles that would cost
 * more than about $1 per run, or take longer than ~10 minutes to provision,
 * are written in full but only run with `AZURE_TEST_EXPENSIVE=1`. Record
 * the estimated cost/time in a comment above the test.
 */
export const runExpensive = !!process.env.AZURE_TEST_EXPENSIVE;

/**
 * Lifecycles the free trial cannot run at all (marketplace/partner SaaS,
 * dedicated hardware, zero quota, enterprise-only features). They run only
 * with `AZURE_TEST_PAID=1` on an upgraded subscription. Keep an ungated
 * probe test that asserts the exact typed error the trial returns.
 */
export const runPaidOnly = !!process.env.AZURE_TEST_PAID;

/**
 * The trial allows ~4 regional vCPUs. Tests that create VMs, scale sets,
 * or node pools hold one slot per vCPU for their whole body so one
 * `pnpm test test/Azure` run never exceeds the quota.
 */
const vcpus = Semaphore.makeUnsafe(4);

/** Run a test body while holding `count` regional vCPUs. */
export const withVcpus =
  (count: number) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    vcpus.withPermits(count)(self);

/**
 * The trial allows 3 public IP addresses per region. Tests that create
 * public IPs (directly, or via load balancers, NAT gateways, bastions,
 * gateways) hold one slot per IP for their whole body.
 */
const publicIps = Semaphore.makeUnsafe(3);

/** Run a test body while holding `count` regional public IP addresses. */
export const withPublicIps =
  (count: number) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    publicIps.withPermits(count)(self);

/**
 * The trial caps Container Apps managed environments per region
 * (`MaxNumberOfRegionalEnvironmentsInSubscription`). Tests that create an
 * environment hold the single slot for their whole body.
 */
const managedEnvironments = Semaphore.makeUnsafe(1);

/** Run a test body while holding the one Container Apps environment slot. */
export const withManagedEnvironment = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => managedEnvironments.withPermits(1)(self);
