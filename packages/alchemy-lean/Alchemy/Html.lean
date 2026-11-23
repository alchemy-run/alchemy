/-!
Pages as values: a page is a function of the model, and what a visitor can do
on it is a form that sends a command.
-/
namespace Alchemy

inductive Html where
  | text (content : String)
  | element (tag : String) (attributes : List (String × String)) (children : List Html)
  /-- Markup written out as it is. -/
  | raw (markup : String)

namespace Html

def escape (s : String) : String :=
  s.foldl (fun out c =>
    out ++ match c with
      | '<' => "&lt;"
      | '>' => "&gt;"
      | '&' => "&amp;"
      | '"' => "&quot;"
      | c => c.toString) ""

partial def render : Html → String
  | .text content => escape content
  | .raw markup => markup
  | .element tag attributes children =>
    let attrs := attributes.foldl (fun out (k, v) => out ++ s!" {k}=\"{escape v}\"") ""
    s!"<{tag}{attrs}>" ++ String.join (children.map render) ++ s!"</{tag}>"

def el (tag : String) (children : List Html) : Html := .element tag [] children
def h1 (s : String) : Html := el "h1" [.text s]
def h2 (s : String) : Html := el "h2" [.text s]
def p (children : List Html) : Html := el "p" children
def link (href label : String) : Html := .element "a" [("href", href)] [.text label]

def table (headings : List String) (rows : List (List String)) : Html :=
  el "table" (el "tr" (headings.map fun h => el "th" [.text h]) ::
    rows.map fun row => el "tr" (row.map fun cell => el "td" [.text cell]))

/-- A form that posts its fields: the hidden ones as given, the others for the visitor to fill. -/
def form (action : String) (hidden : List (String × String)) (inputs : List (String × String))
    (button : String) : Html :=
  .element "form" [("method", "post"), ("action", action)]
    (hidden.map (fun (k, v) => .element "input" [("type", "hidden"), ("name", k), ("value", v)] [])
      ++ inputs.map (fun (name, placeholder) =>
        .element "input" [("name", name), ("placeholder", placeholder), ("size", "10")] [])
      ++ [el "button" [.text button]])

def page (title : String) (body : List Html) : String :=
  "<!doctype html><meta charset=utf-8><title>" ++ escape title ++ "</title>"
    ++ "<style>body{font:15px system-ui;max-width:46rem;margin:2rem auto;padding:0 1rem}"
    ++ "table{border-collapse:collapse}td,th{padding:.2rem .7rem;text-align:left;"
    ++ "border-bottom:1px solid #ddd}form{display:inline-block;margin:.2rem .6rem .2rem 0}"
    ++ "input,button{font:inherit}.note{background:#f4f4f4;padding:.5rem .8rem}</style>"
    ++ String.join (body.map render)

/--
Keeps a page live: it asks the server how much has been recorded, and loads the
page again when that changes.
-/
def live (versionPath : String) : Html :=
  .raw ("<script>let seen=null;setInterval(async()=>{const v=await(await fetch('"
    ++ versionPath ++ "')).text();if(seen!==null&&v!==seen&&!document.activeElement.name)"
    ++ "location.replace(location.pathname+location.search);seen=v},1000)</script>")

/-- The fields of a posted form. -/
def fields (body : String) : List (String × String) :=
  (body.splitOn "&").filterMap fun pair =>
    match pair.splitOn "=" with
    | [k, v] => some (k, (v.replace "%3A" ":").replace "+" " ")
    | _ => none

end Html
end Alchemy
