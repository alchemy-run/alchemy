// A host driving the proved bank: `bend Bank.bend -o build/Bank.mjs` writes the
// module this imports. Constructors cross as { $: "Name", ...fields }, and a
// number is a Nat.
import Bank from "./build/Bank.mjs";

const sam = { $: "ByCustomer", id: 1 };
const alex = { $: "ByCustomer", id: 2 };

const moves = [
  { $: "Register", actor: sam, command: { $: "RegisterCustomer", customer: 1, username: 7 } },
  { $: "Register", actor: alex, command: { $: "RegisterCustomer", customer: 2, username: 8 } },
  { $: "ToAccount", id: 101, actor: sam, command: { $: "DepositMoney", amount: 100 } },
  {
    $: "ToTransfer",
    id: 1,
    actor: sam,
    command: { $: "RequestTransfer", source: 101, destination: 102, amount: 40 },
  },
];

let world = Bank.start();
for (const move of moves) world = Bank.play(world, move);

console.log("Sam's account: ", JSON.stringify(Bank.account(world, 101)));
console.log("Alex's account:", JSON.stringify(Bank.account(world, 102)));
console.log("The transfer:  ", JSON.stringify(Bank.transfer(world, 1)));
