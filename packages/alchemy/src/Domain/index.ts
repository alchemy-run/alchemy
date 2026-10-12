/**
 * Model a domain from commands, events and rejections; aggregates that decide;
 * views that fold; and policies that react. Expose it to clients as an Api,
 * and host it on whichever Platform Layer is provided.
 *
 * ```typescript
 * import * as Domain from "alchemy/Domain";
 *
 * export class MoneyDeposited extends Domain.Event("MoneyDeposited", {
 *   data: { amount: Cents, balanceAfter: Cents },
 * }) {}
 * ```
 *
 * Every building block is `Domain.<Noun>(...)`, and its types live on the
 * same name: `Domain.Event.Any`, `Domain.Aggregate.StateOf<typeof Account>`.
 * Stories (given / when / then specifications) are in `alchemy/Domain/Story`;
 * the Cloudflare platform is in `alchemy/Domain/Cloudflare`.
 */
import * as AggregateModule from "./Aggregate.ts";
import * as ApiModule from "./Api.ts";
import * as CommandModule from "./Command.ts";
import * as EventModule from "./Event.ts";
import * as ModelModule from "./Model.ts";
import * as PolicyModule from "./Policy.ts";
import * as PortModule from "./Port.ts";
import * as RejectionModule from "./Rejection.ts";
import * as RequestContextModule from "./RequestContext.ts";
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
  /** The instance type of a class. */
  export type Inst<C> = AggregateModule.Inst<C>;
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
  export type Trigger<From extends ViewModule.Source, E> = PolicyModule.Trigger<From, E>;
}
/** A reaction to events that sends commands and calls ports. See {@link PolicyModule.make}. */
export const Policy = PolicyModule.make;

export declare namespace Port {
  /** Any Port class. */
  export type Any = PortModule.Any;
  export type Op<Args = unknown, Success = unknown> = PortModule.Op<Args, Success>;
}
/** A typed boundary to the outside world, implemented by a Layer. See {@link PortModule.make}. */
export const Port = PortModule.make;

export declare namespace Api {
  /** What an Api may expose: commands, views, and aggregates with a `read` contract. */
  export type Entry = ApiModule.Entry;
  /** The typed client of an Api. */
  export type Client<E extends ApiModule.Entry> = ApiModule.ApiClient<E>;
  /** Type-level identity of an Api's client service, e.g. `Domain.Api.ClientKey<"BankApi">`. */
  export type ClientKey<Name extends string> = ApiModule.ClientKey<Name>;
  export type ViewClient<V extends ViewModule.Any> = ApiModule.ViewClient<V>;
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
/** The aggregates, views and policies hosted together. See {@link ModelModule.make}. */
export const Model = ModelModule.make;

/** A service middleware provides to a request, carried into the domain. See {@link RequestContextModule.make}. */
export const RequestContext = RequestContextModule.make;

export type { Filter, OrderBy } from "./Filter.ts";
export { InMemory } from "./InMemory.ts";
export type * as Middleware from "./Middleware.ts";
export { Platform } from "./Platform.ts";
export type * as Read from "./Read.ts";
