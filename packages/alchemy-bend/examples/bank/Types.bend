# What the whole bank shares. Ids are numbers. Money is whole cents and time is
# whole seconds, both 32-bit: a sum past 4,294,967,295 wraps.

import Base

# Who is acting.
type Actor is Data:
  ByCustomer{id: Nat}
  ByAgent{id: Nat}
  BySystem{id: Nat}

# What a decision is made with: who asks, and on what day.
type Context is Data:
  Context{actor: Actor, day: U32}

def is_agent(actor: Actor) -> Bool:
  match actor:
    case ByAgent{id}:
      True{}
    case _:
      False{}

# Customers act on what is theirs; agents and the system on anything.
def may_act(actor: Actor, owner: Nat) -> Bool:
  match actor:
    case ByCustomer{id}:
      Nat.is_eq(id, owner)
    case _:
      True{}

def day_of(context: Context) -> U32:
  match context:
    case Context{actor, day}:
      day

# The day a moment falls on.
def day(now: U32) -> U32:
  U32.div(now, 86400)
