import { createCloudControlClient } from "../../../src/aws/control/client.js";

const client = await createCloudControlClient();

/**
 * Wait for a resource to be stably deleted (not just gone once due to eventual consistency)
 */
export async function waitForStableDeletion(
  typeName: string,
  id: string,
  {
    maxWaitMs = 60_000, // give up after a minute
    stablePeriodMs = 5_000, // require this long with no re-appearance
    pollBaseDelayMs = 500, // first poll delay
    pollMaxDelayMs = 5_000, // max back-off
  } = {},
) {
  let stableFor = 0;
  let delay = pollBaseDelayMs;
  const started = Date.now();

  while (Date.now() - started < maxWaitMs) {
    const res = await client.getResource(typeName, id);

    if (res === undefined) {
      // resource is currently gone – keep watching until it has *stayed* gone
      await new Promise((r) => setTimeout(r, delay));
      stableFor += delay;
      if (stableFor >= stablePeriodMs) return; // really gone
    } else {
      // it re-appeared – reset the stability timer
      stableFor = 0;
      await new Promise((r) => setTimeout(r, delay));
    }

    delay = Math.min(delay * 2, pollMaxDelayMs); // exponential back-off
  }

  throw new Error(
    `Resource ${typeName} ${id} still exists after ${maxWaitMs} ms`,
  );
}
