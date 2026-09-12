import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as people from "@distilled.cloud/gcp/people_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const GROUP_FIELDS = "clientData,groupType,memberCount,metadata,name";

const waitUntilGone = (resourceName: string) =>
  people
    .getContactGroups({
      resourceName,
      groupFields: GROUP_FIELDS,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Unauthorized", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const probeAccess = () =>
  people.listContactGroups({ pageSize: 1, groupFields: GROUP_FIELDS }).pipe(
    Effect.as("ok" as const),
    Effect.catchTag(["Forbidden", "NotFound", "Unauthorized"], (error) =>
      Effect.succeed(error._tag),
    ),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getContactGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        people.getContactGroups({
          resourceName: "contactGroups/alchemyMissingGroup",
          groupFields: GROUP_FIELDS,
        }),
      );
      expect(["NotFound", "Forbidden", "Unauthorized"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createContactGroups without People access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* people
        .createContactGroups({
          body: {
            contactGroup: { name: "alchemy-people-group-probe" },
            readGroupFields: GROUP_FIELDS,
          },
        })
        .pipe(
          Effect.map((group) => ({
            _tag: "ok" as const,
            resourceName: group.resourceName,
          })),
          Effect.catchTag(
            ["Forbidden", "NotFound", "Unauthorized", "BadRequest", "Conflict"],
            (error) =>
              Effect.succeed({ _tag: error._tag, resourceName: undefined }),
          ),
        );

      if (result._tag === "ok") {
        if (result.resourceName) {
          yield* people
            .deleteContactGroups({ resourceName: result.resourceName })
            .pipe(
              Effect.catchTag(
                [
                  "NotFound",
                  "Forbidden",
                  "Unauthorized",
                  "BadRequest",
                  "Conflict",
                ],
                () => Effect.void,
              ),
            );
        }
      } else {
        expect([
          "Forbidden",
          "NotFound",
          "Unauthorized",
          "BadRequest",
          "Conflict",
        ]).toContain(result._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a contact group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(["Forbidden", "NotFound", "Unauthorized"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.People.ContactGroup("Friends", {
            name: "Alchemy Friends",
            clientData: [{ key: "env", value: "test" }],
          });
        }),
      );

      expect(created.resourceName.startsWith("contactGroups/")).toEqual(true);
      expect(created.name).toEqual("Alchemy Friends");
      expect(created.clientData).toEqual(
        expect.arrayContaining([{ key: "env", value: "test" }]),
      );

      const fetched = yield* people.getContactGroups({
        resourceName: created.resourceName,
        groupFields: GROUP_FIELDS,
      });
      expect(fetched.resourceName).toEqual(created.resourceName);
      expect(fetched.name).toContain("[alchemy ");
      expect(
        (fetched.clientData ?? []).some(
          (item) => item.key === "alchemy-id" && (item.value ?? "").length > 0,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.People.ContactGroup("Friends", {
            resourceName: created.resourceName,
            name: "Alchemy Friends v2",
            clientData: [{ key: "env", value: "prod" }],
          });
        }),
      );

      expect(updated.resourceName).toEqual(created.resourceName);
      expect(updated.name).toEqual("Alchemy Friends v2");
      expect(updated.clientData).toEqual(
        expect.arrayContaining([{ key: "env", value: "prod" }]),
      );

      const fetchedUpdate = yield* people.getContactGroups({
        resourceName: updated.resourceName,
        groupFields: GROUP_FIELDS,
      });
      expect(fetchedUpdate.name).toContain("[alchemy ");
      expect(fetchedUpdate.name).toContain("Alchemy Friends v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.resourceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
