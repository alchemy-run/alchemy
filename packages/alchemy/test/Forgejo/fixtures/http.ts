import * as Forgejo from "alchemy/Forgejo";
import * as Layer from "effect/Layer";

export const HttpBindings = Layer.mergeAll(
  Forgejo.ReadRepositoryHttp,
  Forgejo.WriteRepositoryHttp,
  Forgejo.ReadWriteRepositoryHttp,
  Forgejo.ReadIssuesHttp,
  Forgejo.WriteIssuesHttp,
  Forgejo.ReadWriteIssuesHttp,
);
