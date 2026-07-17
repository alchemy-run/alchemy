import * as AWS from "@/AWS";
import { Record } from "@/AWS/Route53";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic, reused across runs. Route53 keys a public-zone create on
// `CallerReference`, so re-running reuses the same zone rather than piling up
// duplicates. (`example.com` is reserved by AWS, hence the bespoke name.)
const zoneName = "alchemy-route53-list-test.com.";
const callerReference = "alchemy-route53-record-list-test-v2";
const recordName = `list-record.${zoneName}`;
const recordValue = '"alchemy-list-test"';

const normalizeId = (id: string) => id.replace(/^\/hostedzone\//, "");

const findZoneIdByName = route53.listHostedZones.pages({}).pipe(
  Stream.runCollect,
  Effect.map((chunk) =>
    Array.from(chunk).flatMap((page) => page.HostedZones ?? []),
  ),
  Effect.map((zones) => zones.find((zone) => zone.Name === zoneName)?.Id),
);

// The hosted zone is a *standing* fixture — created once and reused across
// runs (we look it up by name first and only create on a genuine miss). We
// deliberately do NOT delete the zone on teardown. A short retry absorbs the
// brief list eventual-consistency right after a first-time create, when a
// create can race ahead of the zone appearing in `listHostedZones`.
const zoneNotYetListable =
  "hosted zone not found after HostedZoneAlreadyExists";

// List first, create only on a genuine miss. The previous create-first design
// got permanently poisoned whenever the standing zone was deleted (e.g. by a
// nuke): the stable `CallerReference` stays claimed during a long propagation
// window, so `createHostedZone` keeps returning `HostedZoneAlreadyExists` while
// `listHostedZones` still shows nothing. Looking the zone up first (and only
// creating with a *fresh* CallerReference when it's truly absent) sidesteps
// that trap — an absent/poisoned zone always re-creates cleanly, and a present
// zone is reused without ever hitting the conflict path.
const ensureZone = findZoneIdByName.pipe(
  Effect.flatMap((existing) =>
    existing !== undefined
      ? Effect.succeed(normalizeId(existing))
      : route53
          .createHostedZone({
            Name: zoneName,
            CallerReference: `${callerReference}-${crypto.randomUUID()}`,
          })
          .pipe(
            Effect.map((response) => normalizeId(response.HostedZone.Id)),
            // A concurrent attempt won the race — fall back to the lookup.
            Effect.catchTag("HostedZoneAlreadyExists", () =>
              findZoneIdByName.pipe(
                Effect.flatMap((id) =>
                  id !== undefined
                    ? Effect.succeed(normalizeId(id))
                    : Effect.fail(new Error(zoneNotYetListable)),
                ),
              ),
            ),
          ),
  ),
  Effect.retry({
    while: (e) => e instanceof Error && e.message === zoneNotYetListable,
    schedule: Schedule.spaced("5 seconds"),
    times: 24,
  }),
);

// Create/delete the record set out of band. The Alchemy engine's own deploy
// path is currently blocked by a distilled schema bug (see the file footer),
// so we seed the record directly to exercise `list()` against real Route53.
const changeRecord = (hostedZoneId: string, action: "UPSERT" | "DELETE") =>
  route53
    .changeResourceRecordSets({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Comment: "Route53 Record list() test",
        Changes: [
          {
            Action: action,
            ResourceRecordSet: {
              Name: recordName,
              Type: "TXT",
              TTL: 60,
              ResourceRecords: [{ Value: recordValue }],
            },
          },
        ],
      },
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("InvalidChangeBatch", () => Effect.void),
      Effect.catchTag("NoSuchHostedZone", () => Effect.void),
    );

test.provider(
  "list enumerates the deployed record across hosted zones",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hostedZoneId = yield* ensureZone;
      yield* changeRecord(hostedZoneId, "UPSERT");

      const provider = yield* Provider.findProvider(Record);

      // `list()` fans out across every hosted zone; assert our seeded record
      // appears. Retry briefly to absorb Route53's create eventual consistency.
      const found = yield* provider.list().pipe(
        Effect.map((all) =>
          all.some(
            (r) =>
              normalizeId(r.hostedZoneId) === normalizeId(hostedZoneId) &&
              r.name === recordName &&
              r.type === "TXT",
          ),
        ),
        Effect.flatMap((present) =>
          present
            ? Effect.succeed(true)
            : Effect.fail(new Error("record not yet listable")),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(10),
          ]),
        }),
        Effect.catch(() => Effect.succeed(false)),
      );

      yield* changeRecord(hostedZoneId, "DELETE");
      // Leave the hosted zone standing — see `ensureZone` above. Deleting it
      // would poison the stable `CallerReference` for the next run.
      yield* stack.destroy();

      expect(found).toBe(true);
    }),
  { timeout: 240_000 },
);

