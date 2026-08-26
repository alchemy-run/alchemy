import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as people from "@distilled.cloud/gcp/people_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

const probeAccess = () =>
  people
    .listContactGroups({ pageSize: 1, groupFields: "name,clientData" })
    .pipe(
      Effect.as("ok" as const),
      Effect.catchTag(["Forbidden", "NotFound", "Unauthorized"], (error) =>
        Effect.succeed(error._tag),
      ),
    );

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetContactGroup and GetContactPeople round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(["Forbidden", "NotFound", "Unauthorized"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* GCP.People.ContactGroup("Friends", {
            name: "Alchemy Binding Friends",
          });
          const person = yield* GCP.People.ContactPeople("Ada", {
            givenName: "Ada",
            familyName: "Lovelace",
            memberships: [group.resourceName],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* group.resourceName;
              yield* person.resourceName;
              const getGroup = yield* GCP.People.GetContactGroup(group);
              const getPerson = yield* GCP.People.GetContactPeople(person);
              return Effect.fn(function* () {
                const groupMetadata = yield* getGroup({});
                const personMetadata = yield* getPerson({});
                return { groupMetadata, personMetadata };
              });
            }),
          );
          const probe = yield* Probe({});
          return {
            group,
            person,
            groupMetadata: probe.groupMetadata,
            personMetadata: probe.personMetadata,
          };
        }),
      );

      expect(out.groupMetadata.resourceName).toEqual(out.group.resourceName);
      expect(out.groupMetadata.name).toContain("[alchemy ");
      expect(out.personMetadata.resourceName).toEqual(out.person.resourceName);
      expect(out.personMetadata.names?.[0]?.givenName).toEqual("Ada");
      expect(
        (out.personMetadata.clientData ?? []).some(
          (item) => item.key === "alchemy-id",
        ),
      ).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
