#!/usr/bin/env node
// oxlint runs its type-aware rules through `node_modules/.bin/tsgolint`. This
// bin points it at tsrs's port of tsgolint (`tsrs --lint`) instead, patched
// with the Effect rules by `pnpm prepare:patch` (`effect-tsgo patch --tsrs`),
// so a plain `oxlint` run uses tsrs without OXLINT_TSGOLINT_PATH.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const tsrs = dirname(createRequire(import.meta.url).resolve("tsrs/package.json"));
await import(pathToFileURL(join(tsrs, "lib/tsrs-lint.js")).href);
