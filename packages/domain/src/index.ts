/**
 * Model a domain from commands, events and rejections; aggregates that decide;
 * views that fold; and policies that react. Expose it to clients as an Api,
 * and host it on whichever Platform Layer is provided.
 *
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 *
 * export class MoneyDeposited extends Domain.Event("MoneyDeposited", {
 *   amount: Cents,
 *   balanceAfter: Cents,
 * }) {}
 * ```
 *
 * Every building block is `Domain.<Noun>(...)`, and its types live on the
 * same name: `Domain.Event.Any`, `Domain.Aggregate.StateOf<typeof Account>`.
 * Stories (given / when / then specifications) are in `@alchemy.run/domain/Story`;
 * the Cloudflare platform is in `@alchemy.run/cloudflare/Domain`.
 */
import * as AggregateModule from "./Aggregate.ts";
import * as ApiModule from "./Api.ts";
import * as CommandModule from "./Command.ts";
import * as EventModule from "./Event.ts";
import * as ExternalSystemModule from "./ExternalSystem.ts";
import * as ModelModule from "./Model.ts";
import * as PolicyModule from "./Policy.ts";
import * as ProjectionModule from "./Projection.ts";
import * as RejectionModule from "./Rejection.ts";
import * as RequestContextModule from "./RequestContext.ts";
import * as SagaModule from "./Saga.ts";
import * as StreamModule from "./Stream.ts";
import * as ViewModule from "./View.ts";

export declare namespace Event {
  /** Any Event class. */
  export type Any = EventModule.Any;
  /** An event value: its `_tag` plus its data. */
  export type Instance<Tag extends string, F extends EventModule.Fields> = EventModule.Instance<
    Tag,
    F
  >;
}
/** A fact the domain recorded. See {@link EventModule.make}. */
export const Event = EventModule.make;

export declare namespace Command {
  /** Any Command class. */
  export type Any = CommandModule.Any;
  export type Instance<Tag extends string, F extends EventModule.Fields> = CommandModule.Instance<
    Tag,
    F
  >;
  /** The services a command's middleware provides to `decide`. */
  export type ContextOf<C extends CommandModule.Any> = CommandModule.ContextOf<C>;
}
/** A request to change one aggregate. See {@link CommandModule.make}. */
export const Command = CommandModule.make;

export declare namespace Rejection {
  /** Any Rejection class. */
  export type Any = RejectionModule.Any;
  export type Instance<Tag extends string, F extends EventModule.Fields> = RejectionModule.Instance<
    Tag,
    F
  >;
}
/** A typed reason a command or read was refused. See {@link RejectionModule.make}. */
export const Rejection = RejectionModule.make;

export declare namespace Aggregate {
  /** Any Aggregate class. */
  export type Any = AggregateModule.Any;
  export type IdOf<A extends AggregateModule.Any> = AggregateModule.IdOf<A>;
  export type StateOf<A extends AggregateModule.Any> = AggregateModule.StateOf<A>;
  export type EventOf<A extends AggregateModule.Any> = AggregateModule.EventOf<A>;
  export type CommandOf<A extends AggregateModule.Any> = AggregateModule.CommandOf<A>;
  /** A reference to one instance of an aggregate. */
  export type Ref<A extends AggregateModule.Any = AggregateModule.Any> = AggregateModule.Ref<A>;
  /** What an accepted command returns: its stream, version, events and reply. */
  export type Receipt<Ev = unknown, Reply = unknown> = AggregateModule.Receipt<Ev, Reply>;
  /** Where an event sits: its instance, stream, sequence, time and command. */
  export type Envelope<Id = string> = AggregateModule.Envelope<Id>;
  export type SendOptions = AggregateModule.SendOptions;
  export type ScheduleOptions = AggregateModule.ScheduleOptions;
  /** The instance type of a class: `InstanceOf<typeof NotOwner>` is `NotOwner`. */
  export type InstanceOf<C> = AggregateModule.InstanceOf<C>;
}
/** A consistency boundary that decides commands. See {@link AggregateModule.make}. */
export const Aggregate = AggregateModule.make;

export declare namespace View {
  /** Any View class. */
  export type Any = ViewModule.Any;
  export type StateOf<V extends ViewModule.Any> = ViewModule.StateOf<V>;
  export type EventOf<V extends ViewModule.Any> = ViewModule.EventOf<V>;
  export type KeyOf<V extends ViewModule.Any> = ViewModule.KeyOf<V>;
  /** An event a view emitted, with its state after it. */
  export type Entry<S, E, Id = string> = ViewModule.Entry<S, E, Id>;
  export type Page<E> = ViewModule.Page<E>;
  /** A key's state and the cursor it is valid at. */
  export type Snapshot<S> = ViewModule.Snapshot<S>;
}
/** A read model folded from events, per key. See {@link ViewModule.make}. */
export const View = ViewModule.make;
/** A view read waited longer than allowed. */
export const WaitTimeout = ViewModule.WaitTimeout;
export type WaitTimeout = ViewModule.WaitTimeout;
/** A view did not catch up to a write in time. */
export const ConsistencyTimeout = ViewModule.ConsistencyTimeout;
export type ConsistencyTimeout = ViewModule.ConsistencyTimeout;

