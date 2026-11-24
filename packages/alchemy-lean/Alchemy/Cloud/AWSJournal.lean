import Std.Data.String.ToNat
import Alchemy.Cloud.AWSLaws
import Alchemy.Cloud.HostedLaws
import Alchemy.Cloud.Tactics
import Alchemy.Cloud.Infer

/-!
# A journal in S3

Where a hosted model keeps its history on AWS.
-/

namespace Alchemy.AWS.S3
open Alchemy.Cloud

/-- A line as the text of an object: a mark for which kind it is, then its text. -/
def encodeLine : Cloud.Journal.Line → String
  | .input text => String.ofList ('>' :: text.toList)
  | .answer text => String.ofList ('<' :: text.toList)
  | .decided text => String.ofList ('!' :: text.toList)

def decodeLine (body : String) : Option Cloud.Journal.Line :=
  match body.toList with
  | '>' :: text => some (.input (String.ofList text))
  | '<' :: text => some (.answer (String.ofList text))
  | '!' :: text => some (.decided (String.ofList text))
  | _ => none

theorem decode_encode (line : Cloud.Journal.Line) : decodeLine (encodeLine line) = some line := by
  cases line <;> simp [encodeLine, decodeLine, String.ofList_toList]

variable {access : Access Kind} {bucket : AWS.Bucket} {under : Path}

/-- The lines of a journal, from one on: stops at the first that is missing. -/
def readFrom (reader : GetObject.Client bucket (under ++ ["lines"]) access) :
    Nat → Nat → Run access Never (_root_.List Cloud.Journal.Line)
  | _, 0 => pure []
  | first, count + 1 => do
    match ← (reader.call (toString first)).result with
    | .ok body =>
      match decodeLine body with
      | some line => return line :: (← readFrom reader (first + 1) count)
      | none => readFrom reader (first + 1) count
    | .error _ => pure []

/-- How many lines a journal holds, from what its counter reads. -/
def countFrom (counter : GetObject.Client bucket under access) : Run access Never Nat := do
  match ← (counter.call "count").result with
  | .ok text => return text.toNat?.getD 0
  | .error _ => return 0

/--
A journal from four bindings: a counter under a prefix, and one object a line
under `lines/`. A line is written before the counter moves, so a line is never
counted before it is there.
-/
def journalOf (counter : GetObject.Client bucket under access)
    (setCounter : PutObject.Client bucket under access)
    (reader : GetObject.Client bucket (under ++ ["lines"]) access)
    (writer : PutObject.Client bucket (under ++ ["lines"]) access) : Cloud.Journal access where
  read := do readFrom reader 0 (← countFrom counter)
  append := fun line => do
    let count ← countFrom counter
    writer.call (toString count) (encodeLine line)
    setCounter.call "count" (toString (count + 1))

/--
A journal kept in a bucket. Grants reading and writing its counter, and
reading and writing its lines.
-/
def JournalLive (bucket : AWS.Bucket) (under : Path := ["journal"]) : Layer Nothing (Journal (K := Kind)) :=
  .from (GetObjectLive bucket under ++ PutObjectLive bucket under
      ++ GetObjectLive bucket (under ++ ["lines"]) ++ PutObjectLive bucket (under ++ ["lines"])) do
    return journalOf (← GetObject bucket under) (← PutObject bucket under)
      (← GetObject bucket (under ++ ["lines"])) (← PutObject bucket (under ++ ["lines"]))

/-! ## The journal's law, from the laws of the bindings it is built on -/

/-- How many lines the model of S3 holds for a journal. -/
def count (bucket : AWS.Bucket) (under : Path) (m : Memory) : Nat :=
  match m.object bucket (under ++ ["count"]) with
  | some text => text.toNat?.getD 0
  | none => 0

/-- The lines the model of S3 holds for a journal, read the way the journal reads them. -/
def linesFrom (bucket : AWS.Bucket) (under : Path) (m : Memory) :
    Nat → Nat → _root_.List Cloud.Journal.Line
  | _, 0 => []
  | first, count + 1 =>
    match m.object bucket (under ++ ["lines"] ++ [toString first]) with
    | some body =>
      match decodeLine body with
      | some line => line :: linesFrom bucket under m (first + 1) count
      | none => linesFrom bucket under m (first + 1) count
    | none => []

