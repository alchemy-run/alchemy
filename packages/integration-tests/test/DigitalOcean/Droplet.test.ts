import * as DigitalOcean from "@alchemy.run/digitalocean";
import { ignoreNotFound } from "@alchemy.run/digitalocean/internal/notFound";
import { hashOwnershipTag, isAlchemyTag } from "@alchemy.run/digitalocean/internal/ownership";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  deleteTag,
  dropletsDestroy,
  getDroplet,
  getDropletAction,
  getTag,
  postDropletAction,
  type Droplet as ApiDroplet,
  type PostDropletActionRequestBody,
} from "@distilled.cloud/digitalocean";
import { OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Drift from "alchemy/Drift";
import { KeyPair } from "alchemy/KeyPair";
import * as Output from "alchemy/Output";
import type * as Plan from "alchemy/Plan";
import { State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { forgetAttributes, isGone, logLevel, skipSlow, testName } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

type DropletProps = DigitalOcean.DropletProps;
type DropletAttributes = DigitalOcean.DropletAttributes;

const REGION = "sfo2";
const OTHER_REGION = "nyc3";
// The smallest size, available in every region.
const SIZE = "s-1vcpu-512mb-10gb";
const OTHER_SIZE = "s-1vcpu-1gb";
const IMAGE = "ubuntu-24-04-x64";
const OTHER_IMAGE = "ubuntu-22-04-x64";
// Plans never send these, so they need not exist.
const SSH_KEY_FINGERPRINT = "3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:45:fa";
const VOLUME_ID = "506f78a4-e098-11e5-ad9f-000f53306ae1";
const VPC_UUID = "760e09ef-dc84-11e8-981e-3cfdfeaae000";
const CLOUD_CONFIG = "#cloud-config\npackages: [docker.io]";
// A droplet takes one to two minutes to create and as long to destroy.
const LIVE_TIMEOUT = 420_000;
// The lifecycle test also rebuilds the droplet twice.
const LIFECYCLE_TIMEOUT = 720_000;

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:droplet", "live"];

const PROPS: DropletProps = { region: REGION, size: SIZE, image: IMAGE };

const droplet = (props: Partial<DropletProps> = {}) =>
  DigitalOcean.Droplet("TestDroplet", { ...PROPS, ...props });

// The name comes from a key pair the plan has not created, so it is unknown.
const dropletWithUnresolvedName = (props: Partial<DropletProps>) =>
  Effect.gen(function* () {
    const pending = yield* KeyPair("PendingName");
    return yield* DigitalOcean.Droplet("TestDroplet", {
      ...PROPS,
      ...props,
      name: Output.map(pending.publicKey, () => props.name ?? "pending"),
    });
  });

/** Names and tags unique to the user and worktree running the test. */
const namesFor = (stage: string) => {
  const names = {
    droplet: testName(stage, "droplet"),
    renamed: testName(stage, "droplet-renamed"),
    tag: testName(stage, "droplet"),
    extraTag: testName(stage, "droplet-extra"),
  };
  const deployed: Partial<DropletProps> = { name: names.droplet, tags: [names.tag] };
  const updated: Partial<DropletProps> = {
    name: names.renamed,
    tags: [names.tag, names.extraTag],
    ipv6: true,
  };
  return { ...names, deployed, updated };
};

const NOOP = { action: "noop" };
const UPDATE = { action: "update" };
const REPLACE = { action: "replace", deleteFirst: false };
const REPLACE_DELETING_FIRST = { action: "replace", deleteFirst: true };

interface PlanCase {
  readonly change: string;
  /** Desired props, on top of the deployed ones. */
  readonly props?: Partial<DropletProps>;
  readonly expected: object;
}

const planCases = (names: ReturnType<typeof namesFor>): ReadonlyArray<PlanCase> => [
  { change: "nothing", expected: NOOP },
  { change: "region", props: { region: OTHER_REGION }, expected: REPLACE },
  { change: "size", props: { size: OTHER_SIZE }, expected: REPLACE },
  { change: "image", props: { image: OTHER_IMAGE }, expected: REPLACE },
  { change: "sshKeys", props: { sshKeys: [SSH_KEY_FINGERPRINT] }, expected: REPLACE },
  { change: "backups", props: { backups: true }, expected: REPLACE },
  { change: "monitoring", props: { monitoring: true }, expected: REPLACE },
  { change: "userData", props: { userData: CLOUD_CONFIG }, expected: REPLACE },
  { change: "volumes", props: { volumes: [VOLUME_ID] }, expected: REPLACE },
  { change: "vpcUuid", props: { vpcUuid: VPC_UUID }, expected: REPLACE },
  {
    change: "withDropletAgent set to false",
    props: { withDropletAgent: false },
    expected: REPLACE,
  },
  { change: "name", props: { name: names.renamed }, expected: UPDATE },
  { change: "tags", props: { tags: [names.tag, names.extraTag] }, expected: UPDATE },
  { change: "ipv6 enabled", props: { ipv6: true }, expected: UPDATE },
  {
    change: "replaceAfter longer than the droplet's age",
    props: { replaceAfter: "30 days" },
    expected: UPDATE,
  },
  {
    change: "replaceAfter shorter than the droplet's age",
    props: { replaceAfter: "1 second" },
    expected: REPLACE,
  },
];

const plannedAction = (plan: Plan.Plan) => {
  const node = plan.resources.TestDroplet;
  return node?.action === "replace"
    ? { action: node.action, deleteFirst: node.deleteFirst }
    : { action: node?.action };
};

const dropletRow = (stack: Test.ScratchStack) => ({
  stack: stack.name,
  stage: stack.stage,
  fqn: "TestDroplet",
});

/** Runs a droplet action out of band and waits for it, as a console change would. */
const changeOutOfBand = Effect.fn(function* (
  dropletId: number,
  body: PostDropletActionRequestBody,
) {
  const posted = yield* postDropletAction({ droplet_id: dropletId, body });
  yield* getDropletAction({ droplet_id: dropletId, action_id: posted.action.id }).pipe(
    Effect.map((response) => response.action.status),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status !== "in-progress",
      times: 36,
    }),
    Effect.flatMap((status) =>
      status === "completed"
        ? Effect.void
        : Effect.die(new Error(`Droplet action ${body.type} ended '${status}'`)),
    ),
  );
});

