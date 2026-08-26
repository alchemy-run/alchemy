import * as ChildProcess from "node:child_process";
import * as Effect from "effect/Effect";

export const CHAT_TRANSCRIPT = JSON.stringify({
  entries: [
    {
      start_timestamp_usec: 1_000_000,
      text: "Hello, how can I help you today?",
      role: "AGENT",
      user_id: 1,
    },
    {
      start_timestamp_usec: 5_000_000,
      text: "I want to check my billing.",
      role: "CUSTOMER",
      user_id: 2,
    },
  ],
});

const accessToken = Effect.sync(() => {
  const fromEnv = process.env.GOOGLE_ACCESS_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return ChildProcess.execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
    env: process.env,
  }).trim();
});

export const uploadChatTranscript = (bucketName: string) =>
  Effect.gen(function* () {
    const token = yield* accessToken;
    const project = process.env.GOOGLE_PROJECT_ID ?? "";
    yield* Effect.tryPromise({
      try: () =>
        fetch(
          `https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(project)}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: bucketName,
              location: "US-CENTRAL1",
            }),
          },
        ),
      catch: (error) =>
        new Error(`transcript bucket create failed: ${String(error)}`),
    });
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          `https://storage.googleapis.com/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=transcript.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: CHAT_TRANSCRIPT,
          },
        ),
      catch: (error) => new Error(`transcript upload failed: ${String(error)}`),
    });
    if (!response.ok) {
      return yield* Effect.die(
        new Error(`transcript upload failed with HTTP ${response.status}`),
      );
    }
  });
