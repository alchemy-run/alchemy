# alchemy-bend: an engine for any model.
#
# A model says what its commands, events, saga steps, outside calls and
# answers are, and gives four functions: what a command records, what the
# policies do about an event, what a saga step does, and what an answer from
# outside does. The templates here take those and give back the rest: the
# world, one step of it, settling, and running a sequence of moves.
#
#   C  a command, with who sends it and to what
#   E  an event one instance recorded
#   W  a saga's next step
#   K  a call to an outside system, waiting for its answer
#   A  an answer from an outside system
#   R  where a saga's run stands
#
# The world keeps every command that was sent, with when. An instance's state
# is its commands replayed, so a rule proved for every sequence of commands an
# aggregate can be sent holds for every instance in every world.

import Base

# A command, and when it was sent.
type Stamped<-C: Data> is Data:
  Stamped{time: U32, command: C}

# A command to send at a time.
type Scheduled<-C: Data> is Data:
  Scheduled{due: U32, command: C}

type World<-C: Data, -E: Data, -W: Data, -K: Data, -R: Data> is Data:
  World{
    now: U32,
    sent: +List<Stamped<C>>,
    log: +List<E>,
    inbox: +List<E>,
    work: +List<W>,
    calls: +List<K>,
    runs: +List<R>,
    schedule: +List<Scheduled<C>>}

# What can happen to a model, one thing at a time.
type Move<-C: Data, -A: Data> is Data:
  # A caller sends a command.
  Send{command: C}
  # The undelivered event at this place in the inbox reaches the policies.
  Deliver{index: Nat}
  # A fault: the event at this place in the log reaches the policies again.
  Redeliver{seq: Nat}
  # The saga step at this place in the work takes place.
  Advance{index: Nat}
  # An outside system answers.
  Answer{answer: A}
  Pass{seconds: U32}

def start(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data) -> World<C, E, W, K, R>:
  World{0, [], [], [], [], [], [], []}

# Reading the world
# =================

def now_of(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>) -> U32:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      now

def sent_of(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>)
  -> +List<Stamped<C>>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      sent

def log_of(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>)
  -> +List<E>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      log

def inbox_of(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>)
  -> +List<E>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      inbox

def work_of(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>)
  -> +List<W>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      work

def calls_of(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>)
  -> +List<K>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      calls

def runs_of(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>)
  -> +List<R>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      runs

def schedule_of(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>)
  -> +List<Scheduled<C>>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      schedule

# Changing one part of the world
# ==============================

def with_now(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>,
  now: U32) -> World<C, E, W, K, R>:
  match world:
    case World{old, sent, log, inbox, work, calls, runs, schedule}:
      World{now, sent, log, inbox, work, calls, runs, schedule}

def with_inbox(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>,
  inbox: +List<E>) -> World<C, E, W, K, R>:
  match world:
    case World{now, sent, log, old, work, calls, runs, schedule}:
      World{now, sent, log, inbox, work, calls, runs, schedule}

def with_work(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>,
  work: +List<W>) -> World<C, E, W, K, R>:
  match world:
    case World{now, sent, log, inbox, old, calls, runs, schedule}:
      World{now, sent, log, inbox, work, calls, runs, schedule}

# A saga's next step joins the work.
def add_work(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>,
  next: W) -> World<C, E, W, K, R>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      World{now, sent, log, inbox, List.append(&2, W, work, [next]), calls, runs, schedule}

def with_calls(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>,
  calls: +List<K>) -> World<C, E, W, K, R>:
  match world:
    case World{now, sent, log, inbox, work, old, runs, schedule}:
      World{now, sent, log, inbox, work, calls, runs, schedule}

# A call to an outside system starts waiting for its answer.
def add_call(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>,
  call: K) -> World<C, E, W, K, R>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      World{now, sent, log, inbox, work, List.append(&2, K, calls, [call]), runs, schedule}

# A saga's run stands somewhere new: the newest entry is where it stands.
def add_run(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>,
  run: R) -> World<C, E, W, K, R>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      World{now, sent, log, inbox, work, calls, List.append(&2, R, runs, [run]), schedule}

