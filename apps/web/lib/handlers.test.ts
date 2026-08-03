import { beforeEach, describe, expect, it } from "vitest";
import { makeSimulatedAdapter } from "@citely-pay/chain";
import { demoFixtures, makeSaVerifier } from "@citely-pay/verify-adapter";
import { __setAppContext, DEMO } from "./context";
import { makeMemoryStore } from "./store";
import { getPassport, getState, postAdvance, postEscrow, postRelease } from "./handlers";

const post = (body: unknown): Request =>
  new Request("http://test.local", { method: "POST", body: JSON.stringify(body) });

let goodSaHash = "";
let badSaHash = "";

beforeEach(async () => {
  const fixtures = await demoFixtures();
  const verify = makeSaVerifier({ registeredSigners: fixtures.signers, sas: fixtures.sas });
  badSaHash = fixtures.badSaHash;
  goodSaHash = [...fixtures.sas.keys()].find((h) => h !== badSaHash)!;
  __setAppContext(Promise.resolve({
    fixtures, verify,
    chain: makeSimulatedAdapter(),
    store: makeMemoryStore({ feeBps: DEMO.feeBps, verify, boot: (p) => p.deposit("lp-demo", DEMO.lpSeed) }),
  }));
});

describe("demo happy path across handlers", () => {
  it("escrow → advance → release, all txHashes recorded", async () => {
    const escrowRes = await postEscrow(post({ invoiceId: "inv-1", amount: "2000000" }));
    expect(escrowRes.status).toBe(200);

    const advRes = await postAdvance(post({
      advanceId: "a1", invoiceId: "inv-1", saHash: goodSaHash, amount: "1500000",
    }));
    expect(advRes.status).toBe(200);
    const adv = (await advRes.json()) as { advance: { status: string; payoutTxHash: string } };
    expect(adv.advance.status).toBe("OUTSTANDING");
    expect(adv.advance.payoutTxHash).toMatch(/^simulated-/);

    const relRes = await postRelease(post({ invoiceId: "inv-1" }));
    const rel = (await relRes.json()) as { release: { residual: string }; residualTxHash?: string };
    expect(relRes.status).toBe(200);
    expect(rel.residualTxHash).toMatch(/^simulated-/);

    const stateRes = await getState();
    const state = (await stateRes.json()) as { outstanding: string; feesAccrued: string };
    expect(state.outstanding).toBe("0");
    expect(BigInt(state.feesAccrued)).toBeGreaterThan(0n);
  });

  it("a rogue-signed SA is rejected as 422 with the typed rejection", async () => {
    await postEscrow(post({ invoiceId: "inv-2", amount: "2000000" }));
    const res = await postAdvance(post({
      advanceId: "a2", invoiceId: "inv-2", saHash: badSaHash, amount: "1500000",
    }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { rejection: { code: string } };
    expect(body.rejection.code).toBe("SA_REJECTED");
  });

  it("passport reflects the completed cycle with live re-verification", async () => {
    await postEscrow(post({ invoiceId: "inv-1", amount: "2000000" }));
    await postAdvance(post({ advanceId: "a1", invoiceId: "inv-1", saHash: goodSaHash, amount: "1500000" }));
    await postRelease(post({ invoiceId: "inv-1" }));
    const res = await getPassport();
    const body = (await res.json()) as {
      stats: { completedCycles: number };
      escrowedEntries: { verifyNow: { ok: boolean }; txHashes: string[] }[];
    };
    expect(body.stats.completedCycles).toBe(1);
    expect(body.escrowedEntries[0]!.verifyNow.ok).toBe(true);
    expect(body.escrowedEntries[0]!.txHashes.length).toBeGreaterThanOrEqual(2);
  });
});
