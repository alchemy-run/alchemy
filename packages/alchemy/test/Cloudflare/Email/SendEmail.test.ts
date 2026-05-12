import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import SendEmailWorker from "./fixtures/worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "registers four send_email bindings and resolves them at runtime",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SendEmailWorker;
        }),
      );

      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: worker.workerName,
      });

      const sendEmail = (settings.bindings ?? []).filter(
        (b): b is Extract<typeof b, { type: "send_email" }> =>
          b.type === "send_email",
      );

      expect(sendEmail).toHaveLength(4);
      expect(sendEmail).toContainEqual(
        expect.objectContaining({
          type: "send_email",
          name: "EmailUnrestricted",
        }),
      );
      expect(sendEmail).toContainEqual(
        expect.objectContaining({
          type: "send_email",
          name: "EmailRestrictedDest",
          destinationAddress: "ops@example.com",
        }),
      );
      expect(sendEmail).toContainEqual(
        expect.objectContaining({
          type: "send_email",
          name: "EmailAllowedDests",
          allowedDestinationAddresses: [
            "ops@example.com",
            "alerts@example.com",
          ],
        }),
      );
      expect(sendEmail).toContainEqual(
        expect.objectContaining({
          type: "send_email",
          name: "EmailAllowedSenders",
          allowedSenderAddresses: ["noreply@example.com"],
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const url = worker.url as string;
      const res = yield* client.get(`${url}/probe`).pipe(
        Effect.flatMap((res) =>
          res.status === 200 ? Effect.succeed(res) : Effect.fail(res),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      const body = (yield* res.json) as Record<string, string>;
      // Each handle's runtime `.send` should resolve to a function once the
      // Worker request is executing with the bound env in scope.
      expect(body.unrestricted).toBe("function");
      expect(body.restrictedDest).toBe("function");
      expect(body.allowedDests).toBe("function");
      expect(body.allowedSenders).toBe("function");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