def with_schedule(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data,
  world: World<C, E, W, K, R>, schedule: +List<Scheduled<C>>) -> World<C, E, W, K, R>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, old}:
      World{now, sent, log, inbox, work, calls, runs, schedule}

# A command is to be sent later.
def later(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>,
  after: U32, command: C) -> World<C, E, W, K, R>:
  match world:
    case World{+now, sent, log, inbox, work, calls, runs, schedule}:
      World{now, sent, log, inbox, work, calls, runs,
        List.append(&2, Scheduled<C>, schedule, [Scheduled{U32.add(now, after), command}])}

def send.go(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, world: World<C, E, W, K, R>,
  command: C, +new: +List<E>) -> World<C, E, W, K, R>:
  match world:
    case World{+now, sent, log, inbox, work, calls, runs, schedule}:
      World{now, List.append(&2, Stamped<C>, sent, [Stamped{now, command}]),
        List.append(&2, E, log, new), List.append(&2, E, inbox, new), work, calls, runs, schedule}

# Sends a command: it joins the commands sent, and the events it records join
# the log and the inbox. `emit` says what a command records, as things stand.
def send(
  ~C: Data, ~E: Data, ~W: Data, ~K: Data, ~R: Data,
  ~emit: @+w: World<C, E, W, K, R> -> @+c: C -> +List<E>,
  +world: World<C, E, W, K, R>, +command: C
) -> World<C, E, W, K, R>:
  send.go(C, E, W, K, R, world, command, emit(world, command))

# Steps
# =====

def at(-T: Data, items: +List<T>, index: Nat) -> Maybe<&2, T>:
  match items index:
    case Nil{} _:
      None{}
    case x <> rest 0n:
      Some{x}
    case x <> rest 1n+p:
      at(T, rest, p)

def without(-T: Data, items: +List<T>, index: Nat) -> +List<T>:
  match items index:
    case Nil{} _:
      []
    case x <> rest 0n:
      rest
    case x <> rest 1n+p:
      x <> without(T, rest, p)

def due_now.keep(-C: Data, due: Bool, command: C, rest: +List<C>) -> +List<C>:
  match due:
    case True{}:
      command <> rest
    case False{}:
      rest


def due_now(-C: Data, schedule: +List<Scheduled<C>>, +now: U32) -> +List<C>:
  match schedule:
    case Nil{}:
      []
    case Scheduled{due, command} <> rest:
      due_now.keep(C, U32.is_le(due, now), command, due_now(C, rest, now))

def not_due.keep(-C: Data, due: Bool, entry: Scheduled<C>, rest: +List<Scheduled<C>>)
  -> +List<Scheduled<C>>:
  match due:
    case True{}:
      rest
    case False{}:
      entry <> rest

# Sends each of the commands, in order.

def not_due(-C: Data, schedule: +List<Scheduled<C>>, +now: U32) -> +List<Scheduled<C>>:
  match schedule:
    case Nil{}:
      []
    case Scheduled{+due, command} <> rest:
      not_due.keep(C, U32.is_le(due, now), Scheduled{due, command}, not_due(C, rest, now))

def send_all(
  ~C: Data, ~E: Data, ~W: Data, ~K: Data, ~R: Data,
  ~emit: @+w: World<C, E, W, K, R> -> @+c: C -> +List<E>,
  commands: +List<C>, +world: World<C, E, W, K, R>
) -> World<C, E, W, K, R>:
  match commands:
    case Nil{}:
      world
    case +c <> rest:
      send_all(~C, ~E, ~W, ~K, ~R, ~emit, rest, send(~C, ~E, ~W, ~K, ~R, ~emit, world, c))

def step.react(
  ~C: Data, ~E: Data, ~W: Data, ~K: Data, ~R: Data,
  ~react: @+w: World<C, E, W, K, R> -> E -> World<C, E, W, K, R>,
  +world: World<C, E, W, K, R>, event: Maybe<&2, E>
) -> World<C, E, W, K, R>:
  match event:
    case None{}:
      world
    case Some{e}:
      react(world, e)

