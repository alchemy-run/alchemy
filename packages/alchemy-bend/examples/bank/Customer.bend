# A customer, a username, and the decision that registers one under the other.

import Base
import ./Types.bend as T

type CustomerState is Data:
  New{}
  Registered{username: Nat}

type CustomerEvent is Data:
  CustomerRegistered{username: Nat}

# A customer decides nothing alone: registering involves the username too, so
# the Registration decision records CustomerRegistered here.
def evolve_customer(state: CustomerState, event: CustomerEvent) -> CustomerState:
  match event:
    case CustomerRegistered{username}:
      Registered{username}

# One username, and who holds it. Uniqueness spans every customer, so the
# rule has an aggregate of its own, keyed by the username.
type ClaimState is Data:
  Free{}
  Claimed{customer: Nat}

type ClaimEvent is Data:
  UsernameClaimed{customer: Nat}

def evolve_claim(state: ClaimState, event: ClaimEvent) -> ClaimState:
  match event:
    case UsernameClaimed{customer}:
      Claimed{customer}

# Registration
# ============

type RegisterCustomer is Data:
  RegisterCustomer{customer: Nat, username: Nat}

type RegistrationRejection is Data:
  AlreadyRegistered{}
  # A customer may only register themselves.
  NotTheCustomer{}
  # Someone else holds this username.
  UsernameTaken{}

# What a registration answers: both events, or a rejection. Never one event.
type Registration is Data:
  Refused{why: RegistrationRejection}
  Accepted{on_customer: CustomerEvent, on_claim: ClaimEvent}

def is_registered(state: CustomerState) -> Bool:
  match state:
    case New{}:
      False{}
    case Registered{username}:
      True{}

def is_claimed(state: ClaimState) -> Bool:
  match state:
    case Free{}:
      False{}
    case Claimed{customer}:
      True{}

def register.go(may: Bool, registered: Bool, taken: Bool, +customer: Nat, username: Nat)
  -> Registration:
  match may registered taken:
    case False{} _ _:
      Refused{NotTheCustomer{}}
    case True{} True{} _:
      Refused{AlreadyRegistered{}}
    case True{} False{} True{}:
      Refused{UsernameTaken{}}
    case True{} False{} False{}:
      Accepted{CustomerRegistered{username}, UsernameClaimed{customer}}

# Register a customer and claim their username together: it reads both
# instances, and records on both or on neither.
def register(actor: T.Actor, customer: CustomerState, claim: ClaimState, command: RegisterCustomer)
  -> Registration:
  match command:
    case RegisterCustomer{+id, username}:
      register.go(T.may_act(actor, id), is_registered(customer), is_claimed(claim), id, username)

# The customer after a registration.
def customer_after(state: CustomerState, registration: Registration) -> CustomerState:
  match registration:
    case Refused{why}:
      state
    case Accepted{on_customer, on_claim}:
      evolve_customer(state, on_customer)

# The username after a registration.
def claim_after(state: ClaimState, registration: Registration) -> ClaimState:
  match registration:
    case Refused{why}:
      state
    case Accepted{on_customer, on_claim}:
      evolve_claim(state, on_claim)

# The registry
# ============
#
# Every registration that was sent, newest first. A customer's state and a
# username's state are those registrations decided in order, so a rule proved
# for every list of registrations holds for every bank.

type Registering is Data:
  Registering{actor: T.Actor, command: RegisterCustomer}

# What one customer or one username holds: a customer holds the name they
# registered under, and a username holds the customer it is claimed for.
type Slot is Data:
  Vacant{}
  Holds{value: Nat}

def is_held(slot: Slot) -> Bool:
  match slot:
    case Vacant{}:
      False{}
    case Holds{value}:
      True{}

def is_accepted(registration: Registration) -> Bool:
  match registration:
    case Refused{why}:
      False{}
    case Accepted{on_customer, on_claim}:
      True{}

def pick(first: Bool, a: Nat, b: Nat) -> Nat:
  match first:
    case True{}:
      a
    case False{}:
      b

def slot_next(accepted: Bool, hit: Bool, value: Nat, earlier: Slot) -> Slot:
  match accepted hit:
    case True{} True{}:
      Holds{value}
    case _ _:
      earlier

# What a customer (of_customer) or a username holds after the registrations.
def slot(sent: +List<Registering>, +of_customer: Bool, +key: Nat) -> Slot:
  match sent:
    case Nil{}:
      Vacant{}
    case Registering{actor, RegisterCustomer{+id, +username}} <> +older:
      slot_next(
        is_accepted(register.go(T.may_act(actor, id), is_held(slot(older, True{}, id)),
          is_held(slot(older, False{}, username)), id, username)),
        Nat.is_eq(pick(of_customer, id, username), key),
        pick(of_customer, username, id),
        slot(older, of_customer, key))

def customer_from(slot: Slot) -> CustomerState:
  match slot:
    case Vacant{}:
      New{}
    case Holds{value}:
      Registered{value}

def claim_from(slot: Slot) -> ClaimState:
  match slot:
    case Vacant{}:
      Free{}
    case Holds{value}:
      Claimed{value}

# A customer's state, after the registrations.
def customer_of(sent: +List<Registering>, id: Nat) -> CustomerState:
  customer_from(slot(sent, True{}, id))

# A username's state, after the registrations.
def claim_of(sent: +List<Registering>, name: Nat) -> ClaimState:
  claim_from(slot(sent, False{}, name))

def holds(slot: Slot, what: Nat) -> Bool:
  match slot:
    case Vacant{}:
      False{}
    case Holds{value}:
      Nat.is_eq(value, what)

# b, when the flag is up.
def when(flag: Bool, b: Bool) -> Bool:
  match flag:
    case True{}:
      b
    case False{}:
      False{}

def same(a: Bool, b: Bool) -> Bool:
  match a b:
    case True{} True{}:
      True{}
    case False{} False{}:
      True{}
    case _ _:
      False{}

# RULE: a customer is registered under a name exactly when the name is claimed
# for that customer.
def names_agree(+sent: +List<Registering>, +id: Nat, +name: Nat) -> Bool:
  same(holds(slot(sent, True{}, id), name), holds(slot(sent, False{}, name), id))
