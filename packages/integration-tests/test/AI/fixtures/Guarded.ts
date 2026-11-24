import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const Notes = Cloudflare.KV.Namespace("GuardedNotes");

export class Save extends AI.Tool<Save>()("save", {
  description: "Save a note.",
  parameters: Schema.Struct({ key: Schema.String, text: Schema.String }),
  success: Schema.Struct({ saved: Schema.Boolean }),
}) {}

/** Binds the namespace where the tool is built: the plan lists it under `save`. */
export const SaveLive = Save.make(
  Effect.gen(function* () {
    const notes = yield* Cloudflare.KV.ReadWriteNamespace(yield* Notes);
    return Effect.fn(function* ({ key, text }: { readonly key: string; readonly text: string }) {
      yield* notes.put(key, text).pipe(Effect.orDie);
      return { saved: true };
    });
  }),
);

export class Leak extends AI.Tool<Leak>()("leak", {
  description: "Read a note.",
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.Struct({ text: Schema.String }),
}) {}

type Handler = (parameters: unknown) => Effect.Effect<unknown>;

/**
 * Calls each tool's handler over HTTP, the way a harness does: `/save`,
 * `/recall` and `/leak` run a tool, `/direct` reads the namespace outside any tool.
 */
export default class Guarded extends Cloudflare.Worker<Guarded>()(
  "Guarded",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Bound by the Worker, outside any tool.
    const notes = yield* Cloudflare.KV.ReadWriteNamespace(yield* Notes);
    // `leak` closes over that client: its own Layer binds nothing, so the
    // plan lists nothing under it.
    const LeakLive = Leak.make(({ key }: { readonly key: string }) =>
      notes.get(key).pipe(
        Effect.orDie,
        Effect.map((text) => ({ text: text ?? "" })),
      ),
    );
    const [save, leak] = (yield* Effect.all([Save, Leak]).pipe(
      Effect.provide(Layer.mergeAll(SaveLive, LeakLive)),
    )) as unknown as [Handler, Handler];

    // An inline tool that binds the namespace itself.
    const Recall = yield* AI.Tool(
      "recall",
      {
        description: "Read a note.",
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.Struct({ text: Schema.String }),
      },
      Effect.gen(function* () {
        const own = yield* Cloudflare.KV.ReadWriteNamespace(yield* Notes);
        return Effect.fn(function* ({ key }: { readonly key: string }) {
          return { text: (yield* Effect.orDie(own.get(key))) ?? "" };
        });
      }),
    );
    const recall = Recall.handler as unknown as Handler;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://guarded");
        const key = url.searchParams.get("key") ?? "";
        const text = url.searchParams.get("text") ?? "";
        const answer =
          url.pathname === "/direct"
            ? Effect.map(Effect.orDie(notes.get(key)), (found) => ({ text: found ?? "" }))
            : url.pathname === "/save"
              ? save({ key, text })
              : url.pathname === "/recall"
                ? recall({ key })
                : leak({ key });
        const exit = yield* Effect.exit(answer);
        if (Exit.isSuccess(exit)) return yield* HttpServerResponse.json({ ok: exit.value });
        const defect = Cause.squash(exit.cause) as { readonly _tag?: string; message?: string };
        return yield* HttpServerResponse.json({
          failed: { _tag: defect._tag, message: defect.message },
        });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
) {}
