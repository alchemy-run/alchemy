/** Tier B: the engine suite on Trino 484 over the Postgres store, with the `trino` CLI reading the stable name. */
import { images } from "./fixtures/docker.ts";
import { trinoPostgresSuite } from "./fixtures/trino.ts";

trinoPostgresSuite({ file: import.meta.url, image: images.trino, version: "484" });
