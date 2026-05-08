import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";
import SendEmailWorker from "./send-email-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

describe.concurrent("Cloudflare.SendEmail", () => {
  test.provider(
    "registers send_email bindings on the deployed Worker",
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

        const sendEmailBindings = (settings.bindings ?? []).filter(
          (b): b is Extract<typeof b, { type: "send_email" }> =>
            b.type === "send_email",
        );

        expect(sendEmailBindings).toHaveLength(4);

        expect(sendEmailBindings).toContainEqual(
          expect.objectContaining({
            type: "send_email",
            name: "EMAIL_UNRESTRICTED",
          }),
        );
        expect(sendEmailBindings).toContainEqual(
          expect.objectContaining({
            type: "send_email",
            name: "EMAIL_DESTINATION",
            destinationAddress: "ops@example.com",
          }),
        );
        expect(sendEmailBindings).toContainEqual(
          expect.objectContaining({
            type: "send_email",
            name: "EMAIL_ALLOWED_DESTS",
            allowedDestinationAddresses: [
              "ops@example.com",
              "alerts@example.com",
            ],
          }),
        );
        expect(sendEmailBindings).toContainEqual(
          expect.objectContaining({
            type: "send_email",
            name: "EMAIL_ALLOWED_SENDERS",
            allowedSenderAddresses: ["noreply@example.com"],
          }),
        );

        yield* stack.destroy();

        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
  );
});
