import * as Docker from "@alchemy.run/docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { inMemoryState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

// Explicit names are scoped to the test stage; never touch shared Docker volumes.
const testVolumeName = (stage: string, suffix: string) => "alchemy-" + stage + "-volume-" + suffix;

test.provider(
  "diff replaces a volume when its Docker context changes",
  (stack) =>
    Effect.gen(function* () {
      const name = testVolumeName(stack.stage, "diff-context");
      const volumeProvider = yield* Provider.findProvider(Docker.Volume);
      const volumeDiff = yield* volumeProvider.diff!({
        id: "data",
        fqn: "data",
        instanceId: "instance",
        olds: { name, context: "default" },
        news: { name, context: "remote-build" },
        oldBindings: [],
        newBindings: [],
        output: {
          id: name,
          name,
          driver: "local",
          driverOpts: {},
          labels: {},
          mountpoint: undefined,
          createdAt: 0,
        },
      });
      expect(volumeDiff).toEqual({ action: "replace", deleteFirst: true });
    }),
  { tags: ["provider:docker", "provider:docker:volume", "local"] },
);

describe(
  "Docker.Volume",
  { tags: ["provider:docker", "provider:docker:volume", "local"], concurrent: false },
  () => {
    // Every prop is optional: `Docker.Volume("data")` must plan, deploy,
    // redeploy in place, and destroy without a props object.
    test.provider("deploys a volume declared without props", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        const first = yield* stack.deploy(Docker.Volume("bare-volume"));
        yield* expectFound(Docker.Volume.lookup({ name: first.name }), first);
        expect(first.driver).toBe("local");
        expect(first.labels["alchemy::volume-instance"]).toMatch(/^[0-9a-f]{32}$/);
        const second = yield* stack.deploy(Docker.Volume("bare-volume"));
        expect(second.createdAt).toBe(first.createdAt);
        yield* stack.destroy();
        const gone = yield* docker.volume.inspect(first.name).pipe(Effect.flip);
        expect(gone.reason._tag).toBe("NotFound");
      }),
    );

    test.provider("creates a volume with labels", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = testVolumeName(stack.stage, "create-labels");
        const prior = yield* docker.volume
          .inspect(volumeName)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        expect(prior).toBeUndefined();
        yield* Effect.addFinalizer(() => docker.volume.remove(volumeName).pipe(Effect.ignore));
        const volume = yield* stack.deploy(
          Docker.Volume("created-volume", {
            name: volumeName,
            labels: { "com.alchemy.test": "true" },
          }),
        );
        expect(volume.name).toBe(volumeName);
        expect(volume.id).toBe(volumeName);
        expect(volume.driver).toBe("local");
        expect(volume.labels["com.alchemy.test"]).toBe("true");
        expect(volume.mountpoint?.length).toBeGreaterThan(0);
      }),
    );

    test.provider("adopts an existing Docker volume", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = testVolumeName(stack.stage, "adopt-existing");
        yield* Effect.addFinalizer(() => docker.volume.remove(volumeName).pipe(Effect.ignore));
        const initial = yield* docker.volume
          .inspect(volumeName)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        expect(initial).toBeUndefined();
        yield* docker.volume.create({ name: volumeName });

        const error = yield* stack
          .deploy(Docker.Volume("existing-volume", { name: volumeName }))
          .pipe(Effect.flip);
        expect(error._tag).toBe("OwnedBySomeoneElse");
        const volume = yield* stack.deploy(
          Docker.Volume("existing-volume", { name: volumeName }).pipe(adopt(true)),
        );
        expect(volume.name).toBe(volumeName);
        expect(volume.id).toBe(volumeName);
        expect(volume.driver).toBe("local");
        expect(volume.labels["alchemy::volume-instance"]).toBeUndefined();
        const redeployed = yield* stack.deploy(
          Docker.Volume("existing-volume", { name: volumeName }),
        );
        expect(redeployed.createdAt).toBe(volume.createdAt);
      }),
    );

    test.provider("adopts an externally labelled volume without replacing its data", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = testVolumeName(stack.stage, "adopt-labelled");
        yield* stack.destroy();
        const existing = yield* docker.volume
          .inspect(name)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        expect(existing).toBeUndefined();
        yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));
        yield* docker.volume.create({ name, label: { "managed.by": "compose" } });
        const before = yield* docker.volume.inspect(name);
        const resource = Docker.Volume("adopt-labelled", { name });
        const adopted = yield* stack.deploy(resource.pipe(adopt(true)));
        expect(adopted.labels["managed.by"]).toBe("compose");
        expect(adopted.labels["alchemy::volume-instance"]).toBeUndefined();
        expect((yield* docker.volume.inspect(name)).CreatedAt).toBe(before.CreatedAt);
        const again = yield* stack.deploy(resource);
        expect(again.createdAtRaw).toBe(before.CreatedAt);
        yield* stack.destroy();
      }),
    );

    test.provider(
      "refuses destructive configuration changes to an adopted foreign volume",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const name = testVolumeName(stack.stage, "foreign-config");
          yield* stack.destroy();
          const before = yield* docker.volume
            .inspect(name)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          expect(before).toBeUndefined();
          yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));
          yield* docker.volume.create({ name, label: { owner: "external" } });
          const resource = Docker.Volume("foreign-config", { name });
          const adopted = yield* stack.deploy(resource.pipe(adopt(true)));
          const failure = yield* stack
            .plan(Docker.Volume("foreign-config", { name, labels: { purpose: "new" } }))
            .pipe(Effect.flip);
          expect(failure._tag).toBe("OwnedBySomeoneElse");
          const current = yield* docker.volume.inspect(name);
          expect(current.CreatedAt).toBe(adopted.createdAtRaw);
          expect(current.Labels?.owner).toBe("external");
          yield* stack.destroy();
        }),
    );

    test.provider("adopts a volume branded by another Alchemy generation explicitly", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = testVolumeName(stack.stage, "foreign-branded");
        yield* stack.destroy();
        const prior = yield* docker.volume
          .inspect(name)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        expect(prior).toBeUndefined();
        yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));
        const foreignGeneration = "f".repeat(32);
        yield* docker.volume.create({
          name,
          label: {
            "alchemy::stack": "other",
            "alchemy::stage": "other",
            "alchemy::id": "other",
            "alchemy::volume-instance": foreignGeneration,
            "managed.by": "other",
          },
        });
        const original = yield* docker.volume.inspect(name);
        const resource = Docker.Volume("foreign-branded", { name });
        const withoutAdoption = yield* stack.deploy(resource).pipe(Effect.flip);
        expect(withoutAdoption._tag).toBe("OwnedBySomeoneElse");
        const adopted = yield* stack.deploy(resource.pipe(adopt(true)));
        expect(adopted.labels["alchemy::volume-instance"]).toBe(foreignGeneration);
        expect(adopted.labels["managed.by"]).toBe("other");
        expect(adopted.createdAtRaw).toBe(original.CreatedAt);
        const redeployed = yield* stack.deploy(resource);
        expect(redeployed.createdAtRaw).toBe(original.CreatedAt);
        yield* stack.destroy();
      }),
    );

    test.provider(
      "requires adoption when another volume generation reuses our ownership labels",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const name = testVolumeName(stack.stage, "foreign-same-owner");
          yield* stack.destroy();
          const existing = yield* docker.volume
            .inspect(name)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          expect(existing).toBeUndefined();
          yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));

          const resource = Docker.Volume("orphaned-volume", { name });
          const old = yield* stack.deploy(resource);
          yield* stack.destroy();
          const differentGeneration =
            old.labels["alchemy::volume-instance"] === "f".repeat(32)
              ? "e".repeat(32)
              : "f".repeat(32);
          yield* docker.volume.create({
            name,
            label: { ...old.labels, "alchemy::volume-instance": differentGeneration },
          });
          const before = yield* docker.volume.inspect(name);

          const rejected = yield* stack.plan(resource).pipe(Effect.flip);
          expect(rejected._tag).toBe("OwnedBySomeoneElse");
          const deployError = yield* stack.deploy(resource).pipe(Effect.flip);
          expect(deployError._tag).toBe("OwnedBySomeoneElse");
          const adopted = yield* stack.deploy(resource.pipe(adopt(true)));
          expect(adopted.labels["alchemy::volume-instance"]).toBe(differentGeneration);
          expect(adopted.createdAtRaw).toBe(before.CreatedAt);
          expect((yield* docker.volume.inspect(name)).CreatedAt).toBe(before.CreatedAt);
          yield* stack.destroy();
        }),
    );

    test.provider(
      "does not replace a same-owner foreign generation after explicit adoption",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const name = testVolumeName(stack.stage, "foreign-same-owner-drift");
          yield* stack.destroy();
          const existing = yield* docker.volume
            .inspect(name)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          expect(existing).toBeUndefined();
          yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));

          const old = yield* stack.deploy(
            Docker.Volume("orphaned-drift", { name, labels: { version: "old" } }),
          );
          yield* stack.destroy();
          const differentGeneration =
            old.labels["alchemy::volume-instance"] === "f".repeat(32)
              ? "e".repeat(32)
              : "f".repeat(32);
          yield* docker.volume.create({
            name,
            label: { ...old.labels, "alchemy::volume-instance": differentGeneration },
          });
          yield* docker.run([
            "run",
            "--rm",
            "--network",
            "none",
            "--mount",
            "type=volume,source=" + name + ",target=/data",
            "alpine:3.22",
            "sh",
            "-c",
            "printf 'preserve' > /data/marker",
          ]);
          const adopted = yield* stack.deploy(
            Docker.Volume("orphaned-drift", { name }).pipe(adopt(true)),
          );
          expect(adopted.labels["alchemy::volume-instance"]).toBe(differentGeneration);
          const rejected = yield* stack
            .plan(Docker.Volume("orphaned-drift", { name, labels: { version: "new" } }))
            .pipe(Effect.flip);
          expect(rejected._tag).toBe("OwnedBySomeoneElse");
          const deployError = yield* stack
            .deploy(Docker.Volume("orphaned-drift", { name, labels: { version: "new" } }))
            .pipe(Effect.flip);
          expect(deployError._tag).toBe("OwnedBySomeoneElse");
          const marker = yield* docker.run([
            "run",
            "--rm",
            "--network",
            "none",
            "--mount",
            "type=volume,source=" + name + ",target=/data,readonly",
            "alpine:3.22",
            "cat",
            "/data/marker",
          ]);
          expect(marker.stdout.trim()).toBe("preserve");
          expect((yield* docker.volume.inspect(name)).Labels?.version).toBe("old");
          yield* stack.destroy();
        }),
    );

    test.provider(
      "replaces a volume created before generation labels when its labels change",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const name = testVolumeName(stack.stage, "legacy-generation");
          yield* stack.destroy();
          const existing = yield* docker.volume
            .inspect(name)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          expect(existing).toBeUndefined();
          yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));

          // Recreate the volume an older provider would have created: this
          // stack's ownership labels, but no `alchemy::volume-instance`.
          const resource = Docker.Volume("legacy-generation", { name, labels: { version: "1" } });
          const current = yield* stack.deploy(resource);
          yield* stack.destroy();
          const { "alchemy::volume-instance": _, ...legacyLabels } = current.labels;
          yield* docker.volume.create({ name, label: legacyLabels });
          const legacy = yield* stack.deploy(resource);
          expect(legacy.labels["alchemy::volume-instance"]).toBeUndefined();

          const replaced = yield* stack.deploy(
            Docker.Volume("legacy-generation", { name, labels: { version: "2" } }),
          );
          expect(replaced.labels.version).toBe("2");
          expect(replaced.labels["alchemy::volume-instance"]).toMatch(/^[0-9a-f]{32}$/);
          yield* stack.destroy();
          const gone = yield* docker.volume
            .inspect(name)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          expect(gone).toBeUndefined();
        }),
    );

    test.provider("refuses to plan, deploy or destroy a volume replaced externally", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = testVolumeName(stack.stage, "foreign-replacement");
        yield* stack.destroy();
        const prior = yield* docker.volume
          .inspect(name)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        expect(prior).toBeUndefined();
        yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));
        const resource = Docker.Volume("managed", { name });
        const original = yield* stack.deploy(resource);
        yield* docker.volume.remove(original.name);
        yield* docker.volume.create({ name, label: { "test.owner": "foreign" } });
        yield* docker.run([
          "run",
          "--rm",
          "--network",
          "none",
          "--mount",
          "type=volume,source=" + name + ",target=/data",
          "alpine:3.22",
          "sh",
          "-c",
          "printf 'preserve-this' > /data/marker",
        ]);

        const planError = yield* stack.plan(resource).pipe(Effect.flip);
        expect(planError._tag).toBe("OwnedBySomeoneElse");
        const deployError = yield* stack.deploy(resource).pipe(Effect.flip);
        expect(deployError._tag).toBe("OwnedBySomeoneElse");
        const destroyError = yield* stack.destroy().pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
        );
        expect(destroyError).toContain("OwnedBySomeoneElse");

        const stillThere = yield* docker.volume.inspect(name);
        expect(stillThere.Labels?.["test.owner"]).toBe("foreign");
        const marker = yield* docker.run([
          "run",
          "--rm",
          "--network",
          "none",
          "--mount",
          "type=volume,source=" + name + ",target=/data,readonly",
          "alpine:3.22",
          "cat",
          "/data/marker",
        ]);
        expect(marker.stdout.trim()).toBe("preserve-this");
        // The test itself created this replacement. Remove it explicitly,
        // then allow the runner to finish the interrupted destroy safely.
        yield* docker.volume.remove(name);
        yield* stack.destroy();
      }),
    );

    test.provider(
      "rejects reserved ownership labels before replacing an existing volume",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const original = yield* stack.deploy(Docker.Volume("protected-label"));
          const invalid = Docker.Volume("protected-label", {
            labels: { "alchemy::volume-instance": "spoofed" },
          });
          const error = yield* stack.plan(invalid).pipe(Effect.flip);
          expect(error._tag).toBe("InvalidVolumeOptions");
          expect(error.path).toContain("labels");
          const stillThere = yield* docker.volume.inspect(original.name);
          expect(stillThere.Labels?.["alchemy::volume-instance"]).toBe(
            original.labels["alchemy::volume-instance"],
          );
        }),
    );

    test.provider(
      "rejects invalid local Docker volume names before deleting the existing generation",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const resource = Docker.Volume("valid-name-before-replace");
          const original = yield* stack.deploy(resource);
          yield* docker.run([
            "run",
            "--rm",
            "--network",
            "none",
            "--mount",
            "type=volume,source=" + original.name + ",target=/data",
            "alpine:3.22",
            "sh",
            "-c",
            "printf 'original-data' > /data/marker",
          ]);
          const invalid = Docker.Volume("valid-name-before-replace", {
            name: original.name + "/not-a-volume",
          });

          const planError = yield* stack.plan(invalid).pipe(Effect.flip);
          expect(planError._tag).toBe("InvalidVolumeOptions");
          expect(planError.path).toBe("name");

          const deployError = yield* stack.deploy(invalid).pipe(Effect.flip);
          expect(deployError._tag).toBe("InvalidVolumeOptions");
          expect((yield* docker.volume.inspect(original.name)).CreatedAt).toBe(
            original.createdAtRaw,
          );
          const marker = yield* docker.run([
            "run",
            "--rm",
            "--network",
            "none",
            "--mount",
            "type=volume,source=" + original.name + ",target=/data,readonly",
            "alpine:3.22",
            "cat",
            "/data/marker",
          ]);
          expect(marker.stdout.trim()).toBe("original-data");
        }),
    );

    test.provider(
      "recreates a missing managed volume without silently adopting a foreign one",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          yield* stack.destroy();
          const resource = Docker.Volume("recover-missing");
          const original = yield* stack.deploy(resource);
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          yield* docker.volume.remove(original.name);
          const recovered = yield* stack.deploy(resource);
          expect(recovered.name).toBe(original.name);
          const inspected = yield* docker.volume.inspect(recovered.name);
          expect(inspected.Labels?.["alchemy::volume-instance"]).toBe(
            original.labels["alchemy::volume-instance"],
          );
        }),
    );

    test.provider("detects a replaced volume with copied generation labels", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = testVolumeName(stack.stage, "copied-labels");
        yield* stack.destroy();
        const existing = yield* docker.volume
          .inspect(name)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        expect(existing).toBeUndefined();
        yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));
        const resource = Docker.Volume("copied-labels", { name });
        const original = yield* stack.deploy(resource);
        yield* docker.volume.remove(name);
        // Some Docker Engines report CreatedAt only to whole seconds.
        // Wait across a full second to make the comparison deterministic.
        yield* Effect.sleep("1200 millis");
        yield* docker.volume.create({ name, label: original.labels });
        const replacement = yield* docker.volume.inspect(name);
        expect(replacement.CreatedAt).not.toBe(original.createdAtRaw);
        const failure = yield* stack.plan(resource).pipe(Effect.flip);
        expect(failure._tag).toBe("OwnedBySomeoneElse");
        yield* docker.volume.remove(name);
        yield* stack.destroy();
      }),
    );

    test.provider("does not fabricate a creation timestamp for malformed Docker data", () =>
      Effect.sync(() => {
        const attrs = Docker.toVolumeAttributes({
          Name: "invalid-timestamp",
          Driver: "local",
          CreatedAt: "not-a-valid-date",
          Labels: null,
          Options: null,
          Mountpoint: "",
          Scope: "local",
        });
        expect(attrs.createdAt).toBe(0);
        expect(attrs.createdAtRaw).toBe("not-a-valid-date");
      }),
    );

    test.provider(
      "does not trust an externally replaced adopted volume without generation labels",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const name = testVolumeName(stack.stage, "adopted-swap");
          yield* stack.destroy();
          const existing = yield* docker.volume
            .inspect(name)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          expect(existing).toBeUndefined();
          yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));
          yield* docker.volume.create({ name });
          const resource = Docker.Volume("adopted-swap", { name });
          const adopted = yield* stack.deploy(resource.pipe(adopt(true)));
          expect(adopted.labels["alchemy::volume-instance"]).toBeUndefined();

          yield* docker.volume.remove(name);
          yield* Effect.sleep("1200 millis");
          yield* docker.volume.create({ name });
          const replacement = yield* docker.volume.inspect(name);
          expect(replacement.CreatedAt).not.toBe(adopted.createdAtRaw);
          const failure = yield* stack.plan(resource).pipe(Effect.flip);
          expect(failure._tag).toBe("OwnedBySomeoneElse");
          yield* docker.volume.remove(name);
          yield* stack.destroy();
        }),
    );

    test.provider("does not reuse a retained fixed-name volume during replacement", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = testVolumeName(stack.stage, "retained-fixed");
        yield* stack.destroy();
        const existing = yield* docker.volume
          .inspect(name)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        expect(existing).toBeUndefined();
        yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));
        const first = yield* stack.deploy(
          Docker.Volume("retained", { name, labels: { version: "1" } }).pipe(
            RemovalPolicy.retain(),
          ),
        );
        const failure = yield* stack
          .deploy(
            Docker.Volume("retained", { name, labels: { version: "2" } }).pipe(
              RemovalPolicy.retain(),
            ),
          )
          .pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
          );
        expect(failure).toContain("OwnedBySomeoneElse");
        const current = yield* docker.volume.inspect(name);
        expect(current.CreatedAt).toBe(first.createdAtRaw);
        expect(current.Labels?.version).toBe("1");
        yield* stack.destroy();
        yield* docker.volume.remove(name);
      }),
    );

    test.provider("protect prevents replacing and destroying an existing volume", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = testVolumeName(stack.stage, "protected");
        yield* stack.destroy();
        const existing = yield* docker.volume
          .inspect(name)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        expect(existing).toBeUndefined();
        yield* Effect.addFinalizer(() => docker.volume.remove(name).pipe(Effect.ignore));
        const protectedVolume = Docker.Volume("protected", { name }).pipe(RemovalPolicy.protect());
        const first = yield* stack.deploy(protectedVolume);
        const replacementError = yield* stack
          .plan(
            Docker.Volume("protected", { name, labels: { version: "2" } }).pipe(
              RemovalPolicy.protect(),
            ),
          )
          .pipe(Effect.flip);
        expect(replacementError._tag).toBe("ProtectedResource");
        const destroyError = yield* stack.destroy().pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
        );
        expect(destroyError).toContain("ProtectedResource");
        expect((yield* docker.volume.inspect(name)).CreatedAt).toBe(first.createdAtRaw);
        yield* stack.deploy(Docker.Volume("protected", { name }));
        yield* stack.destroy();
      }),
    );

    test.provider("rejects a foreign replacement target before deleting the old volume", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const oldName = testVolumeName(stack.stage, "previous");
        const newName = testVolumeName(stack.stage, "squatted-target");
        yield* stack.destroy();
        for (const name of [oldName, newName]) {
          const existing = yield* docker.volume
            .inspect(name)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          expect(existing).toBeUndefined();
        }
        yield* Effect.addFinalizer(() => docker.volume.remove(newName).pipe(Effect.ignore));
        const old = yield* stack.deploy(Docker.Volume("move", { name: oldName }));
        yield* docker.volume.create({ name: newName, label: { owner: "foreign" } });
        const failure = yield* stack
          .deploy(Docker.Volume("move", { name: newName }))
          .pipe(Effect.flip);
        expect(failure._tag).toBe("OwnedBySomeoneElse");
        const previous = yield* docker.volume.inspect(oldName);
        expect(previous.Labels?.["alchemy::volume-instance"]).toBe(
          old.labels["alchemy::volume-instance"],
        );
        expect((yield* docker.volume.inspect(newName)).Labels?.owner).toBe("foreign");
        yield* docker.volume.remove(newName);
        yield* stack.destroy();
      }),
    );

    test.provider("replaces a volume when its labels change", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const first = yield* stack.deploy(
          Docker.Volume("replaceable-volume", { labels: { generation: "1" } }),
        );
        const second = yield* stack.deploy(
          Docker.Volume("replaceable-volume", { labels: { generation: "2" } }),
        );
        expect(second.id).not.toBe(first.id);
        expect(second.labels.generation).toBe("2");
      }),
    );
  },
);
