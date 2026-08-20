import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetAccountsAccountPersons,
  GetAccountsAccountPersonsPerson,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Persons only exist on connected accounts whose requirements the platform
 * collects (Custom accounts / `controller.requirement_collection:
 * "application"`), so Connect must be enabled and onboarded on the Stripe
 * account backing the `testing` profile. Set `STRIPE_TEST_CONNECT=1` on an
 * entitled account to run the suite.
 */
const connect = test.provider.skipIf(process.env.STRIPE_TEST_CONNECT !== "1");

/**
 * All person data in this suite is deliberately synthetic — placeholder
 * names, `example.com` addresses, a 555 phone number and a round date of
 * birth. Never put real identity data in a test fixture.
 */
const CustomAccount = (id: string) =>
  Stripe.Account(id, {
    type: "custom",
    country: "US",
    businessType: "company",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });

connect("create a person with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { account, person } = yield* stack.deploy(
      Effect.gen(function* () {
        const account = yield* CustomAccount("MinimalPersonAccount");
        const person = yield* Stripe.AccountPerson("MinimalPerson", {
          accountId: account.accountId,
          firstName: "Test",
          lastName: "Person",
        });
        return { account, person };
      }),
    );

    expect(person.personId).toBeDefined();
    expect(person.personId.startsWith("person_")).toBe(true);
    expect(person.accountId).toEqual(account.accountId);
    expect(person.firstName).toEqual("Test");
    expect(person.lastName).toEqual("Person");
    expect(person.metadata).toEqual({});

    const fetched = yield* GetAccountsAccountPersonsPerson({
      account: account.accountId,
      person: person.personId,
    });
    expect(fetched.id).toEqual(person.personId);
    expect(fetched.first_name).toEqual("Test");
    expect(fetched.metadata?.alchemy_id).toEqual("MinimalPerson");

    yield* stack.destroy();
  }),
);

connect("create a person with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { account, person } = yield* stack.deploy(
      Effect.gen(function* () {
        const account = yield* CustomAccount("FullPersonAccount");
        const person = yield* Stripe.AccountPerson("FullPerson", {
          accountId: account.accountId,
          firstName: "Test",
          lastName: "Representative",
          email: "representative@example.com",
          phone: "+15555550123",
          dob: { day: 1, month: 1, year: 1980 },
          address: {
            line1: "1 Example Street",
            line2: "Suite 100",
            city: "San Francisco",
            state: "CA",
            postalCode: "94103",
            country: "US",
          },
          relationship: {
            representative: true,
            executive: true,
            owner: true,
            title: "CEO",
            percentOwnership: 80,
          },
          metadata: { source: "alchemy-test" },
        });
        return { account, person };
      }),
    );

    expect(person.email).toEqual("representative@example.com");
    expect(person.relationship?.representative).toBe(true);
    expect(person.relationship?.title).toEqual("CEO");
    expect(person.relationship?.percentOwnership).toEqual(80);
    // Alchemy's internal branding is stripped from the user-facing attribute.
    expect(person.metadata).toEqual({ source: "alchemy-test" });
    // Identity documents were never supplied, so nothing is on file.
    expect(person.idNumberProvided).toBe(false);
    expect(person.ssnLast4Provided).toBe(false);

    const fetched = yield* GetAccountsAccountPersonsPerson({
      account: account.accountId,
      person: person.personId,
    });
    expect(fetched.dob?.year).toEqual(1980);
    expect(fetched.address?.postal_code).toEqual("94103");
    expect(fetched.address?.city).toEqual("San Francisco");
    expect(fetched.relationship?.title).toEqual("CEO");
    expect(fetched.metadata?.source).toEqual("alchemy-test");

    yield* stack.destroy();
  }),
);

