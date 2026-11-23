import * as Cloudflare from "@alchemy.run/cloudflare";
import type { DurableObjectServices } from "@alchemy.run/cloudflare/Workers/DurableObject";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HarnessError, type SendOptions } from "../Harness.ts";
import {
  NotStarted,
  Router,
  structOf,
  type AnyInput,
  type ProcessClient as Client,
  type ProcessService,
  type Session,
  type StartOptions,
} from "../Process.ts";

/** A process tag, as a host lists it. */
export interface HostedProcess {
  readonly key: string;
  readonly processName: string;
  readonly inputs: ReadonlyArray<AnyInput>;
}

type ServicesOf<Processes extends ReadonlyArray<HostedProcess>> = Processes[number] extends infer P
  ? P extends Context.Key<infer Service, any>
    ? Service
    : never
  : never;

/** What a call to the host came to, in a form that crosses the call. */
export type Outcome<A> =
  | { readonly outcome: "ok"; readonly value: A }
  | { readonly outcome: "not-started"; readonly process: string; readonly key: string }
  | { readonly outcome: "failed"; readonly message: string };

/** What is sent with a message, in a form that crosses the call. */
export interface Sent {
  readonly requestId?: string;
  readonly model?: string;
}

const sentOf = (options: SendOptions | StartOptions | undefined): Sent => ({
  ...(options !== undefined && "requestId" in options && options.requestId !== undefined
    ? { requestId: options.requestId }
    : {}),
  ...(options?.model === undefined ? {} : { model: options.model.modelName }),
});

const outcomeOf = <A, R>(
  effect: Effect.Effect<A, NotStarted | HarnessError, R>,
): Effect.Effect<Outcome<A>, never, R> =>
  effect.pipe(
    Effect.map((value): Outcome<A> => ({ outcome: "ok", value })),
    Effect.catchTags({
      NotStarted: ({ process, key }) =>
        Effect.succeed<Outcome<A>>({ outcome: "not-started", process, key }),
      HarnessError: ({ message }) => Effect.succeed<Outcome<A>>({ outcome: "failed", message }),
    }),
  );

/** A host's Layer with what it is given: the hosted processes it asked for are among them. */
const closed = <A, R>(
  layer: Layer.Layer<A, never, any>,
  given: [Layer.Layer<any, never, any>, ...Array<Layer.Layer<any, never, any>>],
): Layer.Layer<A, never, R> => Layer.provide(layer, given) as Layer.Layer<A, never, R>;

/** The Durable Object namespace of a process host, with the processes it runs. */
export interface ProcessHostClass<Processes extends ReadonlyArray<HostedProcess>> {
  readonly processes: Processes;
}