// Regression test for https://github.com/alchemy-run/alchemy/issues/736.
//
// An interrupted first deploy persists the record as `status: "creating"`
// with no attributes — and the Output-valued props (`hostedZoneId` flows from
// the zone resource, `name` is typically derived from it) do not survive the
// state round-trip: they deserialize as `undefined`. Plan's recovery branch
// then calls `provider.read` with those junk props, which crashed in
// `normalizeHostedZoneId(undefined)` (`undefined is not an object (evaluating
// 'hostedZoneId.replace')`) and wedged the stack. When `read` reports "not
// found", the same junk `olds` flow into `diff`, whose unguarded
// `normalizeHostedZoneId(olds.hostedZoneId)` / `normalizeName(olds.name)`
// were the next crash sites — so one wedged redeploy exercises all the guards.
//
// Deploy into the standing zone (see `ensureZone`), wedge the persisted row
// into exactly that shape, and assert the next deploy recovers: `read`
// returns undefined, `diff` falls through to the create recovery path, and
// reconcile's UPSERT converges on the half-created record.
const recoveryRecordName = `pr770-recovery.${zoneName}`;
const recoveryRecordValue = '"pr770-recovery"';

const deleteRecoveryRecord = (hostedZoneId: string) =>
  route53
    .changeResourceRecordSets({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Comment: "pr770 recovery test cleanup",
        Changes: [
          {
            Action: "DELETE",
            ResourceRecordSet: {
              Name: recoveryRecordName,
              Type: "TXT",
              TTL: 60,
              ResourceRecords: [{ Value: recoveryRecordValue }],
            },
          },
        ],
      },
    })
    .pipe(Effect.ignore);

test.provider(
  "recovers a half-created record whose creating-state lost Output-valued props (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hostedZoneId = yield* ensureZone;

      // Safety net: if the recovery redeploy defects (the pre-fix crash), the
      // half-created record would otherwise leak into the standing zone; on
      // the happy path the DELETE finds nothing (InvalidChangeBatch, ignored).
      yield* Effect.addFinalizer(() => deleteRecoveryRecord(hostedZoneId));

      const deployRecord = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Record("RecoveryRecord", {
              hostedZoneId,
              name: recoveryRecordName,
              type: "TXT",
              ttl: 60,
              records: [recoveryRecordValue],
            });
          }),
        );

      const created = yield* deployRecord();
      expect(created.name).toBe(recoveryRecordName);

      // Rewrite the record's persisted row into the wedged shape: `creating`,
      // no attributes, and the Output-valued identity props lost in the
      // state round-trip.
      const state = yield* yield* State;
      const stage = "test"; // scratch stacks default to the "test" stage
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const wedged = rows.find(
        (r): r is { fqn: string; row: ResourceState } =>
          isResourceState(r.row) && r.row.resourceType === "AWS.Route53.Record",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error("no AWS.Route53.Record state row found after deploy"),
        );
      }
      yield* state.set({
        stack: stack.name,
        stage,
        fqn: wedged.fqn,
        value: {
          ...wedged.row,
          status: "creating",
          attr: undefined,
          props: {
            ...wedged.row.props,
            hostedZoneId: undefined,
            name: undefined,
          },
        },
      });

      // Before the fix this crashed in plan with
      // `TypeError: undefined is not an object (evaluating 'hostedZoneId.replace')`.
      const recovered = yield* deployRecord();
      expect(normalizeId(recovered.hostedZoneId)).toBe(
        normalizeId(hostedZoneId),
      );
      expect(recovered.name).toBe(recoveryRecordName);
      expect(recovered.type).toBe("TXT");

      // Verify out of band the record actually exists.
      const observed = yield* route53.listResourceRecordSets({
        HostedZoneId: hostedZoneId,
        StartRecordName: recoveryRecordName,
        StartRecordType: "TXT",
        MaxItems: 1,
      });
      expect(
        (observed.ResourceRecordSets ?? []).some(
          (set) => set.Name === recoveryRecordName && set.Type === "TXT",
        ),
      ).toBe(true);

      // The standing zone is left in place (see `ensureZone` — deleting it
      // poisons the CallerReference); destroy() removes the record.
      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
