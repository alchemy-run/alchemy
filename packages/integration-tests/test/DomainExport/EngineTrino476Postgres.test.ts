/** Opt-in (`--tags export-versions`): the engine suite on Trino 476 over the Postgres store. */
import { images } from "./fixtures/docker.ts";
import { trinoPostgresSuite } from "./fixtures/trino.ts";

trinoPostgresSuite({ file: import.meta.url, image: images.trino476, version: "476", optIn: true });
