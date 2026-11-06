/**
 * Name of a Hyperdrive configuration the lookup tests create out-of-band
 * (directly through distilled, standing in for a dashboard-created config).
 * Derived from the stack's stage so concurrent runs on the shared test
 * account don't collide. A lookup's props name its Worker binding, so a
 * fixture computes this from `yield* Stage`, which resolves the same at
 * deploy time and inside the deployed Worker.
 */
export const lookupConfigName = (suite: "live" | "local", stage: string) =>
  `alchemy-test-hd-lookup-${suite}-${stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
