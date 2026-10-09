import { Aggregate, Command, Event, Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { CustomerId } from "./CustomerId.ts";

// ── Rejections ──────────────────────────────────────────────────

export class AlreadyRegistered extends Rejection.make("AlreadyRegistered") {}

// ── Events ──────────────────────────────────────────────────────

export class CustomerRegistered extends Event.make("CustomerRegistered", {
  data: { name: Schema.String },
}) {}

// ── Commands ────────────────────────────────────────────────────

export class Register extends Command.make("Register", {
  input: { name: Schema.String },
  rejects: [AlreadyRegistered],
}) {}

export class Customer extends Aggregate.make("Customer", {
  id: CustomerId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Registered", { name: Schema.String }),
  ]),
  initial: { _tag: "New" },
  commands: [Register],
  events: [CustomerRegistered],
  decide: {
    Register: (s, cmd) =>
      s._tag === "Registered"
        ? new AlreadyRegistered()
        : [new CustomerRegistered({ name: cmd.name })],
  },
  evolve: {
    CustomerRegistered: (_, e) => ({ _tag: "Registered" as const, name: e.name }),
  },
}) {}