/**
 * A Durable Object that runs processes: one object per session, with the
 * session's harness, transcript and wake-ups on that object's storage.
 * `layer` gives each listed process its prose and everything the prose
 * mentions, with a harness (`Pi.HarnessLive`, `OpenCode.HarnessLive`).
 * Whatever else in it asks for one of the processes, such as a Domain
 * policy that starts sessions, is given the host's own client.
 *
 * Anything else reaches the sessions through `AICloudflare.ProcessClient`.
 *
 * **Example:** A host for two processes
 * ```typescript
 * export default class Agents extends AICloudflare.ProcessHost<Agents>()(
 *   "Agents",
 *   { processes: [Triage, Engineer] },
 *   Layer.mergeAll(TriageLive, EngineerLive).pipe(
 *     Layer.provide(
 *       Layer.mergeAll(
 *         Pi.HarnessLive,
 *         PiCloudflare.DurableObjectStorage,
 *         Pi.CodingTools,
 *         AI.DefaultModel(Smart),
 *         ModelsLive,
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 */
export const ProcessHost =
  <Self>() =>
  <
    const Processes extends ReadonlyArray<HostedProcess>,
    R extends DurableObjectServices | ServicesOf<Processes> = never,
  >(
    name: string,
    options: {
      /** Every process this host runs. */
      readonly processes: Processes;
    },
    /**
     * Each process's prose, and everything it mentions. Whatever else in it
     * asks for one of the processes (a Domain policy that starts sessions)
     * is given the host's own client.
     */
    layer: Layer.Layer<ServicesOf<Processes>, never, R>,
  ) => {
    const impl = Effect.gen(function* () {
      const clients = new Map<
        string,
        { readonly process: HostedProcess; readonly client: ProcessService<any> }
      >();
      for (const process of options.processes) {
        const client = yield* Effect.service(
          process as unknown as Context.Key<ServicesOf<Processes>, ProcessService<any>>,
        );
        clients.set(process.processName, { process, client });
      }
      const hosted = (process: string) =>
        Effect.suspend(() => {
          const found = clients.get(process);
          return found === undefined
            ? Effect.fail(new HarnessError({ message: `${name} does not run ${process}.` }))
            : Effect.succeed(found);
        });
      const optionsOf = (sent: Sent, client: ProcessService<any>) =>
        Effect.suspend(() => {
          const model = sent.model === undefined ? undefined : client["~models"]?.get(sent.model);
          return sent.model !== undefined && model === undefined
            ? Effect.fail(new HarnessError({ message: `There is no model named ${sent.model}.` }))
            : Effect.succeed({
                ...(sent.requestId === undefined ? {} : { requestId: sent.requestId }),
                ...(model === undefined ? {} : { model }),
              });
        });
      const session = <A>(
        process: string,
        key: string,
        use: (
          session: Session,
          client: ProcessService<any>,
        ) => Effect.Effect<A, NotStarted | HarnessError>,
      ) => outcomeOf(Effect.flatMap(hosted(process), ({ client }) => use(client.get(key), client)));

      return Effect.succeed({
        start: (process: string, key: string, input: unknown, sent: Sent) =>
          outcomeOf(
            Effect.gen(function* () {
              const found = yield* hosted(process);
              const decoded = yield* Schema.decodeUnknownEffect(
                structOf(found.process.inputs) as unknown as Schema.Codec<unknown, unknown>,
              )(input).pipe(
                Effect.mapError(
                  (cause) =>
                    new HarnessError({
                      message: `The inputs of ${process} did not decode: ${String(cause)}`,
                      cause,
                    }),
                ),
              );
              yield* found.client.start(key, decoded, yield* optionsOf(sent, found.client));
            }),
          ),
        send: (process: string, key: string, text: string, sent: Sent) =>
          session(process, key, (each, client) =>
            Effect.flatMap(optionsOf(sent, client), (options) => each.send(text, options)),
          ),
        prompt: (process: string, key: string, text: string, sent: Sent) =>
          session(process, key, (each, client) =>
            Effect.flatMap(optionsOf(sent, client), (options) => each.prompt(text, options)),
          ),
        wait: (process: string, key: string) => session(process, key, (each) => each.wait),
        abort: (process: string, key: string) => session(process, key, (each) => each.abort),
        messages: (process: string, key: string) => session(process, key, (each) => each.messages),
      });
    }).pipe(
      Effect.provide(
        closed<
          ServicesOf<Processes>,
          | Exclude<R, ServicesOf<Processes>>
          | Cloudflare.DurableObjectScope
          | Cloudflare.DurableObjectState
        >(layer, [
          // What asks for a hosted process without its prose reaches the session's own object.
          Layer.effectContext(
            Effect.map(Cloudflare.DurableObjectScope, (namespace) =>
              clientsOf(namespace, options.processes),
            ),
          ) as Layer.Layer<ServicesOf<Processes>, never, Cloudflare.DurableObjectScope>,
          // A session another session starts gets an object of its own.
          Layer.effect(
            Router,
            Effect.gen(function* () {
              const namespace = yield* Cloudflare.DurableObjectScope;
              const state = yield* Cloudflare.DurableObjectState;
              const hosted = new Set(options.processes.map((process) => process.processName));
              return {
                route: (process, inputs, local) => {
                  if (!hosted.has(process)) return local;
                  const remote = remoteClient(namespace, process, inputs);
                  const here = (key: string) =>
                    (state.raw as { readonly id?: { readonly name?: string } } | undefined)?.id
                      ?.name === objectName(process, key);
                  return {
                    start: (key: string, ...args: [input?: unknown, options?: StartOptions]) =>
                      (here(key) ? local : remote).start(key, ...args),
                    get: (key: string) => (here(key) ? local : remote).get(key),
                  };
                },
              };
            }),
          ),
        ]),
      ),
    );
    return Object.assign(Cloudflare.DurableObject<Self>()(name, impl), {
      processes: options.processes,
    });
  };

