import Alchemy

/-!
# Uploads

People upload files from the internet. A file must not reach anyone until it
has been scanned, and an infected file must never be served.

Three functions share one bucket:

- `Upload` is public. It stores a file under `incoming/` and asks for a scan.
- `Scanner` is private. It reads the file, and writes it under `clean/` or `quarantine/`.
- `Download` is public. It serves files from `clean/`.

The safety of this design is entirely in who may touch which prefix. Those
rules are stated here as theorems about the stack, so a change that breaks one
does not build.
-/

open Alchemy Cloud AWS

namespace Uploads

def infected (body : String) : Bool := (body.splitOn "EICAR").length > 1

/-- Stores an upload where nothing public can read it, and asks for it to be scanned. -/
def Upload (files : Bucket) (scans : Queue) : Construct Kind Function :=
  Lambda.Function "Upload" { url := true } do
    return fun request => do
      match request.method, request.path with
      | .post, ["files", name] =>
        S3.putObject files ["incoming"] name request.body
        SQS.sendMessage scans name
        return { status := 202 }
      | _, _ => return { status := 404 }

/-- Scans one upload: a clean file is published, an infected one is set aside. -/
def scan {role : Access Kind} (files : Bucket)
    [Has role (S3.Get files ["incoming"])] [Has role (S3.Put files ["clean"])]
    [Has role (S3.Put files ["quarantine"])] (name : String) : Run role Never Unit := do
  match ← (S3.getObject files ["incoming"] name).result with
  | .ok body =>
    if infected body then S3.putObject files ["quarantine"] name body
    else S3.putObject files ["clean"] name body
  | .error _ => pure ()

def Scanner (files : Bucket) (scans : Queue) : Construct Kind Function :=
  Lambda.Function "Scanner" {} do
    SQS.consume scans fun name => scan files name
    return fun _ => return { status := 204 }

/-- Serves published files, and nothing else. -/
def Download (files : Bucket) : Construct Kind Function :=
  Lambda.Function "Download" { url := true } do
    return fun request => do
      match request.method, request.path with
      | .get, ["files", name] =>
        match ← (S3.getObject files ["clean"] name).result with
        | .ok body => return { status := 200, body }
        | .error _ => return { status := 404 }
      | _, _ => return { status := 404 }

structure Outputs where
  files : Bucket
  scans : Queue
  upload : Function
  scanner : Function
  download : Function
deriving Inhabited

def UploadStack : Stack Kind Outputs where
  name := "Uploads"
  body := do
    let files ← S3.Bucket "Files"
    let scans ← SQS.Queue "Scans"
    let upload ← Upload files scans
    let scanner ← Scanner files scans
    let download ← Download files
    return { files, scans, upload, scanner, download }

def prod : Graph Kind := UploadStack.graph "prod"
def out : Outputs := computed% (UploadStack.outputs "prod")

/-! ## What must be true of this stack -/

/-- Exactly two functions face the internet. A third would have to be added here on purpose. -/
theorem whatIsPublic : exposed prod = ["Upload", "Download"] := by decide

/--
Nothing public can read a file that has not been scanned. This is the rule the
design exists for, and it holds for every file name.
-/
theorem nothingPublicReadsAnUnscannedFile :
    nothingExposed prod (S3.reading out.files ["incoming"]) := by
  simp only [nothingExposed, whatIsPublic]
  stack_rule in prod using [out, BucketOp.covers]

/-- Nothing public can read what was quarantined, either. In fact nothing at all can. -/
theorem nobodyReadsTheQuarantine : prod.nobody (S3.reading out.files ["quarantine"]) := by
  stack_rule in prod using [out, BucketOp.covers]

/--
Only the Scanner publishes. So every file `Download` can serve was put there by
the Scanner: there is no way around the scan.
-/
theorem onlyTheScannerPublishes :
    prod.only [out.scanner] (S3.writing out.files ["clean"]) := by
  stack_rule in prod using [out, BucketOp.covers]

/-- If `Upload` is taken over, it can read nothing: not uploads, not published files. -/
theorem uploadReadsNothing : prod.never out.upload (S3.reading out.files) := by
  stack_rule in prod using [out, BucketOp.covers]

/-- If `Download` is taken over, it can change nothing: no file, and no scan request. -/
theorem downloadChangesNothing :
    prod.never out.download (S3.writing out.files) ∧
      prod.only [out.upload] (SQS.sending out.scans) := by
  constructor <;> stack_rule in prod using [out, BucketOp.covers]

/-- No function can invoke another, so taking one over does not lead to the others. -/
theorem noFunctionInvokesAnother (function : Function) :
    prod.nobody (Lambda.invoking function) := by
  stack_rule in prod using [out]

/-! ## What the Scanner's code does, for every file -/

section
variable {role : Access Kind} {files : Bucket}
  [Has role (S3.Get files ["incoming"])] [Has role (S3.Put files ["clean"])]
  [Has role (S3.Put files ["quarantine"])]

/--
The Scanner never publishes an infected file. Whatever the bucket holds and
whatever the file is called, if the upload is infected then after the scan
`clean/` is exactly as it was.
-/
theorem anInfectedFileIsNeverPublished (name body : String) (cloud : Memory)
    (uploaded : cloud.object files ["incoming", name] = some body) (bad : infected body = true)
    (published : String) :
    ((scan (role := role) files name).eval InMemory cloud).2.object files ["clean", published]
      = cloud.object files ["clean", published] := by
  have read : (S3.getObject (role := role) files ["incoming"] name).eval InMemory cloud
      = (.ok body, cloud) := by
    have := S3.getObject_eval (role := role) files ["incoming"] name cloud
    simpa [uploaded] using this
  have evaluated : (scan (role := role) files name).eval InMemory cloud
      = (.ok (), cloud.put files ["quarantine", name] body) := by
    show Run.eval InMemory (Run.bind _ _) cloud = _
    rw [Run.eval_bind, Run.eval_result, read]
    simp only [bad, ite_true]
    exact S3.putObject_eval files ["quarantine"] name body cloud
  rw [evaluated]
  exact Memory.object_put_other _ _ _ _ _ _ (by simp)

end

/-! ## Tests of the stack -/

def aCleanFile : List (Graph.Step Kind InMemory) := [
  .request out.upload { method := .post, path := ["files", "notes.txt"], body := "hello" }
    (responds { status := 202 }),
  get out.download "/files/notes.txt" ⇒ (200, "hello") ]

def anInfectedFile : List (Graph.Step Kind InMemory) := [
  .request out.upload { method := .post, path := ["files", "virus.exe"], body := "xxEICARxx" }
    (responds { status := 202 }),
  get out.download "/files/virus.exe" ⇒ (404, ""),
  .holds "it was set aside" (·.object out.files ["quarantine", "virus.exe"] == some "xxEICARxx") ]

example : prod.passes aCleanFile = true := by native_decide
example : prod.passes anInfectedFile = true := by native_decide

def fresh : Cloud.World Kind Control.Service := ⟨.empty, {}⟩

end Uploads
