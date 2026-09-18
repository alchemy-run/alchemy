import * as Forgejo from "@/Forgejo/index.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Lambda from "@/AWS/Lambda/index.ts";
import type * as API from "@distilled.cloud/forgejo/repository";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Get = ReturnType<Forgejo.ReadRepositoryClient["get"]>;
type _Runtime = Assert<Equal<Effect.Services<Get>, RuntimeContext>>;
type _Response = Assert<
  Equal<Effect.Success<Get>, Effect.Success<ReturnType<typeof API.getRepo>>>
>;
type _Errors = Assert<
  Equal<Effect.Error<Get>, Effect.Error<ReturnType<typeof API.getRepo>>>
>;

const contracts = (repository: Forgejo.Repository) =>
  Effect.gen(function* () {
    const read = yield* Forgejo.ReadRepository(repository);
    const write = yield* Forgejo.WriteRepository(repository);
    const both = yield* Forgejo.ReadWriteRepository(repository);
    const issues = yield* Forgejo.ReadWriteIssues(repository);
    yield* Forgejo.ReadRepository(repository, {
      token: Config.Redacted("EXTERNAL_TOKEN"),
      credentialId: "external-reader",
    });
    // @ts-expect-error External tokens require a stable, non-secret identity.
    Forgejo.ReadRepository(repository, {
      token: Config.Redacted("EXTERNAL_TOKEN"),
    });
    // @ts-expect-error The target is bound once, not accepted per request.
    read.get({ owner: "other", repo: "other" });
    // @ts-expect-error A read-only client has no mutation methods.
    read.createFile({ filepath: "file", content: "" });
    // @ts-expect-error A write-only client has no read methods.
    write.get();
    both.getContent({ filepath: "README.md" });
    issues.createComment({ index: 1, body: "hello" });
    yield* Forgejo.RepositoryEventSource(
      repository,
      { events: ["push"] },
      (event) => {
        const ref: string = event.payload.ref;
        // @ts-expect-error Event selection excludes issue payloads.
        event.payload.issue;
        return Effect.void;
      },
    );
    yield* Forgejo.RepositoryEventSource(
      repository,
      { events: ["issues"] },
      (event) => {
        const number: number = event.payload.issue.number;
        // @ts-expect-error Event selection excludes push payloads.
        event.payload.ref;
        return Effect.void;
      },
    );
  });

Layer.mergeAll(Cloudflare.ForgejoBindings);
Layer.mergeAll(Lambda.ForgejoBindings);