const isGenerationTag = (tag: string) => tag.startsWith("alchemy:generation:");

const generationTagOf = (dropletId: number) =>
  getDroplet({ droplet_id: dropletId }).pipe(
    Effect.flatMap((response) => Effect.fromNullishOr(response.droplet.tags.find(isGenerationTag))),
  );

/** Deletes the state row, as if the state store had lost it. */
const forgetStateRow = Effect.fn(function* (stack: Test.ScratchStack) {
  const state = yield* yield* State;
  yield* state.delete(dropletRow(stack));
});

/** Destroys a droplet the stack no longer knows about, and its alchemy tags. */
const destroyOrphan = (orphan: ApiDroplet) =>
  ignoreNotFound(dropletsDestroy({ droplet_id: orphan.id })).pipe(
    Effect.andThen(
      Effect.forEach(
        orphan.tags.filter(isAlchemyTag),
        (tag) => ignoreNotFound(deleteTag({ tag_id: tag })),
        { discard: true },
      ),
    ),
  );

test.provider(
  "a tag with the reserved alchemy: prefix is refused before anything is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const refused = yield* stack.deploy(droplet({ tags: ["alchemy:mine"] })).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(DigitalOcean.DropletTagReserved);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: LIVE_TAGS },
);

test.provider.skipIf(skipSlow)(
  "droplet lifecycle: create, plan each change, resume lost attributes, update in place, refuse a foreign twin, destroy",
  (stack) => {
    const names = namesFor(stack.stage);
    // Tags named in `tags` outlive their droplets.
    const deleteUserTags = Effect.forEach(
      [names.tag, names.extraTag],
      (tag) => ignoreNotFound(deleteTag({ tag_id: tag })),
      { discard: true },
    );
    return Effect.gen(function* () {
      yield* stack.destroy();
      const DEPLOYED = names.deployed;
      const UPDATED = names.updated;

      const created = yield* stack.deploy(droplet(DEPLOYED));
      expect(created).toMatchObject({
        name: names.droplet,
        status: "active",
        region: REGION,
        sizeSlug: SIZE,
        tags: [names.tag],
      });
      expect(created.ipv4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

      const remote = yield* getDroplet({ droplet_id: created.dropletId });
      const ownershipTag = yield* hashOwnershipTag(stack.name, stack.stage, "TestDroplet");
      const generationTag = yield* generationTagOf(created.dropletId);
      expect(remote.droplet.name).toEqual(names.droplet);
      expect([...remote.droplet.tags].sort()).toEqual(
        [names.tag, ownershipTag, generationTag].sort(),
      );

      const cases = planCases(names);
      const planned = yield* Effect.forEach(cases, ({ change, props }) =>
        stack
          .plan(droplet({ ...DEPLOYED, ...props }))
          .pipe(Effect.map((plan) => [change, plannedAction(plan)] as const)),
      );
      expect(Object.fromEntries(planned)).toEqual(
        Object.fromEntries(cases.map(({ change, expected }) => [change, expected])),
      );

      // A name known only after deploy does not hide a change that replaces.
      const behindUnresolvedName = yield* stack.plan(
        dropletWithUnresolvedName({ ...DEPLOYED, userData: CLOUD_CONFIG }),
      );
      expect(plannedAction(behindUnresolvedName)).toEqual(REPLACE);

      yield* forgetAttributes(dropletRow(stack));
      const resumed = yield* stack.deploy(droplet(DEPLOYED));
      expect(resumed.dropletId).toEqual(created.dropletId);

      const updated = yield* stack.deploy(droplet(UPDATED));
      expect(updated).toMatchObject({
        dropletId: created.dropletId,
        name: names.renamed,
        ipv4: created.ipv4,
      });
      expect([...updated.tags].sort()).toEqual([names.tag, names.extraTag].sort());
      expect(updated.features).toContain("ipv6");
      expect(updated.ipv6).toMatch(/:/);
      expect(plannedAction(yield* stack.plan(droplet({ ...UPDATED, ipv6: false })))).toEqual(
        REPLACE,
      );

      // A same-named droplet without this resource's tag belongs to someone else.
      const twinFailure = yield* stack
        .plan(
          droplet(UPDATED).pipe(
            Effect.andThen(DigitalOcean.Droplet("Twin", { ...PROPS, name: names.renamed })),
          ),
        )
        .pipe(Effect.flip);
      expect(twinFailure).toBeInstanceOf(OwnedBySomeoneElse);

      // A console change to the image, once `alchemy drift
      // --repair` records it, is drift the next deploy replaces.
      const recordDrift = Drift.repair({ name: stack.name, stage: stack.stage }).pipe(
        Effect.provide(stack.state),
      );
      yield* changeOutOfBand(created.dropletId, { type: "rebuild", image: OTHER_IMAGE });
      yield* recordDrift;
      expect(plannedAction(yield* stack.plan(droplet(UPDATED)))).toEqual(REPLACE);
      yield* changeOutOfBand(created.dropletId, { type: "rebuild", image: IMAGE });
      yield* recordDrift;
      expect(plannedAction(yield* stack.plan(droplet(UPDATED)))).toEqual(NOOP);

      yield* stack.destroy();

      expect(yield* isGone(getDroplet({ droplet_id: created.dropletId }))).toBe(true);
      expect(yield* isGone(getTag({ tag_id: ownershipTag }))).toBe(true);
      expect(yield* isGone(getTag({ tag_id: generationTag }))).toBe(true);
      expect(yield* isGone(getTag({ tag_id: names.tag }))).toBe(false);
    }).pipe(Effect.ensuring(Effect.ignore(deleteUserTags)), logLevel);
  },
  { tags: LIVE_TAGS, timeout: LIFECYCLE_TIMEOUT },
);

test.provider.skipIf(skipSlow)(
  "a replacement gets a new generation tag, and the old droplet and its tag are deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const REPLACED_DROPLET_NAME = testName(stack.stage, "droplet-replaced");

      const created = yield* stack.deploy(droplet({ name: REPLACED_DROPLET_NAME }));
      const oldGenerationTag = yield* generationTagOf(created.dropletId);

      const replaced = yield* stack.deploy(
        droplet({ name: REPLACED_DROPLET_NAME, image: OTHER_IMAGE }),
      );
      expect(replaced.dropletId).not.toEqual(created.dropletId);
      expect(replaced.imageSlug).toEqual(OTHER_IMAGE);
      expect(replaced.name).toEqual(REPLACED_DROPLET_NAME);
      expect(yield* generationTagOf(replaced.dropletId)).not.toEqual(oldGenerationTag);
      expect(yield* isGone(getDroplet({ droplet_id: created.dropletId }))).toBe(true);
      expect(yield* isGone(getTag({ tag_id: oldGenerationTag }))).toBe(true);

      yield* stack.destroy();

      expect(yield* isGone(getDroplet({ droplet_id: replaced.dropletId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipSlow)(
  "a droplet whose state row is lost is left alone and the next deploy creates a new one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const orphanDroplet = droplet({ name: testName(stack.stage, "droplet-orphan") });

      yield* Effect.acquireUseRelease(
        stack.deploy(orphanDroplet).pipe(
          Effect.flatMap((created) => getDroplet({ droplet_id: created.dropletId })),
          Effect.map((response) => response.droplet),
          Effect.tap(() => forgetStateRow(stack)),
        ),
        (orphan) =>
          Effect.gen(function* () {
            const recreated = yield* stack.deploy(orphanDroplet);
            expect(recreated.dropletId).not.toEqual(orphan.id);

            yield* stack.destroy();

            expect(yield* isGone(getDroplet({ droplet_id: recreated.dropletId }))).toBe(true);
            expect(yield* isGone(getDroplet({ droplet_id: orphan.id }))).toBe(false);
          }),
        // A deleted state row hides the droplet from the harness teardown.
        destroyOrphan,
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
