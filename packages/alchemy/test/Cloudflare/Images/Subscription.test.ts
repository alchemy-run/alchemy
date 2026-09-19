import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as images from "@distilled.cloud/cloudflare/images";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

test.provider.skipIf(!!process.env.CLOUDFLARE_TEST_IMAGES_UPLOAD)(
  "image uploads expose the typed entitlement rejection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const error = yield* Effect.acquireRelease(
        images.createV1({
          accountId,
          id: "alchemy-subscription-entitlement-probe",
          url: "https://developers.cloudflare.com/og-docs.png",
        }),
        (image) =>
          image.id
            ? images
                .deleteV1({ accountId, imageId: image.id })
                .pipe(Effect.orDie)
            : Effect.void,
      ).pipe(Effect.scoped, Effect.flip);
      expect(error._tag).toBe("ImagesAccessNotEnabled");
      yield* stack.destroy();
    }),
);

// Uploads require Images entitlement; the testing account returns ImagesAccessNotEnabled (5403).
test.provider.skipIf(!process.env.CLOUDFLARE_TEST_IMAGES_UPLOAD)(
  "an Images variant reference receives an account-wide upload event",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const variant = Cloudflare.Images.Variant("Variant", {
        name: "alchemySubscriptionUpload",
        fit: "contain",
        width: 100,
        height: 100,
      });
      yield* stack.deploy(variant);
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* variant;
          const queue = yield* Cloudflare.Queues.Queue("ImageEvents");
          const subscription = yield* Cloudflare.Queues.Subscription(
            "Uploads",
            {
              source: yield* Cloudflare.Images.Variant.ref("Variant"),
              events: ["image.uploaded"],
              queueId: queue.queueId,
            },
          );
          return { source, queue, subscription };
        }),
      );
      yield* queues.createConsumer({
        accountId,
        queueId: deployed.queue.queueId,
        type: "http_pull",
      });
      const image = yield* Effect.acquireRelease(
        images
          .createV1({
            accountId,
            id: deployed.subscription.subscriptionId,
            url: "https://developers.cloudflare.com/og-docs.png",
          })
          .pipe(
            Effect.flatMap((image) =>
              image.id
                ? Effect.succeed({ id: image.id })
                : Effect.fail(new Error("Image upload returned no identity")),
            ),
          ),
        (image) =>
          images.deleteV1({ accountId, imageId: image.id }).pipe(
            Effect.catchTag("ImageNotFound", () => Effect.void),
            Effect.orDie,
          ),
      );
      const bodies: string[] = [];
      const delivered = () =>
        bodies.some(
          (body) =>
            body.includes("cf.images.image.uploaded") &&
            body.includes(image.id) &&
            body.includes(deployed.subscription.subscriptionId) &&
            body.includes(accountId),
        );
      yield* Effect.gen(function* () {
        const pulled = yield* queues
          .pullMessage({
            accountId,
            queueId: deployed.queue.queueId,
            batchSize: 100,
            visibilityTimeoutMs: 1000,
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "QueueHttpPullNotEnabled",
              schedule: Schedule.spaced("2 seconds"),
              times: 8,
            }),
          );
        for (const message of pulled.messages ?? [])
          if (message.body) bodies.push(message.body);
        const acks = (pulled.messages ?? []).flatMap((message) =>
          message.leaseId ? [{ leaseId: message.leaseId }] : [],
        );
        if (acks.length)
          yield* queues.ackMessage({
            accountId,
            queueId: deployed.queue.queueId,
            acks,
          });
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          times: 10,
          until: delivered,
        }),
        Effect.timeout("60 seconds"),
      );
      expect(delivered()).toBe(true);
      yield* stack.deploy(variant);
      yield* images.getV1Variant({
        accountId,
        variantId: deployed.source.variantName,
      });
      yield* stack.destroy();
    }).pipe(Effect.scoped, Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  { timeout: 120_000, exclusive: true },
);