/** The methods of a process host, as its callers see them. */
interface HostStub {
  readonly start: (
    process: string,
    key: string,
    input: unknown,
    sent: Sent,
  ) => Effect.Effect<Outcome<void>, unknown, unknown>;
  readonly send: (
    process: string,
    key: string,
    text: string,
    sent: Sent,
  ) => Effect.Effect<Outcome<void>, unknown, unknown>;
  readonly prompt: (
    process: string,
    key: string,
    text: string,
    sent: Sent,
  ) => Effect.Effect<Outcome<{ readonly text: string }>, unknown, unknown>;
  readonly wait: (process: string, key: string) => Effect.Effect<Outcome<void>, unknown, unknown>;
  readonly abort: (process: string, key: string) => Effect.Effect<Outcome<void>, unknown, unknown>;
  readonly messages: (
    process: string,
    key: string,
  ) => Effect.Effect<Outcome<ReadonlyArray<unknown>>, unknown, unknown>;
}

/** A host's namespace: an object per session. */
interface Namespace {
  readonly getByName: (name: string) => unknown;
}

/** The name of a session's object. */
const objectName = (process: string, key: string) => `${process}/${key}`;

/** A call's outcome, as the error or value it stands for. */
const result = <A>(
  call: Effect.Effect<Outcome<A>, unknown, unknown>,
): Effect.Effect<A, NotStarted | HarnessError> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- a stub's call needs nothing the caller has not got
  (call as Effect.Effect<Outcome<A>, unknown>).pipe(
    Effect.mapError(
      (cause) => new HarnessError({ message: "The call to the process host failed", cause }),
    ),
    Effect.flatMap((outcome): Effect.Effect<A, NotStarted | HarnessError> =>
      outcome.outcome === "ok"
        ? Effect.succeed(outcome.value)
        : outcome.outcome === "not-started"
          ? Effect.fail(new NotStarted({ process: outcome.process, key: outcome.key }))
          : Effect.fail(new HarnessError({ message: outcome.message })),
    ),
  );

/** A start cannot be told it never started. */
const started = <A>(effect: Effect.Effect<A, NotStarted | HarnessError>) =>
  Effect.catchTag(effect, "NotStarted", ({ process, key }) =>
    Effect.fail(new HarnessError({ message: `${process}/${key} did not start.` })),
  );

/** A process's client that calls each session's own object. */
const remoteClient = (
  namespace: Namespace,
  name: string,
  inputs: ReadonlyArray<AnyInput>,
): Client<any> => {
  const stub = (key: string) => namespace.getByName(objectName(name, key)) as HostStub;
  const codec = structOf(inputs) as unknown as Schema.Codec<unknown, unknown>;
  return {
    start: (key: string, input?: unknown, options?: StartOptions) =>
      Schema.encodeUnknownEffect(codec)(input ?? {}).pipe(
        Effect.mapError(
          (cause) =>
            new HarnessError({
              message: `The inputs of ${name} did not encode: ${String(cause)}`,
              cause,
            }),
        ),
        Effect.flatMap((encoded) =>
          stub(key).start(name, key, encoded, sentOf(options)).pipe(result, started),
        ),
      ),
    get: (key) => ({
      send: (text, options) => result(stub(key).send(name, key, text, sentOf(options))),
      prompt: (text, options) => result(stub(key).prompt(name, key, text, sentOf(options))),
      wait: stub(key).wait(name, key).pipe(result, started),
      abort: stub(key).abort(name, key).pipe(result, started),
      messages: stub(key).messages(name, key).pipe(result, started),
    }),
  };
};

/** Every listed process, as a client that calls each session's own object. */
const clientsOf = (namespace: Namespace, processes: ReadonlyArray<HostedProcess>) =>
  processes.reduce(
    (context, process) =>
      Context.add(
        context,
        process as unknown as Context.Key<unknown, ProcessService<any>>,
        remoteClient(namespace, process.processName, process.inputs),
      ),
    Context.empty() as Context.Context<unknown>,
  );

/**
 * Reach the processes a host runs from anywhere else in its Worker: a
 * policy, a route, another Durable Object. Provides every process the host
 * lists, each as a client that calls the session's own object.
 *
 * **Example:** A Worker whose policies start sessions
 * ```typescript
 * const Live = BoardLive.pipe(Layer.provide(AICloudflare.ProcessClient(Agents)));
 * ```
 */
export const ProcessClient = <Processes extends ReadonlyArray<HostedProcess>, R>(
  host: ProcessHostClass<Processes> & Effect.Effect<Namespace, never, R>,
): Layer.Layer<ServicesOf<Processes>, never, R> =>
  Layer.effectContext(
    Effect.map(host, (namespace) => clientsOf(namespace, host.processes)),
  ) as Layer.Layer<ServicesOf<Processes>, never, R>;
