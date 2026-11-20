import * as Prisma from "@alchemy.run/prisma";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectedBound, getJson } from "../EnvValues.ts";
import EnvValuesCompute, { computeEnv } from "./fixtures/env-values-compute.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers: Prisma.providers() });

// One Prisma Compute deploy alone can take most of the 600s
// Compute.live.test.ts budgets for it.
const TIMEOUT = 600_000;

const Stack = Alchemy.Stack(
  "PrismaStringEnvValuesStack",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const app = yield* EnvValuesCompute;
    return { url: app.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: TIMEOUT });

test(
  "Prisma.Compute deploys string env values and bound Outputs as the process reads them",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(yield* getJson(url)).toEqual({ env: computeEnv.expected, bound: expectedBound });
  }),
  { tags: ["provider:prisma", "provider:prisma:compute", "live"], timeout: 90_000 },
);
