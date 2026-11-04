/**
 * Name of a Hyperdrive configuration the lookup tests create out-of-band
 * (directly through distilled, standing in for a dashboard-created config).
 * Per-user so concurrent runs on the shared test account don't collide.
 * It also names the Worker binding, and `Connect` reads that binding in the
 * deployed Worker, so the fallback for a missing `process` must produce the
 * same name in both places: it is never used because tests always set USER.
 */
export const lookupConfigName = (suite: "live" | "local") =>
  `alchemy-test-hd-lookup-${suite}-${(
    (typeof process === "undefined"
      ? undefined
      : (process.env.ALCHEMY_TEST_STAGE ?? process.env.USER)) ?? "ci"
  )
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")}`;
