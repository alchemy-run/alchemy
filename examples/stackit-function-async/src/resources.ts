import * as Stackit from "@alchemy.run/stackit";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { Puller, registryFor } from "./registry.ts";

/** The notes, one object per note. A destroy deletes what is left in it. */
export const Files = Stackit.ObjectStorage.Bucket("Files", { forceDestroy: true });

/** The S3 login the handler reads and writes the bucket with. */
export const Group = Stackit.ObjectStorage.CredentialsGroup("NotesGroup", {});

export const Key = Effect.gen(function* () {
  const group = yield* Group;
  return yield* Stackit.ObjectStorage.AccessKey("NotesKey", {
    credentialsGroupId: group.credentialsGroupId,
  });
});

/**
 * The async form: `main` is a plain file with a `fetch` handler, bundled with no
 * Effect runtime. Every `env` entry reaches the handler as a string in its second
 * argument, `Redacted` ones as their value.
 */
export const Notes = Effect.gen(function* () {
  const files = yield* Files;
  const key = yield* Key;
  const puller = yield* Puller;
  const registry = yield* registryFor("notes");
  return yield* Stackit.Functions.Function("Notes", {
    main: "./src/handler.ts",
    registry,
    pullCredential: puller.pullCredentialId,
    env: {
      GREETING: "hello from an async function",
      S3_BUCKET: files.bucketName,
      S3_ENDPOINT: Output.interpolate`https://object.storage.${files.region}.onstackit.cloud`,
      S3_REGION: files.region,
      S3_ACCESS_KEY_ID: key.accessKeyId,
      S3_SECRET_ACCESS_KEY: key.secretAccessKey,
    },
  });
});

export type NotesEnv = Stackit.InferEnv<typeof Notes>;