export declare namespace Policy {
  /** Any Policy class. */
  export type Any = PolicyModule.Any;
  /** What a policy reacts to: the event, its source and the source's state. */
  export type Trigger<From extends PolicyModule.From, E> = PolicyModule.Trigger<From, E>;
}
/** A standing business rule: on an event, decide what to do next. See {@link PolicyModule.make}. */
export const Policy = PolicyModule.make;

export declare namespace Saga {
  /** Any Saga class. */
  export type Any = SagaModule.Any;
  /** Where a saga run is. */
  export type Status<A, E> = SagaModule.Status<A, E>;
  /** A saga's client. */
  export type Client<Key, Input, A, E> = SagaModule.Client<Key, Input, A, E>;
}
/** A process that spans aggregates and takes time, run as an Effect workflow. See {@link SagaModule.make}. */
export const Saga = SagaModule.make;

export declare namespace Projection {
  /** Any Projection class. */
  export type Any = ProjectionModule.Any;
  /** One input a projection's handler receives. */
  export type Input<Key extends AggregateModule.Any, S, E> = ProjectionModule.Input<Key, S, E>;
  /** How a projection's Layer tunes it. */
  export type Options = ProjectionModule.Options;
}
/** Consumes events into a store you own, in order per key; replayable, never sends commands. See {@link ProjectionModule.make}. */
export const Projection = ProjectionModule.make;

export declare namespace Stream {
  /** Any Stream class. */
  export type Any = StreamModule.Any;
  export type EventOf<S extends StreamModule.Any> = StreamModule.EventOf<S>;
  export type KeyOf<S extends StreamModule.Any> = StreamModule.KeyOf<S>;
  /** One entry of a stream key. */
  export type Entry<E, Id = string> = StreamModule.Entry<E, Id>;
}
/** A keyed, append-only, replayable log a projection writes and clients read. See {@link StreamModule.make}. */
export const Stream = StreamModule.make;

export declare namespace ExternalSystem {
  /** Any ExternalSystem class. */
  export type Any = ExternalSystemModule.Any;
  export type Op<Args = unknown, Success = unknown, Error = unknown> = ExternalSystemModule.Op<
    Args,
    Success,
    Error
  >;
}
/** An outside system the model calls, as an Effect service. See {@link ExternalSystemModule.make}. */
export const ExternalSystem = ExternalSystemModule.make;

export declare namespace Api {
  /** What an Api may expose: commands, views, and aggregates with a `read` contract. */
  export type Entry = ApiModule.Entry;
  /** The typed client of an Api. */
  export type Client<E extends ApiModule.Entry> = ApiModule.ApiClient<E>;
  /** Type-level identity of an Api's client service, e.g. `Domain.Api.ClientKey<"BankApi">`. */
  export type ClientKey<Name extends string> = ApiModule.ClientKey<Name>;
  export type ViewClient<V extends ViewModule.Any> = ApiModule.ViewClient<V>;
  export type StreamClient<S extends StreamModule.Any> = ApiModule.StreamClient<S>;
  export type AggregateClient<A extends AggregateModule.Any> = ApiModule.AggregateClient<A>;
  /** Everything a read can fail with. */
  export type ReadError<D> = ApiModule.ReadError<D>;
}
/** The public surface of a domain for one client. See {@link ApiModule.make}. */
export const Api = ApiModule.make;
/** An Api client protocol: everything over HTTP, live reads as streamed responses. */
export const protocolHttp = ApiModule.protocolHttp;
/** An Api client protocol: calls over HTTP, each live read a WebSocket to the object that owns it. */
export const protocolWebSocket = ApiModule.protocolWebSocket;

export declare namespace Model {
  /** Any Model class. */
  export type Any = ModelModule.Any;
}
/** The aggregates, views, policies, projections and streams hosted together. See {@link ModelModule.make}. */
export const Model = ModelModule.make;

/** Every definition problem in a Model, without hosting it. See {@link ModelModule.verify}. */
export const verify = ModelModule.verify;
/** A problem in a Model's definitions, found by {@link verify} or when its Layer is built. */
export { DefinitionError } from "./Kernel.ts";

/** A service middleware provides to a request, carried into the domain. See {@link RequestContextModule.make}. */
export const RequestContext = RequestContextModule.make;

export type { Filter, OrderBy } from "./Filter.ts";
export { InMemory } from "./InMemory.ts";
export type * as Middleware from "./Middleware.ts";
export { Platform } from "./Platform.ts";
export type * as Read from "./Read.ts";
/** Trace attributes, hosting options and the metrics a model records. */
export * as Telemetry from "./Telemetry.ts";
