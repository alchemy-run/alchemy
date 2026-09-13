import * as Cloudflare from "@/Cloudflare";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Cloudflare.providers() });

test.provider(
  "queue delivery settings create, update, drift repair and removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (settings?: Cloudflare.Queues.QueueSettings) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Queues.Queue("Settings", { settings });
          }),
        );
      const initial = yield* deploy({
        deliveryDelay: 5,
        deliveryPaused: true,
        messageRetentionPeriod: 3600,
      });
      const get = () =>
        queues.getQueue({
          accountId: initial.accountId,
          queueId: initial.queueId,
        });
      expect((yield* get()).settings).toMatchObject({
        deliveryDelay: 5,
        deliveryPaused: true,
        messageRetentionPeriod: 3600,
      });

      yield* queues.patchQueue({
        accountId: initial.accountId,
        queueId: initial.queueId,
        settings: { deliveryPaused: false, messageRetentionPeriod: 7200 },
      });
      const updated = yield* deploy({
        deliveryDelay: 6,
        deliveryPaused: true,
        messageRetentionPeriod: 3600,
      });
      expect(updated.queueId).toBe(initial.queueId);
      expect((yield* get()).settings).toMatchObject({
        deliveryDelay: 6,
        deliveryPaused: true,
        messageRetentionPeriod: 3600,
      });

      const defaults = yield* deploy();
      expect(defaults.queueName).toBe(initial.queueName);
      expect((yield* get()).settings).toMatchObject({
        deliveryDelay: 0,
        deliveryPaused: false,
        messageRetentionPeriod: 86400,
      });
      // Lose the engine state while leaving the real queue deployed, then adopt it
      // by its physical name and converge settings through the normal deploy path.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: stack.stage,
          fqn: "Settings",
        });
      }).pipe(Effect.provide(stack.state));
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Queues.Queue("Settings", {
            name: initial.queueName,
            settings: { deliveryDelay: 3, deliveryPaused: true },
          });
        }),
      );
      expect(adopted.queueId).toBe(initial.queueId);
      expect((yield* get()).settings).toMatchObject({
        deliveryDelay: 3,
        deliveryPaused: true,
      });

      // Delete the cloud object while retaining engine state. Redeployment must
      // recreate it and apply settings to the new queue, whose create API omits them.
      yield* queues.deleteQueue({
        accountId: adopted.accountId,
        queueId: adopted.queueId,
      });
      const recovered = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Queues.Queue("Settings", {
            name: initial.queueName,
            settings: { deliveryDelay: 4, deliveryPaused: true },
          });
        }),
      );
      expect(recovered.queueId).not.toBe(initial.queueId);
      expect(recovered.queueName).toBe(initial.queueName);
      expect(
        (yield* queues.getQueue({
          accountId: recovered.accountId,
          queueId: recovered.queueId,
        })).settings,
      ).toMatchObject({
        deliveryDelay: 4,
        deliveryPaused: true,
        messageRetentionPeriod: 86400,
      });
      yield* stack.destroy();
      expect(
        yield* queues
          .getQueue({
            accountId: recovered.accountId,
            queueId: recovered.queueId,
          })
          .pipe(
            Effect.map(() => false),
            Effect.catchTag("QueueNotFound", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      const gone = yield* get().pipe(
        Effect.map(() => false),
        Effect.catchTag("QueueNotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }),
);
