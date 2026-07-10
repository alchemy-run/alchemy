import * as AWS from "@/AWS";
import { User } from "@/AWS/MemoryDB";
import * as Test from "@/Test/Vitest";
import * as memorydb from "@distilled.cloud/aws/memorydb";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// A fixed test password (16-128 printable chars). Not a real secret.
const TEST_PASSWORD = "AlchemyMemoryDbTestPass01";

const assertGone = (name: string) =>
  memorydb.describeUsers({ UserName: name }).pipe(
    Effect.flatMap(() => Effect.fail(new Error(`user '${name}' still exists`))),
    Effect.catchTag("UserNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(15)),
      ),
    }),
  );

test.provider(
  "create, update access string, delete a MemoryDB user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { user } = yield* stack.deploy(
        Effect.gen(function* () {
          const user = yield* User("AppUser", {
            authenticationMode: {
              type: "password",
              passwords: [TEST_PASSWORD],
            },
            accessString: "on ~* +@all",
            tags: { fixture: "memorydb-user" },
          });
          return { user };
        }),
      );

      expect(user.userName).toBeDefined();
      expect(user.userArn).toContain(":user/");
      expect(user.accessString).toContain("~*");
      expect(user.authenticationType).toBe("password");

      // Out-of-band verification.
      const described = yield* memorydb.describeUsers({
        UserName: user.userName,
      });
      const observed = described.Users?.[0];
      expect(observed?.Status).toBe("active");
      expect(observed?.Authentication?.Type).toBe("password");

      // Update the access string in place (name unchanged).
      const { user: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const user = yield* User("AppUser", {
            authenticationMode: {
              type: "password",
              passwords: [TEST_PASSWORD],
            },
            accessString: "on ~app:* +@read",
            tags: { fixture: "memorydb-user", env: "test" },
          });
          return { user };
        }),
      );
      expect(updated.userName).toBe(user.userName);
      expect(updated.accessString).toContain("~app:*");

      const redescribed = yield* memorydb.describeUsers({
        UserName: user.userName,
      });
      expect(redescribed.Users?.[0]?.AccessString).toContain("~app:*");

      yield* stack.destroy();
      yield* assertGone(user.userName);
    }),
  { timeout: 240_000 },
);
