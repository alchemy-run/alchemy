import Inbox

/-- `lake exe inbox graph [stage] [--why]`, `lake exe inbox plan [stage]` -/
def main (args : List String) : IO UInt32 := Alchemy.Cloudflare.cli Inbox.InboxStack args
