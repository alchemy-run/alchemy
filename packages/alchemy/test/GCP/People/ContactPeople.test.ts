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

const PERSON_FIELDS =
  "names,emailAddresses,phoneNumbers,clientData,memberships,metadata,biographies,nicknames,userDefined";

const waitUntilGone = (resourceName: string) =>
  people
    .getPeople({
      resourceName,
      personFields: PERSON_FIELDS,
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
  people
    .listPeopleConnections({
      resourceName: "people/me",
      pageSize: 1,
      personFields: "names,clientData",
    })
    .pipe(
      Effect.as("ok" as const),
      Effect.catchTag(["Forbidden", "NotFound", "Unauthorized"], (error) =>
        Effect.succeed(error._tag),
      ),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getPeople on a missing contact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        people.getPeople({
          resourceName: "people/alchemyMissingPerson",
          personFields: PERSON_FIELDS,
        }),
      );
      expect(["NotFound", "Forbidden", "Unauthorized"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createContactPeople without People access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* people
        .createContactPeople({
          personFields: PERSON_FIELDS,
          body: {
            names: [{ givenName: "Alchemy", familyName: "Probe" }],
          },
        })
        .pipe(
          Effect.map((person) => ({
            _tag: "ok" as const,
            resourceName: person.resourceName,
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
            .deleteContactPeople({ resourceName: result.resourceName })
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
  "create, update, and delete a contact",
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
          return yield* GCP.People.ContactPeople("Ada", {
            givenName: "Ada",
            familyName: "Lovelace",
            emails: [{ value: "ada@example.com", type: "work" }],
            biography: "First programmer",
          });
        }),
      );

      expect(created.resourceName.startsWith("people/")).toEqual(true);
      expect(created.givenName).toEqual("Ada");
      expect(created.familyName).toEqual("Lovelace");
      expect(created.emails).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: "ada@example.com",
            type: "work",
          }),
        ]),
      );
      expect(created.biography).toEqual("First programmer");

      const fetched = yield* people.getPeople({
        resourceName: created.resourceName,
        personFields: PERSON_FIELDS,
      });
      expect(fetched.resourceName).toEqual(created.resourceName);
      expect(fetched.names?.[0]?.givenName).toEqual("Ada");
      expect(
        (fetched.clientData ?? []).some(
          (item) => item.key === "alchemy-id" && (item.value ?? "").length > 0,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.People.ContactPeople("Ada", {
            resourceName: created.resourceName,
            givenName: "Ada",
            familyName: "Byron",
            emails: [{ value: "ada@example.com", type: "work" }],
            phoneNumbers: [{ value: "+1-555-0100", type: "mobile" }],
            biography: "Countess of Lovelace",
          });
        }),
      );

      expect(updated.resourceName).toEqual(created.resourceName);
      expect(updated.familyName).toEqual("Byron");
      expect(updated.biography).toEqual("Countess of Lovelace");
      expect(updated.phoneNumbers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: "+1-555-0100",
            type: "mobile",
          }),
        ]),
      );

      const fetchedUpdate = yield* people.getPeople({
        resourceName: updated.resourceName,
        personFields: PERSON_FIELDS,
      });
      expect(fetchedUpdate.names?.[0]?.familyName).toEqual("Byron");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.resourceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
