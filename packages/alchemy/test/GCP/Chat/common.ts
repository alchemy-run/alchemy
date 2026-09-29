import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const runLifecycle = !process.env.FAST && !!process.env.GCP_TEST_CHAT;

export const chatMember = process.env.GCP_TEST_CHAT_MEMBER;

export const runMemberLifecycle = runLifecycle && !!chatMember;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const DEFAULT_EMOJI_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsMtmORP7N4JvYbACS/W8FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywJpKOGW3vVqMQAAAABJRU5ErkJggg==";
