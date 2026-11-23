# alchemy-bend: the pieces every aggregate shares.
#
# An aggregate is a module with a state, a command, an event and a rejection
# type, and two functions. decide answers a command with the events it
# records or a rejection, given a context (who asks, and when). evolve
# applies one event to the state. The templates here take those two
# functions and give back the rest.

import Base

# What decide answers.
type Decided<-E: Data, -R: Data> is Data:
  Reject{why: R}
  Record{events: +List<E>}

# A command with the context it is sent in.
type Sent<-X: Data, -C: Data> is Data:
  Sent{context: X, command: C}

# The state after every event, in order, all recorded in one context.
def apply(~X: Data, ~S: Data, ~E: Data, ~evolve: X -> S -> E -> S, events: +List<E>, +context: X, state: S) -> S:
  match events:
    case Nil{}:
      state
    case e <> es:
      apply(~X, ~S, ~E, ~evolve, es, context, evolve(context, state, e))

# The state a decision leaves: unchanged when the command is rejected.
def settle(~X: Data, ~S: Data, ~E: Data, ~R: Data, ~evolve: X -> S -> E -> S, +context: X, +state: S, decided: Decided<E, R>) -> S:
  match decided:
    case Reject{why}:
      state
    case Record{events}:
      apply(~X, ~S, ~E, ~evolve, events, context, state)

# The state after one command.
def step(
  ~X: Data, ~S: Data, ~C: Data, ~E: Data, ~R: Data,
  ~decide: X -> S -> C -> Decided<E, R>, ~evolve: X -> S -> E -> S,
  +context: X, +state: S, command: C
) -> S:
  settle(~X, ~S, ~E, ~R, ~evolve, context, state, decide(context, state, command))

# The state after every command, in order.
def replay(
  ~X: Data, ~S: Data, ~C: Data, ~E: Data, ~R: Data,
  ~decide: X -> S -> C -> Decided<E, R>, ~evolve: X -> S -> E -> S,
  commands: List<Sent<X, C>>, +state: S
) -> S:
  match commands:
    case Nil{}:
      state
    case Sent{+context, command} <> rest:
      replay(~X, ~S, ~C, ~E, ~R, ~decide, ~evolve, rest,
        step(~X, ~S, ~C, ~E, ~R, ~decide, ~evolve, context, state, command))
