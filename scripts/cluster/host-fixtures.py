"""Write a host's fixture directory: one module per implementation, each the
default export its runners bundle, deployed to that host's runners."""
import os, sys

LIVES = [
    ("counter-live.ts", "counterLive", "../counter-live.ts", "CounterLive"),
    ("greeter-live.ts", "greeterLive", "../greeter-live.ts", "GreeterLive"),
    ("journal-live.ts", "journalLive", "../workflows/journal-live.ts", "JournalLive"),
    ("greet-live.ts", "greetLive", "../workflows/greet-live.ts", "GreetLive"),
    ("nap-live.ts", "napLive", "../workflows/nap-live.ts", "NapLive"),
    ("approve-live.ts", "approveLive", "../workflows/approve-live.ts", "ApproveLive"),
    ("checkout-live.ts", "checkoutLive", "../workflows/checkout-live.ts", "CheckoutLive"),
    ("parent-live.ts", "parentLive", "../workflows/parent-live.ts", "ParentLive"),
    ("heartbeat-live.ts", "heartbeatLive", "../scheduled/heartbeat-live.ts", "HeartbeatLive"),
    ("tick-live.ts", "tickLive", "../scheduled/tick-live.ts", "TickLive"),
]

def write(dir):
    os.makedirs(dir, exist_ok=True)
    for file, factory, source, _ in LIVES:
        with open(os.path.join(dir, file), "w") as f:
            f.write(
                f'import {{ {factory} }} from "{source}";\n'
                f'import {{ Default }} from "./cluster.ts";\n\n'
                f"export default {factory}(import.meta.url, Default);\n"
            )
    with open(os.path.join(dir, "tally.ts"), "w") as f:
        f.write(
            'import { tallyOn } from "../legacy.ts";\n'
            'import { Legacy } from "./cluster.ts";\n\n'
            "export const Tally = tallyOn(Legacy);\n"
        )
    with open(os.path.join(dir, "index.ts"), "w") as f:
        f.write("/** Every implementation this host's suite deploys. */\n")
        f.write('import * as Layer from "effect/Layer";\n')
        for file, _, _, name in LIVES:
            f.write(f'import {name} from "./{file}";\n')
        f.write("\nexport const Lives = Layer.mergeAll(\n")
        for _, _, _, name in LIVES:
            f.write(f"  {name},\n")
        f.write(");\n")

if __name__ == "__main__":
    for dir in sys.argv[1:]:
        write(dir)
