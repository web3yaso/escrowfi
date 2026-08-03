import { describe, expect, it } from "vitest";
import { demoFixtures, makeSaVerifier } from "./index.js";

const FIXED_NOW = () => new Date("2026-08-02T00:00:00.000Z").getTime();

async function setup() {
  const fx = await demoFixtures();
  const verify = makeSaVerifier({ registeredSigners: fx.signers, sas: fx.sas, now: FIXED_NOW });
  const goodHash = [...fx.sas.keys()].find((h) => h !== fx.badSaHash)!;
  return { fx, verify, goodHash };
}

describe("makeSaVerifier binds the SA to the specific payment", () => {
  it("verifies a fixture SA for its authorized payee/amount and reports the real signer", async () => {
    const { fx, verify, goodHash } = await setup();
    const verdict = await verify({ saHash: goodHash, payee: fx.payee, amount: fx.legAmount });
    expect(verdict.ok).toBe(true);
    expect(verdict.signer?.toLowerCase()).toBe(fx.signers[0]!.toLowerCase());
  });

  it("rejects an SA signed by an unregistered key with a machine reason", async () => {
    const { fx, verify } = await setup();
    const verdict = await verify({ saHash: fx.badSaHash, payee: fx.payee, amount: 1n });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  it("rejects an unknown saHash as sa_not_found", async () => {
    const { fx, verify } = await setup();
    const verdict = await verify({ saHash: "0xdeadbeef", payee: fx.payee, amount: 1n });
    expect(verdict).toEqual({ ok: false, reason: "sa_not_found" });
  });

  it("rejects a payee the SA does not authorize", async () => {
    const { verify, goodHash } = await setup();
    const verdict = await verify({
      saHash: goodHash, payee: "0x9999999999999999999999999999999999999999", amount: 1n,
    });
    expect(verdict).toEqual({ ok: false, reason: "no_pass_leg_for_payee" });
  });

  it("rejects an amount above the authorized leg amount", async () => {
    const { fx, verify, goodHash } = await setup();
    const verdict = await verify({ saHash: goodHash, payee: fx.payee, amount: fx.legAmount + 1n });
    expect(verdict).toEqual({ ok: false, reason: "amount_exceeds_leg" });
  });

  it("rejects an expired SA", async () => {
    const { fx, goodHash } = await setup();
    const verify = makeSaVerifier({
      registeredSigners: fx.signers, sas: fx.sas,
      now: () => new Date("2028-01-01T00:00:00.000Z").getTime(),
    });
    const verdict = await verify({ saHash: goodHash, payee: fx.payee, amount: 1n });
    expect(verdict).toEqual({ ok: false, reason: "sa_expired" });
  });

  it("rejects a map entry whose key is not the SA's content hash", async () => {
    const { fx } = await setup();
    const goodSa = fx.sas.get([...fx.sas.keys()].find((h) => h !== fx.badSaHash)!)!;
    const verify = makeSaVerifier({
      registeredSigners: fx.signers,
      sas: new Map([["0xwronghash", goodSa]]),
      now: FIXED_NOW,
    });
    const verdict = await verify({ saHash: "0xwronghash", payee: fx.payee, amount: 1n });
    expect(verdict).toEqual({ ok: false, reason: "sa_hash_mismatch" });
  });

  it("provides three good SAs plus one bad for the demo", async () => {
    const { fx } = await setup();
    expect(fx.sas.size).toBe(4);
  });
});
