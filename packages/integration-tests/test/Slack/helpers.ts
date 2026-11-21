import * as Slack from "@alchemy.run/slack";
import * as Users from "@distilled.cloud/slack/users";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export class NoHumanMember extends Data.TaggedError("NoHumanMember")<{ message: string }> {}

/**
 * The ID of a real (non-bot, active) member of the test workspace — the
 * person a membership or user-group test adds. Read only; it never creates
 * a user.
 */
export const aHuman = Users.listUsers.items({ limit: 200 }).pipe(
  Stream.filter(
    (member) =>
      member.is_bot !== true &&
      member.deleted !== true &&
      member.id !== "USLACKBOT" &&
      member.is_restricted !== true,
  ),
  Stream.runHead,
  Effect.flatMap((found) =>
    found._tag === "Some"
      ? Effect.succeed(found.value.id)
      : Effect.fail(
          new NoHumanMember({ message: "The test workspace has no active human member." }),
        ),
  ),
);

/**
 * Run distilled Slack calls with the profile's credentials, outside a
 * provider test (out-of-band verification).
 */
export const slack = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SlackClient));

const SlackClient = Layer.mergeAll(Slack.fromAuthProvider(), FetchHttpClient.layer).pipe(
  Layer.provideMerge(Slack.SlackAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
);