def lines (bucket : AWS.Bucket) (under : Path) (m : Memory) : _root_.List Cloud.Journal.Line :=
  linesFrom bucket under m 0 (count bucket under m)

/-- A journal is sound when every line its counter counts is there. -/
def Sound (bucket : AWS.Bucket) (under : Path) (m : Memory) : Prop :=
  ∃ held : _root_.List Cloud.Journal.Line, held.length = count bucket under m ∧
    ∀ i (h : i < held.length),
      m.object bucket (under ++ ["lines"] ++ [toString i]) = some (encodeLine held[i])

theorem countFrom_eval {counter : GetObject.Client bucket under access}
    (lawful : GetObject.Lawful counter) (m : Memory) :
    (countFrom counter).eval InMemory m = (.ok (count bucket under m), m) := by
  show Run.eval InMemory (Run.bind _ _) m = _
  rw [Run.eval_bind, Run.eval_result, lawful.get]
  simp only [count]
  cases m.object bucket (under ++ ["count"]) <;> rfl

theorem readFrom_eval {reader : GetObject.Client bucket (under ++ ["lines"]) access}
    (lawful : GetObject.Lawful reader) (m : Memory) :
    ∀ count first, (readFrom reader first count).eval InMemory m
      = (.ok (linesFrom bucket under m first count), m) := by
  intro count
  induction count with
  | zero => intro first; rfl
  | succ count ih =>
    intro first
    show Run.eval InMemory (Run.bind _ _) m = _
    rw [Run.eval_bind, Run.eval_result, lawful.get]
    cases found : m.object bucket (under ++ ["lines"] ++ [toString first]) with
    | none => simp only [linesFrom, found]; rfl
    | some body =>
      cases decoded : decodeLine body with
      | none =>
        simp only [linesFrom, found, decoded]
        exact ih _
      | some line =>
        simp only [linesFrom, found, decoded]
        show Run.eval InMemory (Run.bind _ _) m = _
        rw [Run.eval_bind, ih]
        rfl

/-- What a sound journal reads is the lines it holds. -/
theorem linesFrom_held (m : Memory) (rest : _root_.List Cloud.Journal.Line) :
    ∀ first, (∀ i (h : i < rest.length),
        m.object bucket (under ++ ["lines"] ++ [toString (first + i)]) = some (encodeLine rest[i])) →
      linesFrom bucket under m first rest.length = rest := by
  induction rest with
  | nil => intro _ _; rfl
  | cons line rest ih =>
    intro first held
    have head := held 0 (by simp)
    simp only [Nat.add_zero, List.getElem_cons_zero] at head
    simp only [List.length_cons, linesFrom, head, decode_encode]
    congr 1
    apply ih
    intro i h
    have := held (i + 1) (by simpa using h)
    simpa [Nat.add_assoc, Nat.add_comm 1 i] using this

theorem lineKey_ne_countKey (under : Path) (name : String) :
    ¬(under ++ ["lines"] ++ [name] = under ++ ["count"]) := by
  intro same
  have := congrArg _root_.List.length same
  simp at this

theorem lineKey_inj (under : Path) (i j : Nat)
    (same : under ++ ["lines"] ++ [toString i] = under ++ ["lines"] ++ [toString j]) : i = j := by
  have := List.append_cancel_left same
  simpa [Nat.toString_eq_repr, Nat.repr_inj] using this