def step.advance(
  ~C: Data, ~E: Data, ~W: Data, ~K: Data, ~R: Data,
  ~advance: @+w: World<C, E, W, K, R> -> W -> World<C, E, W, K, R>,
  +world: World<C, E, W, K, R>, work: Maybe<&2, W>
) -> World<C, E, W, K, R>:
  match work:
    case None{}:
      world
    case Some{w}:
      advance(world, w)

def step.pass(
  ~C: Data, ~E: Data, ~W: Data, ~K: Data, ~R: Data,
  ~emit: @+w: World<C, E, W, K, R> -> @+c: C -> +List<E>,
  +world: World<C, E, W, K, R>, +now: U32
) -> World<C, E, W, K, R>:
  send_all(~C, ~E, ~W, ~K, ~R, ~emit, due_now(C, schedule_of(C, E, W, K, R, world), now),
    with_schedule(C, E, W, K, R, with_now(C, E, W, K, R, world, now),
      not_due(C, schedule_of(C, E, W, K, R, world), now)))

# One thing happens.
def step(
  ~C: Data, ~E: Data, ~W: Data, ~K: Data, ~R: Data, ~A: Data,
  ~emit: @+w: World<C, E, W, K, R> -> @+c: C -> +List<E>,
  ~react: @+w: World<C, E, W, K, R> -> E -> World<C, E, W, K, R>,
  ~advance: @+w: World<C, E, W, K, R> -> W -> World<C, E, W, K, R>,
  ~answer: @+w: World<C, E, W, K, R> -> A -> World<C, E, W, K, R>,
  +world: World<C, E, W, K, R>, move: Move<C, A>
) -> World<C, E, W, K, R>:
  match move:
    case Send{+command}:
      send(~C, ~E, ~W, ~K, ~R, ~emit, world, command)
    case Deliver{+index}:
      step.react(~C, ~E, ~W, ~K, ~R, ~react,
        with_inbox(C, E, W, K, R, world, without(E, inbox_of(C, E, W, K, R, world), index)),
        at(E, inbox_of(C, E, W, K, R, world), index))
    case Redeliver{seq}:
      step.react(~C, ~E, ~W, ~K, ~R, ~react, world, at(E, log_of(C, E, W, K, R, world), seq))
    case Advance{+index}:
      step.advance(~C, ~E, ~W, ~K, ~R, ~advance,
        with_work(C, E, W, K, R, world, without(W, work_of(C, E, W, K, R, world), index)),
        at(W, work_of(C, E, W, K, R, world), index))
    case Answer{given}:
      answer(world, given)
    # Time passes: every scheduled command that is now due is sent.
    case Pass{seconds}:
      step.pass(~C, ~E, ~W, ~K, ~R, ~emit, world,
        U32.add(now_of(C, E, W, K, R, world), seconds))

# The world after every step, in order: nothing is delivered or advanced
# unless a step says so.
def steps(
  ~C: Data, ~E: Data, ~W: Data, ~K: Data, ~R: Data, ~A: Data,
  ~emit: @+w: World<C, E, W, K, R> -> @+c: C -> +List<E>,
  ~react: @+w: World<C, E, W, K, R> -> E -> World<C, E, W, K, R>,
  ~advance: @+w: World<C, E, W, K, R> -> W -> World<C, E, W, K, R>,
  ~answer: @+w: World<C, E, W, K, R> -> A -> World<C, E, W, K, R>,
  moves: List<Move<C, A>>, +world: World<C, E, W, K, R>
) -> World<C, E, W, K, R>:
  match moves:
    case Nil{}:
      world
    case move <> rest:
      steps(~C, ~E, ~W, ~K, ~R, ~A, ~emit, ~react, ~advance, ~answer, rest,
        step(~C, ~E, ~W, ~K, ~R, ~A, ~emit, ~react, ~advance, ~answer, world, move))

# Settling
# ========

def is_empty(-T: Data, items: +List<T>) -> Bool:
  match items:
    case Nil{}:
      True{}
    case x <> rest:
      False{}

