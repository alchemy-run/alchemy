import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { externalApplication } from "./fixtures/configuration/application.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

test.provider(
  "local deployment resolves Dockerfile against its build context",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(externalApplication());
      expect(app.applicationId.startsWith("dev:")).toBe(true);
      expect(
        app.dev && "dockerfile" in app.dev ? app.dev.dockerfile : undefined,
      ).toBe("Dockerfile");
      yield* stack.destroy();
    }),
  { timeout: 90_000 },
);