/--
The journal keeps its law, given only that the four bindings it is built on
keep theirs.
-/
theorem journalOf_lawful {counter : GetObject.Client bucket under access}
    {setCounter : PutObject.Client bucket under access}
    {reader : GetObject.Client bucket (under ++ ["lines"]) access}
    {writer : PutObject.Client bucket (under ++ ["lines"]) access}
    (counts : GetObject.Lawful counter) (setsCount : PutObject.Lawful setCounter)
    (reads : GetObject.Lawful reader) (writes : PutObject.Lawful writer) :
    (journalOf counter setCounter reader writer).Lawful InMemory (lines bucket under)
      (Sound bucket under) where
  read m := by
    show Run.eval InMemory (Run.bind _ _) m = _
    rw [Run.eval_bind, countFrom_eval counts]
    exact readFrom_eval reads m _ _
  append m line sound := by
    obtain ⟨held, length, present⟩ := sound
    have evaluated : ((journalOf counter setCounter reader writer).append line).eval InMemory m
        = (.ok (), (m.put bucket (under ++ ["lines"] ++ [toString (count bucket under m)])
            (encodeLine line)).put bucket (under ++ ["count"])
              (toString (count bucket under m + 1))) := by
      show Run.eval InMemory (Run.bind _ _) m = _
      rw [Run.eval_bind, countFrom_eval counts]
      show Run.eval InMemory (Run.bind _ _) m = _
      rw [Run.eval_bind, writes.put]
      exact setsCount.put _ _ _
    rw [evaluated]
    have counted : count bucket under ((m.put bucket (under ++ ["lines"] ++
        [toString (count bucket under m)]) (encodeLine line)).put bucket (under ++ ["count"])
          (toString (count bucket under m + 1))) = (held ++ [line]).length := by
      simp [count, Memory.object_put_self, Nat.toString_eq_repr, Nat.toNat?_repr, length]
    have stored : ∀ i (h : i < (held ++ [line]).length),
        ((m.put bucket (under ++ ["lines"] ++ [toString (count bucket under m)])
          (encodeLine line)).put bucket (under ++ ["count"])
            (toString (count bucket under m + 1))).object bucket
              (under ++ ["lines"] ++ [toString i]) = some (encodeLine (held ++ [line])[i]) := by
      intro i h
      rw [Memory.object_put_other _ _ _ _ _ _ (fun same => lineKey_ne_countKey under _ same.2)]
      by_cases last : i = held.length
      · subst last
        have here : (m.put bucket (under ++ ["lines"] ++ [toString (count bucket under m)])
            (encodeLine line)).object bucket (under ++ ["lines"] ++ [toString held.length])
            = some (encodeLine line) := by
          rw [length]; exact Memory.object_put_self _ _ _ _
        rw [here]
        simp
      · have earlier : i < held.length := by
          simp only [List.length_append, List.length_cons, List.length_nil] at h
          omega
        rw [Memory.object_put_other _ _ _ _ _ _ (fun same => by
          have := lineKey_inj under _ _ same.2
          omega)]
        rw [present i earlier]
        simp [List.getElem_append_left earlier]
    refine ⟨rfl, ?_, held ++ [line], counted.symm, stored⟩
    have before : lines bucket under m = held := by
      unfold lines
      rw [← length]
      exact linesFrom_held m held 0 (by simpa using present)
    rw [before]
    show linesFrom bucket under _ 0 (count bucket under _) = _
    rw [counted]
    exact linesFrom_held _ (held ++ [line]) 0 (by simpa using stored)

/-- The journal on S3 keeps the journal's law. -/
theorem JournalLive.lawful (bucket : AWS.Bucket) (under : Path) {access : Access Kind}
    (le : (JournalLive bucket under).needs ≤ access) :
    ((JournalLive bucket under).build le ⟨⟩).Lawful InMemory (lines bucket under)
      (Sound bucket under) := by
  have part : ∀ {need : Access Kind}, (∀ t, need.permits t = true →
      (JournalLive bucket under).needs.permits t = true) → need ≤ access :=
    fun within t h => le t (within t h)
  apply journalOf_lawful
  · exact GetObjectLive.lawful _ _ (part fun t h => by simp [JournalLive, Layer.from, h])
  · exact PutObjectLive.lawful _ _ (part fun t h => by simp [JournalLive, Layer.from, h])
  · exact GetObjectLive.lawful _ _ (part fun t h => by simp [JournalLive, Layer.from, h])
  · exact PutObjectLive.lawful _ _ (part fun t h => by simp [JournalLive, Layer.from, h])

