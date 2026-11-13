/** Tier C (opt-in: `--tags export-lakes`): Polaris, through OAuth2. */
import { icebergSuite } from "./fixtures/iceberg.ts";

icebergSuite({
  file: import.meta.url,
  catalog: "polaris",
  views: true,
  // A commit through a Java catalog takes seconds: one generated sequence fits the test ceiling.
  storeRuns: 1,
  engineRuns: 4,
});