def next.pick(-C: Data, -A: Data, inbox_empty: Bool, work_empty: Bool) -> Maybe<&2, Move<C, A>>:
  match inbox_empty work_empty:
    case False{} _:
      Some{Deliver{0n}}
    case True{} False{}:
      Some{Advance{0n}}
    case True{} True{}:
      None{}

# What to do next when nobody says: the oldest undelivered event, then the
# oldest saga step.
def next(-C: Data, -E: Data, -W: Data, -K: Data, -R: Data, -A: Data, world: World<C, E, W, K, R>)
  -> Maybe<&2, Move<C, A>>:
  match world:
    case World{now, sent, log, inbox, work, calls, runs, schedule}:
      next.pick(C, A, is_empty(E, inbox), is_empty(W, work))

def settle.go(
  ~C: Data, ~E: Data, ~W: Data, ~K: Data, ~R: Data, ~A: Data,
  ~emit: @+w: World<C, E, W, K, R> -> @+c: C -> +List<E>,
  ~react: @+w: World<C, E, W, K, R> -> E -> World<C, E, W, K, R>,
  ~advance: @+w: World<C, E, W, K, R> -> W -> World<C, E, W, K, R>,
  ~answer: @+w: World<C, E, W, K, R> -> A -> World<C, E, W, K, R>,
  fuel: Nat, +world: World<C, E, W, K, R>, move: Maybe<&2, Move<C, A>>
) -> World<C, E, W, K, R>:
  match fuel move:
    case 0n _:
      world
    case 1n+p None{}:
      world
    case 1n+p Some{+m}:
      settle.go(~C, ~E, ~W, ~K, ~R, ~A, ~emit, ~react, ~advance, ~answer, p,
        step(~C, ~E, ~W, ~K, ~R, ~A, ~emit, ~react, ~advance, ~answer, world, m),
        next(C, E, W, K, R, A,
          step(~C, ~E, ~W, ~K, ~R, ~A, ~emit, ~react, ~advance, ~answer, world, m)))

def fuel() -> Nat:
  64n

# The world after a move, once everything that follows from it has run.
def play(
  ~C: Data, ~E: Data, ~W: Data, ~K: Data, ~R: Data, ~A: Data,
  ~emit: @+w: World<C, E, W, K, R> -> @+c: C -> +List<E>,
  ~react: @+w: World<C, E, W, K, R> -> E -> World<C, E, W, K, R>,
  ~advance: @+w: World<C, E, W, K, R> -> W -> World<C, E, W, K, R>,
  ~answer: @+w: World<C, E, W, K, R> -> A -> World<C, E, W, K, R>,
  +world: World<C, E, W, K, R>, +move: Move<C, A>
) -> World<C, E, W, K, R>:
  settle.go(~C, ~E, ~W, ~K, ~R, ~A, ~emit, ~react, ~advance, ~answer, fuel(),
    step(~C, ~E, ~W, ~K, ~R, ~A, ~emit, ~react, ~advance, ~answer, world, move),
    next(C, E, W, K, R, A,
      step(~C, ~E, ~W, ~K, ~R, ~A, ~emit, ~react, ~advance, ~answer, world, move)))

# The world after every move, each followed by everything that follows from it.
def run(
  ~C: Data, ~E: Data, ~W: Data, ~K: Data, ~R: Data, ~A: Data,
  ~emit: @+w: World<C, E, W, K, R> -> @+c: C -> +List<E>,
  ~react: @+w: World<C, E, W, K, R> -> E -> World<C, E, W, K, R>,
  ~advance: @+w: World<C, E, W, K, R> -> W -> World<C, E, W, K, R>,
  ~answer: @+w: World<C, E, W, K, R> -> A -> World<C, E, W, K, R>,
  moves: List<Move<C, A>>, +world: World<C, E, W, K, R>
) -> World<C, E, W, K, R>:
  match moves:
    case Nil{}:
      world
    case move <> rest:
      run(~C, ~E, ~W, ~K, ~R, ~A, ~emit, ~react, ~advance, ~answer, rest,
        play(~C, ~E, ~W, ~K, ~R, ~A, ~emit, ~react, ~advance, ~answer, world, move))