connect("update mutable props in place, preserving the person id", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const before = yield* stack.deploy(
      Effect.gen(function* () {
        const account = yield* CustomAccount("UpdatablePersonAccount");
        const person = yield* Stripe.AccountPerson("UpdatablePerson", {
          accountId: account.accountId,
          firstName: "Before",
          lastName: "Person",
          email: "before@example.com",
          relationship: { director: true, title: "Director" },
          metadata: { phase: "before", dropped: "yes" },
        });
        return { account, person };
      }),
    );

    expect(before.person.firstName).toEqual("Before");
    expect(before.person.metadata).toEqual({
      phase: "before",
      dropped: "yes",
    });

    const after = yield* stack.deploy(
      Effect.gen(function* () {
        const account = yield* CustomAccount("UpdatablePersonAccount");
        const person = yield* Stripe.AccountPerson("UpdatablePerson", {
          accountId: account.accountId,
          firstName: "After",
          lastName: "Person",
          email: "after@example.com",
          relationship: { director: true, executive: true, title: "CTO" },
          // `dropped` is removed — Stripe unsets it by posting an empty value.
          metadata: { phase: "after" },
        });
        return { account, person };
      }),
    );

    expect(after.person.personId).toEqual(before.person.personId);
    expect(after.person.accountId).toEqual(before.person.accountId);
    expect(after.person.firstName).toEqual("After");
    expect(after.person.email).toEqual("after@example.com");
    expect(after.person.relationship?.title).toEqual("CTO");
    expect(after.person.metadata).toEqual({ phase: "after" });

    const fetched = yield* GetAccountsAccountPersonsPerson({
      account: after.account.accountId,
      person: after.person.personId,
    });
    expect(fetched.first_name).toEqual("After");
    expect(fetched.relationship?.executive).toBe(true);
    expect(fetched.metadata?.phase).toEqual("after");
    expect(fetched.metadata?.dropped).toBeUndefined();
    expect(fetched.metadata?.alchemy_id).toEqual("UpdatablePerson");

    yield* stack.destroy();
  }),
);

connect("re-deploying identical props is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(
      Effect.gen(function* () {
        const account = yield* CustomAccount("StablePersonAccount");
        const person = yield* Stripe.AccountPerson("StablePerson", {
          accountId: account.accountId,
          firstName: "Stable",
          lastName: "Person",
          relationship: { director: true },
          metadata: { phase: "stable" },
        });
        return { account, person };
      }),
    );

    const created = yield* deploy;
    const again = yield* deploy;

    expect(again.person.personId).toEqual(created.person.personId);
    expect(again.person.firstName).toEqual("Stable");
    expect(again.person.metadata).toEqual({ phase: "stable" });

    yield* stack.destroy();
  }),
);

connect("moving the person to another account replaces it", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const before = yield* stack.deploy(
      Effect.gen(function* () {
        const first = yield* CustomAccount("MovedPersonAccountA");
        const second = yield* CustomAccount("MovedPersonAccountB");
        const person = yield* Stripe.AccountPerson("MovedPerson", {
          accountId: first.accountId,
          firstName: "Moved",
          lastName: "Person",
          relationship: { director: true },
        });
        return { first, second, person };
      }),
    );

    const after = yield* stack.deploy(
      Effect.gen(function* () {
        const first = yield* CustomAccount("MovedPersonAccountA");
        const second = yield* CustomAccount("MovedPersonAccountB");
        const person = yield* Stripe.AccountPerson("MovedPerson", {
          // A person belongs to exactly one legal entity, so pointing at a
          // different account must create a new person and delete the old.
          accountId: second.accountId,
          firstName: "Moved",
          lastName: "Person",
          relationship: { director: true },
        });
        return { first, second, person };
      }),
    );

    expect(after.person.accountId).toEqual(before.second.accountId);
    expect(after.person.personId).not.toEqual(before.person.personId);

    // The superseded person was deleted from the original account.
    const old = yield* Effect.result(
      GetAccountsAccountPersonsPerson({
        account: before.first.accountId,
        person: before.person.personId,
      }),
    );
    expect(Result.isFailure(old)).toBe(true);

    yield* stack.destroy();
  }),
);

connect("destroying the person removes it from the account", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { account, person } = yield* stack.deploy(
      Effect.gen(function* () {
        const account = yield* CustomAccount("DeletedPersonAccount");
        const person = yield* Stripe.AccountPerson("DeletedPerson", {
          accountId: account.accountId,
          firstName: "Deleted",
          lastName: "Person",
          relationship: { director: true },
        });
        return { account, person };
      }),
    );

    const listed = yield* GetAccountsAccountPersons({
      account: account.accountId,
      limit: 100,
    });
    expect(listed.data.map((p) => p.id)).toContain(person.personId);

    yield* stack.destroy();

    // The person is deleted outright — Stripe does not archive persons. The
    // parent account is destroyed by the same teardown, so a lookup against
    // it fails either way.
    const after = yield* Effect.result(
      GetAccountsAccountPersonsPerson({
        account: account.accountId,
        person: person.personId,
      }),
    );
    expect(Result.isFailure(after)).toBe(true);
  }),
);
