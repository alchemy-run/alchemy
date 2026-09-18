import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const resources = Effect.gen(function* () {
  const project = yield* Neon.Project("StorageProject", {
    region: "aws-us-east-2",
  });
  const branch = yield* Neon.Branch("Backend", { project });
  const uploads = yield* Neon.Bucket("Uploads", {
    branch,
    cors: [
      {
        AllowedOrigins: ["http://localhost:5173"],
        AllowedMethods: ["GET", "PUT"],
        AllowedHeaders: ["content-type"],
      },
    ],
    forceDestroy: true,
  });
  const publicAssets = yield* Neon.Bucket("PublicAssets", {
    branch,
    access: "public_read",
    forceDestroy: true,
  });
  const settings = yield* Neon.Object("Settings", {
    bucket: uploads,
    key: "config/settings.json",
    value: { theme: "system", pageSize: 25 },
    schema: Schema.Struct({ theme: Schema.String, pageSize: Schema.Number }),
  });
  yield* Neon.Object("Welcome", {
    bucket: publicAssets,
    key: "welcome.txt",
    body: "Public read, authenticated write.",
    contentType: "text/plain",
  });
  return { branch, uploads, publicAssets, settings };
});
