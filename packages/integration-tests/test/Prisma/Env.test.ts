import * as Prisma from "@alchemy.run/prisma";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectedBound } from "../EnvBoundOutputs.ts";
import { getJson } from "../EnvHttp.ts";
import { expectedEnv, readEnvValues } from "../EnvValues.ts";
import { stringEnvValues, StringEnvValuesCompute } from "./fixtures/env-values-compute.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers: Prisma.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// One Prisma Compute deploy alone can take most of the 600s
// Compute.live.test.ts budgets for it.
const TIMEOUT = 600_000;
const tags = ["provider:prisma", "provider:prisma:compute", "live"];

// Compute's `env` takes only non-empty strings and Redacted strings (Prisma
// rejects empty values), so it deploys just those cases.
const Stack = Alchemy.Stack(
  "PrismaStringEnvValuesStack",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const app = yield* StringEnvValuesCompute;
    return { url: app.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: TIMEOUT });

test(
  "Prisma.Compute deploys string env values verbatim",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const expected = Object.fromEntries(
      Object.entries(readEnvValues(expectedEnv)).map(([key, value]) => [
        key,
        key in stringEnvValues ? value : null,
      ]),
    );
    expect(yield* getJson(`${url}/env`)).toEqual(expected);
  }).pipe(logLevel),
  { tags, timeout: 90_000 },
);

test(
  "Prisma.Compute reads back Outputs bound in init unchanged",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(yield* getJson(`${url}/bound`)).toEqual(expectedBound);
  }).pipe(logLevel),
  { tags, timeout: 90_000 },
);
