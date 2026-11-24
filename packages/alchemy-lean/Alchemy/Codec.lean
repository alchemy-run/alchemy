import Lean
import Std.Data.String.ToNat

/-!
# Writing values down, and reading them back

A journal keeps what a model was sent as text. For the model as deployed to be
the model that was proved, what is read back must be what was written. So the
text form here comes with that proof: `read (write a) = some a`.

A value is written as a list of tokens, one for its case and one for each
field. A list of tokens is written as text with every character marked, so no
character of a token can be taken for a separator.
-/

namespace Alchemy

namespace Packed

/-- Tokens as characters: each character after a `c`, each token ended by a `;`. -/
def pack : List String → List Char
  | [] => []
  | token :: rest => (token.toList.flatMap fun ch => ['c', ch]) ++ ';' :: pack rest

/-- Characters back to tokens. `token` is the one being read, backwards. -/
def unpack : List Char → List Char → List String → Option (List String)
  | [], [], done => some done.reverse
  | [], _ :: _, _ => none
  | ch :: rest, token, done =>
    if ch = ';' then unpack rest [] (String.ofList token.reverse :: done)
    else
      match rest with
      | next :: rest => unpack rest (next :: token) done
      | [] => none
termination_by chars => chars.length

theorem unpack_marked (chars tail token : List Char) (done : List String) :
    unpack ((chars.flatMap fun ch => ['c', ch]) ++ tail) token done
      = unpack tail (chars.reverse ++ token) done := by
  induction chars generalizing token with
  | nil => rfl
  | cons ch chars ih =>
    show unpack ('c' :: ch :: ((chars.flatMap fun ch => ['c', ch]) ++ tail)) token done = _
    rw [unpack]
    simp only [show ('c' = ';') = False by decide, ite_false]
    rw [ih]
    simp

theorem unpack_pack (tokens done : List String) :
    unpack (pack tokens) [] done = some (done.reverse ++ tokens) := by
  induction tokens generalizing done with
  | nil => simp [pack, unpack]
  | cons token tokens ih =>
    rw [pack, unpack_marked, unpack.eq_def]
    simp only [ite_true, List.append_nil, List.reverse_reverse]
    rw [ih]
    simp [String.ofList_toList]

/-- Tokens as text. -/
def write (tokens : List String) : String := String.ofList (pack tokens)

/-- Text back to tokens. -/
def read (text : String) : Option (List String) := unpack text.toList [] []

/-- What is written reads back. -/
theorem read_write (tokens : List String) : read (write tokens) = some tokens := by
  simp [read, write, String.toList_ofList, unpack_pack]

end Packed

/-- A value as one token, and back, with the proof that it comes back. -/
class Token (α : Type) where
  write : α → String
  read : String → Option α
  back : ∀ a, read (write a) = some a

/-- A value as tokens, and back, with the proof that it comes back. -/
class Tokens (α : Type) where
  write : α → List String
  read : List String → Option α
  back : ∀ a, read (write a) = some a

instance : Token String := ⟨id, some, fun _ => rfl⟩

instance : Token Nat where
  write := toString
  read := String.toNat?
  back n := by simp [Nat.toString_eq_repr, Nat.toNat?_repr]

instance : Token Bool where
  write b := if b then "yes" else "no"
  read text := if text = "yes" then some true else if text = "no" then some false else none
  back b := by cases b <;> simp

/-- A value with several tokens is one token: its tokens, written as text. -/
instance (priority := low) {α : Type} [Tokens α] : Token α where
  write a := Packed.write (Tokens.write a)
  read text := (Packed.read text).bind Tokens.read
  back a := by simp [Packed.read_write, Tokens.back]

instance : Tokens Unit := ⟨fun _ => [], fun _ => some (), fun _ => rfl⟩

instance {α : Type} [Token α] : Tokens (Option α) where
  write
    | none => ["none"]
    | some a => ["some", Token.write a]
  read
    | ["none"] => some none
    | ["some", text] => (Token.read text).map some
    | _ => none
  back a := by cases a <;> simp [Token.back]

/-- How a kind of value is kept in a journal: as text, with the proof that it reads back. -/
structure Codec (α : Type) where
  write : α → String
  read : String → Option α
  back : ∀ a, read (write a) = some a

/-- The codec of a value that has tokens. -/
def Codec.of {α : Type} [Tokens α] : Codec α where
  write a := Packed.write (Tokens.write a)
  read text := (Packed.read text).bind Tokens.read
  back a := by simp [Packed.read_write, Tokens.back]

/-- Nothing to keep. -/
def Codec.empty : Codec Empty := ⟨nofun, fun _ => none, nofun⟩

open Lean Elab Command Meta in
/--
`derive_tokens T` writes `T` as tokens: a token for the case, then one for each
field. It comes with the proof that what is written reads back.
-/
elab "derive_tokens " type:ident : command => do
  let typeName ← liftCoreM <| realizeGlobalConstNoOverload type
  let info ← getConstInfoInduct typeName
  let mut writes : Array (TSyntax ``Parser.Term.matchAlt) := #[]
  let mut reads : Array (TSyntax ``Parser.Term.matchAlt) := #[]
  for ctorName in info.ctors do
    let ctor ← getConstInfoCtor ctorName
    let fields := (List.range ctor.numFields).toArray.map fun i => mkIdent (Name.mkSimple s!"field{i}")
    let texts := (List.range ctor.numFields).toArray.map fun i => mkIdent (Name.mkSimple s!"text{i}")
    let tag := Syntax.mkStrLit ctorName.getString!
    let ctorId := mkIdent ctorName
    writes := writes.push ⟨(← `(Parser.Term.matchAltExpr|
      | $ctorId:ident $fields* => [$tag, $[Alchemy.Token.write $fields],*])).raw⟩
    let built ← `(some ($ctorId:ident $fields*))
    let body ← (fields.zip texts).foldrM (init := built) fun (field, text) rest =>
      `(Option.bind (Alchemy.Token.read $text) fun $field => $rest)
    reads := reads.push ⟨(← `(Parser.Term.matchAltExpr| | [$tag, $texts,*] => $body)).raw⟩
  reads := reads.push ⟨(← `(Parser.Term.matchAltExpr| | _ => none)).raw⟩
  let typeId := mkIdent typeName
  elabCommand (← `(command|
    instance : Alchemy.Tokens $typeId where
      write := fun value => match value with $writes:matchAlt*
      read := fun tokens => match tokens with $reads:matchAlt*
      back := by intro value; cases value <;> simp [Alchemy.Token.back]))

end Alchemy
