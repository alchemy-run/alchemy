import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------- definitions

/** Two different event classes share a tag. */
export class DuplicateEventTag extends Schema.TaggedError<DuplicateEventTag>()(
  "DuplicateEventTag",
  { tag: Schema.String },
) {
  override get message() {
    return `Two different events are tagged '${this.tag}'`;
  }
}

/** Two aggregates, views or streams share a name. */
export class DuplicateName extends Schema.TaggedError<DuplicateName>()("DuplicateName", {
  entity: Schema.String,
}) {
  override get message() {
    return `Two entities are named '${this.entity}'`;
  }
}

/** The Domain lists the same aggregate, policy or projection twice. */
export class DuplicateDefinition extends Schema.TaggedError<DuplicateDefinition>()(
  "DuplicateDefinition",
  { kind: Schema.Literals(["aggregate", "policy", "projection"]), entity: Schema.String },
) {
  override get message() {
    return `Duplicate ${this.kind} '${this.entity}'`;
  }
}

/** An `initial` state its state schema cannot encode. */
export class InvalidInitial extends Schema.TaggedError<InvalidInitial>()("InvalidInitial", {
  owner: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = Predicate.hasProperty(this.cause, "message")
      ? String(this.cause.message)
      : String(this.cause);
    return `${this.owner}.initial does not match its state schema: ${detail}`;
  }
}

/** A view declares state but no `initial`. */
export class MissingInitial extends Schema.TaggedError<MissingInitial>()("MissingInitial", {
  view: Schema.String,
}) {
  override get message() {
    return `${this.view} declares state without initial`;
  }
}

/** A view, policy or projection consumes something the Domain does not list. */
export class UnknownSource extends Schema.TaggedError<UnknownSource>()("UnknownSource", {
  consumer: Schema.String,
  source: Schema.String,
}) {
  override get message() {
    return `${this.consumer} consumes ${this.source}, which is not in the Domain`;
  }
}

/** A view consumes its own output through other views. */
export class ConsumesItself extends Schema.TaggedError<ConsumesItself>()("ConsumesItself", {
  view: Schema.String,
}) {
  override get message() {
    return `${this.view} consumes itself through other views`;
  }
}

/** A consumer keyed differently from its source names no `keyOf` for an event. */
export class MissingKeyOf extends Schema.TaggedError<MissingKeyOf>()("MissingKeyOf", {
  consumer: Schema.String,
  event: Schema.String,
  source: Schema.String,
  /** The aggregate the consumer is keyed by, or undefined for a key schema. */
  keyedBy: Schema.optional(Schema.String),
}) {
  override get message() {
    return `${this.consumer} consumes '${this.event}' from ${this.source}, which is not keyed by ${this.keyedBy ?? "its key schema"}: add keyOf.${this.event}`;
  }
}

/** A routed handler names a route that `keyOf` does not produce. */
export class UnmatchedRoute extends Schema.TaggedError<UnmatchedRoute>()("UnmatchedRoute", {
  view: Schema.String,
  handler: Schema.String,
  source: Schema.String,
  route: Schema.String,
}) {
  override get message() {
    return `${this.view}.${this.handler}.${this.source}.${this.route} has no matching route in keyOf.${this.source}`;
  }
}

/** A consumer subscribes to an event none of its sources emits. */
export class NoEmitter extends Schema.TaggedError<NoEmitter>()("NoEmitter", {
  consumer: Schema.String,
  sources: Schema.Array(Schema.String),
  event: Schema.String,
}) {
  override get message() {
    return `${this.consumer}: none of ${this.sources.join(", ")} emits '${this.event}'`;
  }
}

/** A projection writes a stream the Domain does not list. */
export class UnknownStream extends Schema.TaggedError<UnknownStream>()("UnknownStream", {
  writer: Schema.String,
  stream: Schema.String,
}) {
  override get message() {
    return `${this.writer} writes ${this.stream}, which is not in the Domain`;
  }
}

/** Two projections write the same stream. */
export class TwoWriters extends Schema.TaggedError<TwoWriters>()("TwoWriters", {
  stream: Schema.String,
  first: Schema.String,
  second: Schema.String,
}) {
  override get message() {
    return `${this.stream} has two writers, ${this.first} and ${this.second}: a stream key has exactly one`;
  }
}

/** A projection writes a stream keyed differently from itself. */
export class WriterKeyMismatch extends Schema.TaggedError<WriterKeyMismatch>()(
  "WriterKeyMismatch",
  {
    writer: Schema.String,
    key: Schema.String,
    stream: Schema.String,
    streamKey: Schema.String,
  },
) {
  override get message() {
    return `${this.writer} is keyed by ${this.key}, so it cannot write ${this.stream}, keyed by ${this.streamKey}`;
  }
}

// ---------------------------------------------------------------- runtime

