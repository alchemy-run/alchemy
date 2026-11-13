/** Tier C (opt-in: `--tags export-lakes`): Lakekeeper on Postgres. */
import { icebergSuite } from "./fixtures/iceberg.ts";

icebergSuite({
  file: import.meta.url,
  catalog: "lakekeeper",
  views: true,
  // A commit through this catalog takes seconds: one generated sequence fits the test ceiling.
  storeRuns: 1,
  engineRuns: 4,
});
