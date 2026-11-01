import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT IaaS compute and storage suites.
 *
 * Servers are billed per hour by machine type, so every suite that boots
 * one is gated behind the provider-wide slow flag `STACKIT_TEST_SLOW`.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/** The smallest general-purpose machine type (1 vCPU, 4 GB). */
export const MACHINE_TYPE = "g1.1";

/** The next size up, for the resize step. */
export const LARGER_MACHINE_TYPE = "g1.2";

/** Throwaway OpenSSH public keys (private halves discarded). */
export const PUBLIC_KEY_1 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG8xNYM2E5N5LmSSARyvuu11AVfZ/35WbHSTP5Sx4OJo alchemy-test-1";
export const PUBLIC_KEY_2 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHyIWWlbHsrZKJ7lSQic6W8p3w8OJZF1LBmppRShoKH3 alchemy-test-2";

export class NoPublicImage extends Data.TaggedError("NoPublicImage")<{
  readonly message: string;
}> {}

/** Id of the newest public Ubuntu image in the region. */
export const ubuntuImageId = (projectId: string, region: string) =>
  Effect.gen(function* () {
    const { items } = yield* iaas.listImages({ projectId, region, all: true });
    const ubuntu = items
      .filter((image) => image.scope === "public" && /ubuntu/i.test(image.name) && image.id)
      .sort((a, b) => b.name.localeCompare(a.name));
    const id = ubuntu[0]?.id;
    if (id === undefined) {
      return yield* new NoPublicImage({ message: `no public Ubuntu image in ${region}` });
    }
    return id;
  });

/** Presence of a test object; reads map the typed `NotFound` to `"gone"`. */
export type Presence = "present" | "gone";
export const PRESENT: Presence = "present";
export const GONE: Presence = "gone";

/** Bounded check that a presence read reports the object gone. */
export const expectGone = <E, R>(read: Effect.Effect<Presence, E, R>) =>
  read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (state) => state === "gone",
      times: 10,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );
