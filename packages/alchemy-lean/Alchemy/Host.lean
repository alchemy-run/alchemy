import Alchemy.Engine
import Std.Http
import Std.Time
import Lean.Data.Json

/-!
A host: serves a model over HTTP and keeps it across restarts.

Everything that changes the model is written to a journal before it is applied:
each request that became a move, each answer an outside system gave, and each
time the clock moved. The engine is a function, so replaying the journal gives
back the same world, with every saga where it was.
-/
namespace Alchemy

open Lean (Json)

/-- A response: a status code, a content type and a body. -/
structure Reply where
  status : Nat := 200
  type : String := "application/json"
  body : String

/-- What a request turns out to be. -/
inductive Routed (m : Model) where
  /-- It changes the model. `respond` is given the world before and after. -/
  | move (move : Model.Move m) (respond : World m.signature → World m.signature → Reply)
  /-- It only reads. -/
  | read (respond : World m.signature → Reply)
  /-- It is neither. -/
  | refuse (reply : Reply)

structure Host (m : Model) where
  /-- What a request is, from its method, its path with any query, and its body. -/
  route : (method path body : String) → Routed m
  /-- Calls an outside system. -/
  adapter : (c : m.signature.Call) → IO (m.signature.Reply c)
  /-- An answer as text for the journal, and back. -/
  encodeReply : (c : m.signature.Call) → m.signature.Reply c → String
  decodeReply : (c : m.signature.Call) → String → Option (m.signature.Reply c)

namespace Host

variable {m : Model}

/-- One line of the journal. -/
inductive Entry where
  | request (method path body : String)
  | answer (reply : String)
  | clock (now : Time)

def Entry.toJson : Entry → Json
  | .request method path body =>
    Json.mkObj [("k", "request"), ("method", method), ("path", path), ("body", body)]
  | .answer reply => Json.mkObj [("k", "answer"), ("reply", reply)]
  | .clock now => Json.mkObj [("k", "clock"), ("now", now)]

def Entry.ofLine (line : String) : Option Entry := do
  let json ← (Json.parse line).toOption
  let kind ← (json.getObjValAs? String "k").toOption
  match kind with
  | "request" =>
    pure (.request (← (json.getObjValAs? String "method").toOption)
      (← (json.getObjValAs? String "path").toOption) (← (json.getObjValAs? String "body").toOption))
  | "answer" => pure (.answer (← (json.getObjValAs? String "reply").toOption))
  | "clock" => pure (.clock (← (json.getObjValAs? Nat "now").toOption))
  | _ => none

def fuel : Nat := 100000

/-- The world after one journal entry. -/
def apply (host : Host m) (w : World m.signature) : Entry → World m.signature
  | .request method path body =>
    match host.route method path body with
    | .move move _ => m.play fuel w move
    | _ => w
  | .answer text =>
    match m.waiting w with
    | c :: _ =>
      match host.decodeReply c text with
      | some reply => m.play fuel w (.answer c reply)
      | none => w
    | [] => w
  | .clock now => m.play fuel w (.pass (now - w.now))

/-- The world a journal leaves. -/
def replay (host : Host m) (lines : Array String) : World m.signature :=
  lines.foldl (fun w line =>
    match Entry.ofLine line with
    | some entry => host.apply w entry
    | none => w) (World.start m.signature)

/-- A model that is being served: its world, and the journal it is kept in. -/
structure Running (m : Model) where
  host : Host m
  world : IO.Ref (World m.signature)
  journal : System.FilePath
  /-- Whether the clock follows the wall clock. Off, time only moves when a move says so. -/
  wallClock : Bool

/-- Writes an entry to the journal, then applies it. -/
def Running.commit (r : Running m) (entry : Entry) : IO Unit := do
  let handle ← IO.FS.Handle.mk r.journal .append
  handle.putStrLn entry.toJson.compress
  handle.flush
  r.world.modify fun w => r.host.apply w entry

/-- Calls the outside systems the model is waiting on, until none is left. -/
partial def Running.answerCalls (r : Running m) : IO Unit := do
  match m.waiting (← r.world.get) with
  | [] => pure ()
  | c :: _ =>
    let reply ← r.host.adapter c
    r.commit (.answer (r.host.encodeReply c reply))
    r.answerCalls

def Running.tick (r : Running m) : IO Unit := do
  if r.wallClock then
    let now := (← Std.Time.Timestamp.now).toSecondsSinceUnixEpoch.val.toNat
    if now > (← r.world.get).now then r.commit (.clock now)

/-- Handles one request. -/
def Running.handle (r : Running m) (method path body : String) : IO Reply := do
  r.tick
  match r.host.route method path body with
  | .refuse reply => pure reply
  | .read respond => pure (respond (← r.world.get))
  | .move _ respond =>
    let before ← r.world.get
    r.commit (.request method path body)
    let after ← r.world.get
    r.answerCalls
    pure (respond before after)

open Std.Http Std.Async in
/--
Serves the model on a port, until the process ends. The journal is replayed
first, so the model is where it was when the process last stopped. It listens on
this machine only, unless `everyone` is set.
-/
def serve (host : Host m) (journal : System.FilePath) (port : UInt16)
    (wallClock : Bool := true) (everyone : Bool := false) : IO Unit := do
  let lines ← if ← journal.pathExists then IO.FS.lines journal else pure #[]
  let world ← IO.mkRef (host.replay lines)
  let r : Running m := { host, world, journal, wallClock }
  IO.println s!"{m.name}: replayed {lines.size} journal entries, serving on http://127.0.0.1:{port}"
  let lock ← Std.Mutex.new ()
  let handler := Server.Handler.ofFn fun request => do
    let body : String ← request.body.readAll
    let reply ← lock.atomically (liftM (r.handle (toString request.line.method)
      (toString request.line.uri) body))
    let status : Status := match reply.status with
      | 200 => .ok | 400 => .badRequest | 403 => .forbidden | 404 => .notFound
      | 409 => .conflict | _ => .internalServerError
    let response ← (Response.withStatus status |>.header! "content-type" reply.type).text reply.body
    pure response
  let task : Async Unit := do
    let address : Std.Net.IPv4Addr := if everyone then .ofParts 0 0 0 0 else .ofParts 127 0 0 1
    let server ← Server.serve (.v4 ⟨address, port⟩) handler
    server.waitShutdown
  task.block

end Host
end Alchemy