/** An aggregate receives a command it does not list. */
export class UnhandledCommand extends Schema.TaggedError<UnhandledCommand>()("UnhandledCommand", {
  aggregate: Schema.String,
  command: Schema.String,
}) {
  override get message() {
    return `${this.aggregate} does not handle '${this.command}'`;
  }
}

/** An Api exposes a command no aggregate in the Domain handles. */
export class UnroutedCommand extends Schema.TaggedError<UnroutedCommand>()("UnroutedCommand", {
  command: Schema.String,
}) {
  override get message() {
    return `No aggregate in the Domain handles ${this.command}`;
  }
}

/** `decide` returns an event or rejection its command does not declare. */
export class UndeclaredDecision extends Schema.TaggedError<UndeclaredDecision>()(
  "UndeclaredDecision",
  {
    aggregate: Schema.String,
    command: Schema.String,
    returned: Schema.String,
    list: Schema.Literals(["events", "rejects"]),
  },
) {
  override get message() {
    return `${this.aggregate}.decide.${this.command} returned '${this.returned}', which ${this.command} does not declare in ${this.list}`;
  }
}

/** An aggregate commits an event it does not declare. */
export class UndeclaredEvent extends Schema.TaggedError<UndeclaredEvent>()("UndeclaredEvent", {
  aggregate: Schema.String,
  event: Schema.String,
}) {
  override get message() {
    return `${this.aggregate} does not declare event '${this.event}'`;
  }
}

/** A view's `emit` returns an event its `events` do not list. */
export class UndeclaredEmit extends Schema.TaggedError<UndeclaredEmit>()("UndeclaredEmit", {
  view: Schema.String,
  event: Schema.String,
}) {
  override get message() {
    return `${this.view} emitted '${this.event}', which it does not declare in events`;
  }
}

/** A stored event's tag matches no event in the Domain. */
export class UnknownEvent extends Schema.TaggedError<UnknownEvent>()("UnknownEvent", {
  event: Schema.String,
}) {
  override get message() {
    return `Unknown event '${this.event}'`;
  }
}

/** A request carries a context service nothing registered. */
export class UnknownRequestContext extends Schema.TaggedError<UnknownRequestContext>()(
  "UnknownRequestContext",
  { key: Schema.String },
) {
  override get message() {
    return `Unknown request context '${this.key}'`;
  }
}

/** An Api exposes an aggregate that declares no `read` contract. */
export class Unreadable extends Schema.TaggedError<Unreadable>()("Unreadable", {
  aggregate: Schema.String,
}) {
  override get message() {
    return `${this.aggregate} has no \`read\` contract, so an Api cannot expose it`;
  }
}

/** An external system declares an operation named after a static of its class. */
export class ReservedOperation extends Schema.TaggedError<ReservedOperation>()(
  "ReservedOperation",
  { system: Schema.String, operation: Schema.String },
) {
  override get message() {
    return `ExternalSystem '${this.system}' cannot declare an operation named '${this.operation}'`;
  }
}

/** The Domain has sagas, but the platform runs no workflows. */
export class MissingWorkflowEngine extends Schema.TaggedError<MissingWorkflowEngine>()(
  "MissingWorkflowEngine",
  { sagas: Schema.Array(Schema.String) },
) {
  override get message() {
    return `${this.sagas.join(", ")} need a platform that runs workflows`;
  }
}

/** Something other than the stream's writer, handling its input, appends to it. */
export class ForeignAppend extends Schema.TaggedError<ForeignAppend>()("ForeignAppend", {
  stream: Schema.String,
}) {
  override get message() {
    return `Only the projection that lists ${this.stream} in \`writes\` may append to it, with the input it is handling`;
  }
}

/** Every reason a {@link DefinitionError} has. */
export const Reason = Schema.Union([
  DuplicateEventTag,
  DuplicateName,
  DuplicateDefinition,
  InvalidInitial,
  MissingInitial,
  UnknownSource,
  ConsumesItself,
  MissingKeyOf,
  UnmatchedRoute,
  NoEmitter,
  UnknownStream,
  TwoWriters,
  WriterKeyMismatch,
  UnhandledCommand,
  UnroutedCommand,
  UndeclaredDecision,
  UndeclaredEvent,
  UndeclaredEmit,
  UnknownEvent,
  UnknownRequestContext,
  Unreadable,
  ReservedOperation,
  MissingWorkflowEngine,
  ForeignAppend,
]);
export type Reason = typeof Reason.Type;

/**
 * A domain definition error, found while the kernel is built or when a
 * handler returns something its declaration does not allow. Its `reason`
 * says which problem it is: match it with `Effect.catchReason`.
 */
export class DefinitionError extends Schema.TaggedError<DefinitionError>()("DefinitionError", {
  reason: Reason,
}) {
  override get message() {
    return this.reason.message;
  }
}
