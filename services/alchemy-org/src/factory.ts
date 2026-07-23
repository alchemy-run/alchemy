/**
 * The Factory desk — the resource-factory coordinator: the flywheel
 * from the blog post (catalog → implement → live test → patch →
 * report) as a process. A WAVE fans services out to
 * {@link ResourceEngineer} runs — one run owns one distilled service,
 * the unit of isolation that keeps patch directories and generator
 * runs race-free — with the fleet cap AGENTS.md prescribes (~12; the
 * coordinator, not the agents, owns type-checking at wave boundaries).
 *
 * The ORDER BOOK is the desk's Shape: every service's banked outcome —
 * the typed {@link ServiceReport} an engineer filed, its typed
 * refusal, or its crash. Completed results are banked as they land,
 * so a wave that dies mid-flight loses only its in-flight services
 * (crash resilience: engineers are charged to assess-first and FINISH
 * partial work).
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import {
  ResourceEngineer,
  type ServiceReport,
} from "./resource-engineer.ts";

/** One service's banked outcome in the order book. */
export interface WaveEntry {
  readonly service: string;
  readonly status: "running" | "reported" | "refused" | "crashed";
  /** The engineer's typed exit, when status is "reported". */
  readonly report?: ServiceReport;
  /** The refusal or crash, when the run did not report. */
  readonly error?: string;
}

/** What the org may ask of the Factory from code. */
export interface FactoryService {
  /**
   * Run one WAVE: every service through its own ResourceEngineer run,
   * at most `concurrency` (≤ 12) in flight. Resolves when the wave
   * settles, with each service's banked outcome.
   */
  readonly wave: (
    services: ReadonlyArray<string>,
    options?: { readonly concurrency?: number },
  ) => Effect.Effect<ReadonlyArray<WaveEntry>, never, RuntimeContext>;
  /** The order book: every banked outcome so far. */
  readonly orderBook: () => Effect.Effect<ReadonlyArray<WaveEntry>>;
}

export class Factory extends Context.Service<Factory, FactoryService>()(
  "alchemy-org/Factory",
) {}

/**
 * The implementation: resolve the engineer's actor, fan a wave out
 * with the fleet cap, bank every outcome — a report is banked from
 * the dispatch's typed resolution, a refusal or crash from its cause.
 */
export const FactoryLive = Layer.effect(
  Factory,
  Effect.gen(function* () {
    const engineers = yield* ResourceEngineer;
    const book = yield* Ref.make<ReadonlyMap<string, WaveEntry>>(new Map());

    const bank = (entry: WaveEntry) =>
      Ref.update(book, (entries) =>
        new Map(entries).set(entry.service, entry),
      );

    const run = (service: string) =>
      Effect.gen(function* () {
        yield* bank({ service, status: "running" });
        const exit = yield* Effect.exit(
          engineers.dispatch(
            `You own the distilled service "${service}" for this run. ` +
              `Bring its resources and live tests to green — assess ` +
              `existing work first — and file your service report.`,
            { key: `factory/${service}` },
          ),
        );
        const entry: WaveEntry = Exit.isSuccess(exit)
          ? {
              service,
              status: "reported",
              report: exit.value as ServiceReport,
            }
          : (() => {
              const squashed = Cause.squash(exit.cause);
              return {
                service,
                status:
                  (squashed as { _tag?: string })?._tag === "AI.Refused"
                    ? ("refused" as const)
                    : ("crashed" as const),
                error: String(squashed),
              };
            })();
        yield* bank(entry);
        return entry;
      });

    return {
      wave: (services, options) =>
        Effect.forEach(services, run, {
          concurrency: Math.min(options?.concurrency ?? 12, 12),
        }),
      orderBook: () =>
        Ref.get(book).pipe(Effect.map((entries) => [...entries.values()])),
    };
  }),
);
