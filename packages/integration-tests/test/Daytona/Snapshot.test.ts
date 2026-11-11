import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as snapshots from "@distilled.cloud/daytona/snapshots";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Daytona.providers() });

const find = (id: string) =>
  snapshots.getSnapshot({ id }).pipe(Effect.catchTag("SnapshotNotFound", () => Effect.undefined));

test.provider(
  "a snapshot needs exactly one source and a fixed image tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const none = yield* stack.deploy(Daytona.Snapshot("Bad", {})).pipe(Effect.flip);
      expect(String(none)).toContain("exactly one of");
      const latest = yield* stack
        .deploy(Daytona.Snapshot("Bad", { image: "node:latest" }))
        .pipe(Effect.flip);
      expect(String(latest)).toContain("fixed tag");
      // An inline Dockerfile has no build context to copy from.
      const copy = yield* stack
        .deploy(Daytona.Snapshot("Bad", { dockerfile: { content: "FROM node:22\nCOPY . /app\n" } }))
        .pipe(Effect.flip);
      expect(String(copy)).toContain("cannot COPY from a build context");
      yield* stack.destroy();
    }),
  { tags: ["provider:daytona", "live"], timeout: 60_000 },
);

test.provider.skipIf(!!process.env.FAST)(
  "pull an image, build a Dockerfile, and capture a warm base from a sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { pulled, built, context, warm } = yield* stack.deploy(
        Effect.gen(function* () {
          const Pulled = Daytona.Snapshot("Pulled", {
            image: "node:22-bookworm-slim",
            cpu: 1,
            memory: 1,
            disk: 3,
          });
          const pulled = yield* Pulled;
          const built = yield* Daytona.Snapshot("Built", {
            dockerfile: {
              content: "FROM node:22-bookworm-slim\nRUN echo built > /etc/alchemy-marker\n",
            },
            cpu: 1,
            memory: 1,
            disk: 3,
          });
          const context = yield* Daytona.Snapshot("Context", {
            context: new URL("./fixtures/snapshot-context", import.meta.url).pathname,
            build: { args: { GREETING: "from-alchemy" } },
            cpu: 1,
            memory: 1,
            disk: 3,
          });
          const warm = yield* Daytona.Snapshot("Warm", {
            // The declaration itself, not the yielded snapshot: it resolves when Warm is yielded.
            from: Pulled,
            // A plain node image has no /home/daytona.
            run: [
              "mkdir -p /opt/alchemy && echo warm > /opt/alchemy/marker",
              "test -f /opt/alchemy/marker",
            ],
          });
          return { pulled, built, context, warm };
        }),
      );
      yield* expectFound(Daytona.Snapshot.lookup({ name: pulled.name }), pulled, {
        // The build hash is this stack's record.
        ignore: ["buildHash"],
      });
      expect(pulled.state).toEqual("active");
      expect(built.state).toEqual("active");
      // The build ran check.js from the uploaded context with the baked ARG.
      expect(context.state).toEqual("active");
      expect(warm.state).toEqual("active");
      expect(warm.sourceSandboxId).toMatch(/.+/);
      // The build sandbox is gone once the snapshot is captured.
      const build = yield* sandboxes
        .getSandbox({ sandboxIdOrName: warm.sourceSandboxId! })
        .pipe(Effect.catchTag("SandboxNotFound", () => Effect.undefined));
      expect(
        build === undefined || build.state === "destroyed" || build.state === "destroying",
      ).toBe(true);

      // A deactivated snapshot is reactivated by deploy.
      yield* snapshots.deactivateSnapshot({ id: pulled.snapshotId });
      const reactivated = yield* stack.deploy(
        Daytona.Snapshot("Pulled", { image: "node:22-bookworm-slim", cpu: 1, memory: 1, disk: 3 }),
      );
      expect(reactivated.snapshotId).toEqual(pulled.snapshotId);
      expect(reactivated.state).toEqual("active");

      yield* stack.destroy();
      expect(yield* find(pulled.snapshotId)).toBeUndefined();
      expect(yield* find(built.snapshotId)).toBeUndefined();
      expect(yield* find(context.snapshotId)).toBeUndefined();
      expect(yield* find(warm.snapshotId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live", "slow"], timeout: 1_200_000 },
);

test.provider.skipIf(!!process.env.FAST)(
  "build a Dockerfile with local Docker and a build secret, push it to Daytona, boot from it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { local, checked } = yield* stack.deploy(
        Effect.gen(function* () {
          const local = yield* Daytona.Snapshot("Local", {
            dockerfile: {
              content: [
                "FROM node:22-bookworm-slim",
                // The secret is readable during the build and never stored.
                'RUN --mount=type=secret,id=token test "$(cat /run/secrets/token)" = from-alchemy \\',
                "  && mkdir -p /opt/alchemy && echo built-locally > /opt/alchemy/local",
              ].join("\n"),
            },
            build: { secrets: { token: Redacted.make("from-alchemy") } },
            cpu: 1,
            memory: 1,
            disk: 3,
          });
          // Booting a sandbox from the pushed image proves Daytona pulled it.
          const checked = yield* Daytona.Snapshot("LocalChecked", {
            from: local,
            run: ['test "$(cat /opt/alchemy/local)" = built-locally'],
          });
          return { local, checked };
        }),
      );
      expect(local.state).toEqual("active");
      expect(local.imageName).toMatch(/^cr\.app\.daytona\.io\/sbox-transient-/);
      expect(checked.state).toEqual("active");

      yield* stack.destroy();
      expect(yield* find(local.snapshotId)).toBeUndefined();
      expect(yield* find(checked.snapshotId)).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live", "slow"], timeout: 1_200_000 },
);
