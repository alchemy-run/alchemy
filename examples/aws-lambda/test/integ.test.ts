import {
  afterAll,
  beforeAll,
  deploy,
  destroy,
  expect,
  test,
} from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const out = (yield* stack) as unknown;
    const url = typeof out === "string" ? out : (out as { url: string }).url;
    expect(url).toBeString();
  }),
);
