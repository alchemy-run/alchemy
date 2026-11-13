/** Tier B: the Apache Iceberg REST fixture, every release run. */
import { icebergSuite } from "./fixtures/iceberg.ts";

icebergSuite({ file: import.meta.url, catalog: "rest-fixture", views: true });