theorem linesFrom_same {m m' : Memory}
    (same : ∀ key, m'.object bucket key = m.object bucket key) :
    ∀ count first, linesFrom bucket under m' first count = linesFrom bucket under m first count := by
  intro count
  induction count with
  | zero => intro _; rfl
  | succ count ih => intro first; simp only [linesFrom, same, ih]

/-- Whatever leaves a bucket's objects alone leaves a journal in it alone, and sound. -/
theorem untouched {m m' : Memory} (same : ∀ key, m'.object bucket key = m.object bucket key) :
    lines bucket under m' = lines bucket under m ∧ (Sound bucket under m → Sound bucket under m') := by
  have counted : count bucket under m' = count bucket under m := by simp only [count, same]
  refine ⟨by simp only [lines, counted, linesFrom_same same], ?_⟩
  rintro ⟨held, length, present⟩
  exact ⟨held, by rw [counted]; exact length, fun i h => by rw [same]; exact present i h⟩

/--
Code that leaves a bucket's objects alone leaves a journal in it alone, and
sound. This is what an outside call has to show to be used beside a journal.
-/
theorem quiet {access : Access Kind} {ε α : Type} (run : Run access ε α) (m : Memory)
    (objects : ∀ key, (run.eval InMemory m).2.object bucket key = m.object bucket key)
    (sound : Sound bucket under m) :
    lines bucket under (run.eval InMemory m).2 = lines bucket under m ∧
      Sound bucket under (run.eval InMemory m).2 :=
  ⟨(untouched objects).1, (untouched objects).2 sound⟩

/-- A journal in a bucket: a step of a host's block. -/
def Journal {role : Access Kind} (bucket : AWS.Bucket) (under : Path := ["journal"]) :
    Host role (Cloud.Journal role) :=
  Host.provide (JournalLive bucket under)

end Alchemy.AWS.S3

namespace Alchemy.AWS
open Alchemy.Cloud

/-! ## Requests, in a test -/

/-- A request on its way to a function, in a test. -/
structure Asked where
  function : AWS.Function
  request : Request

def pathOf (path : String) : Path := (path.splitOn "/").filter (· ≠ "")

/-- `get api "/orders/o-1"` -/
def get (function : AWS.Function) (path : String) : Asked :=
  ⟨function, { method := .get, path := pathOf path }⟩

/-- `post api "/orders/o-1" body`: the body is sent as JSON. -/
def post {α : Type} [Text α] (function : AWS.Function) (path : String) (body : α) : Asked :=
  ⟨function, { method := .post, path := pathOf path, body := Text.write body }⟩

/-- `get api "/revenue" ⇒ (200, "40")`: the request, and the status and body it must get. -/
def Asked.answers (asked : Asked) (expected : Nat × String) : Graph.Step Kind InMemory :=
  .request asked.function asked.request (responds { status := expected.1, body := expected.2 })

@[inherit_doc] infix:50 " ⇒ " => Asked.answers

end Alchemy.AWS

/-! ## What can be done to a resource, in words -/

namespace Alchemy.AWS
open Alchemy.Cloud

namespace S3

/-- Writing a bucket's objects under a prefix. With no prefix, any of them. -/
abbrev writing (bucket : AWS.Bucket) (under : Path := []) : Doing Kind :=
  ⟨Path, fun rest => ⟨.bucket, bucket, BucketOp.put (under ++ rest)⟩⟩

/-- Reading a bucket's objects under a prefix. With no prefix, any of them. -/
abbrev reading (bucket : AWS.Bucket) (under : Path := []) : Doing Kind :=
  ⟨Path, fun rest => ⟨.bucket, bucket, BucketOp.get (under ++ rest)⟩⟩

/-- Listing a bucket's keys. -/
abbrev listing (bucket : AWS.Bucket) : Doing Kind :=
  ⟨Unit, fun _ => ⟨.bucket, bucket, BucketOp.list⟩⟩

end S3

namespace SQS

/-- Putting messages on a queue. -/
abbrev sending (queue : AWS.Queue) : Doing Kind :=
  ⟨Unit, fun _ => ⟨.queue, queue, QueueOp.send⟩⟩

/-- Taking messages off a queue. -/
abbrev receiving (queue : AWS.Queue) : Doing Kind :=
  ⟨Unit, fun _ => ⟨.queue, queue, QueueOp.receive⟩⟩

end SQS

namespace Lambda

/-- Invoking a function. -/
abbrev invoking (function : AWS.Function) : Doing Kind :=
  ⟨Unit, fun _ => ⟨.function, function, FunctionOp.invoke⟩⟩

end Lambda

end Alchemy.AWS

/-! ## Operations called directly: the call is what asks for the grant -/

namespace Alchemy.AWS
open Alchemy.Cloud

namespace S3

/-- Write `under/name`. -/
def putObject {role : Access Kind} (bucket : AWS.Bucket) (under : Path) (name body : String)
    [granted : Has role (Put bucket under)] : Run role Never Unit :=
  ((PutObjectLive bucket under).build granted.le ⟨⟩).call name body

/-- Read `under/name`. -/
def getObject {role : Access Kind} (bucket : AWS.Bucket) (under : Path) (name : String)
    [granted : Has role (Get bucket under)] : Run role GetObjectError String :=
  ((GetObjectLive bucket under).build granted.le ⟨⟩).call name

/-- Writing an object does what the model says. -/
theorem putObject_eval {role : Access Kind} (bucket : AWS.Bucket) (under : Path) (name body : String)
    [granted : Has role (Put bucket under)] (m : Memory) :
    (putObject (role := role) bucket under name body).eval InMemory m
      = (.ok (), m.put bucket (under ++ [name]) body) :=
  (PutObjectLive.lawful bucket under granted.le).put m name body

/-- Reading an object answers what the model holds, and changes nothing. -/
theorem getObject_eval {role : Access Kind} (bucket : AWS.Bucket) (under : Path) (name : String)
    [granted : Has role (Get bucket under)] (m : Memory) :
    (getObject (role := role) bucket under name).eval InMemory m =
      (match m.object bucket (under ++ [name]) with
        | some body => .ok body
        | none => .error (.noSuchKey { bucket := bucket.id, key := under ++ [name] }), m) :=
  (GetObjectLive.lawful bucket under granted.le).get m name

/-- A journal kept in a bucket, under a prefix. Using it asks for reading and writing there. -/
def journal {role : Access Kind} (bucket : AWS.Bucket) (under : Path := ["journal"])
    [counts : Has role (Get bucket under)] [setsCount : Has role (Put bucket under)]
    [reads : Has role (Get bucket (under ++ ["lines"]))]
    [writes : Has role (Put bucket (under ++ ["lines"]))] : Cloud.Journal role :=
  journalOf ((GetObjectLive bucket under).build counts.le ⟨⟩)
    ((PutObjectLive bucket under).build setsCount.le ⟨⟩)
    ((GetObjectLive bucket (under ++ ["lines"])).build reads.le ⟨⟩)
    ((PutObjectLive bucket (under ++ ["lines"])).build writes.le ⟨⟩)

/-- It keeps the journal's law. -/
theorem journal_lawful {role : Access Kind} (bucket : AWS.Bucket) (under : Path)
    [Has role (Get bucket under)] [Has role (Put bucket under)]
    [Has role (Get bucket (under ++ ["lines"]))] [Has role (Put bucket (under ++ ["lines"]))] :
    (journal (role := role) bucket under).Lawful InMemory (lines bucket under) (Sound bucket under) := by
  apply journalOf_lawful
  · exact GetObjectLive.lawful _ _ _
  · exact PutObjectLive.lawful _ _ _
  · exact GetObjectLive.lawful _ _ _
  · exact PutObjectLive.lawful _ _ _

end S3

namespace SQS

/-- Put a message on a queue. -/
def sendMessage {role : Access Kind} (queue : AWS.Queue) (body : String)
    [granted : Has role (Send queue)] : Run role Never Unit :=
  ((SendMessageLive queue).build granted.le ⟨⟩).call body

/-- Sending a message does what the model says. -/
theorem sendMessage_eval {role : Access Kind} (queue : AWS.Queue) (body : String)
    [granted : Has role (Send queue)] (m : Memory) :
    (sendMessage (role := role) queue body).eval InMemory m = (.ok (), m.send queue body) :=
  (SendMessageLive.lawful queue granted.le).send m body

end SQS

end Alchemy.AWS

namespace Alchemy.AWS

/-- A function's block has its role read off the calls in it. -/
macro_rules
  | `(Lambda.Function $id $props $body) =>
    `(Alchemy.AWS.Lambda.Function $id $props (granted% $body))

end Alchemy.AWS

namespace Alchemy.AWS
open Alchemy.Cloud

/-- The functions anyone on the internet can call: those with a public URL. -/
def exposed (g : Graph Kind) : List String :=
  g.nodes.filterMap fun node =>
    match node.kind, node.props with
    | .function, (props : FunctionProps) => if props.url then some node.id else none
    | _, _ => none

/-- Nothing that is exposed to the internet can do this. -/
def nothingExposed (g : Graph Kind) (action : Doing Kind) : Prop :=
  ∀ detail host, host ∈ exposed g → g.can host (action.attempt detail) = false

end Alchemy.AWS
