import Bank.Web

/--
`lake exe bank [journal] [port] [public]`: serves the bank, kept in the journal
file. With `public`, it listens on every address, as a container has to.
-/
def main (args : List String) : IO Unit :=
  let journal := args.getD 0 "bank.journal"
  let port := (args[1]?.bind String.toNat?).getD 8787
  Bank.hostWithPages.serve journal port.toUInt16 (everyone := args[2]? == some "public")
