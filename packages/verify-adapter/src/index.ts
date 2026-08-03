/**
 * Adapter: vendored `@citely/verifier` stateless checks → the pool's injected
 * `SaVerifier` port. The pool verifies locally — it trusts no remote service,
 * including the SA issuer's own.
 *
 * The verdict binds the SA to THIS payment, not just "some valid SA":
 * hash integrity → signature (registered signer) → expiry → a PASS leg that
 * names this payee with sufficient amount. Module attestation + rubric
 * coverage checks need the deal-desk manifest assets; roadmap.
 */
import { checkDeliverableSignature } from "./vendor/checks/signature.js";
import { computeDeliverableHash } from "./vendor/sa/index.js";
import type { SettlementAuthorization } from "./vendor/sa/index.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { fixtureSa, FIXTURE_PAYEE } from "./vendor/testing/sa-fixture.js";
import type { SaVerifier } from "@citely-pay/pool";

export function makeSaVerifier(opts: {
  registeredSigners: readonly Address[];
  sas: ReadonlyMap<string, SettlementAuthorization>;
  /** Injected clock for expiry checks (epoch ms). Defaults to Date.now. */
  now?: () => number;
}): SaVerifier {
  const now = opts.now ?? Date.now;
  return async ({ saHash, payee, amount }) => {
    const sa = opts.sas.get(saHash);
    if (!sa) return { ok: false, reason: "sa_not_found" };
    // Hash integrity: the key must be the SA's actual content hash — a
    // mislabeled map entry must not authorize anything.
    if (computeDeliverableHash(sa) !== saHash) {
      return { ok: false, reason: "sa_hash_mismatch" };
    }
    const outcome = await checkDeliverableSignature({
      sa,
      registeredSigners: opts.registeredSigners,
    });
    if (!outcome.passed) {
      return { ok: false, reason: outcome.failures[0]?.code ?? "signature_check_failed" };
    }
    if (new Date(sa.bound_to.expires_at).getTime() <= now()) {
      return { ok: false, reason: "sa_expired" };
    }
    // Payment binding: this payee, covered amount, on a PASS leg.
    const leg = sa.legs.find((l) => l.payee.toLowerCase() === payee.toLowerCase());
    if (!leg || leg.condition !== "PASS") {
      return { ok: false, reason: "no_pass_leg_for_payee" };
    }
    if (amount > BigInt(leg.amount_nominal)) {
      return { ok: false, reason: "amount_exceeds_leg" };
    }
    // Signature check verified sa.attestation.signer is registered and signed
    // this content — report the actual signer, not an assumption.
    return { ok: true, signer: sa.attestation.signer };
  };
}

/** Demo fixture set: 3 valid SAs + 1 signed by an unregistered key. */
export async function demoFixtures(): Promise<{
  sas: Map<string, SettlementAuthorization>;
  signers: Address[];
  badSaHash: string;
  /** The payee every fixture leg authorizes (use as the demo exporter address). */
  payee: Address;
  /** Per-leg authorized amount in USDC minor units. */
  legAmount: bigint;
}> {
  const registered = privateKeyToAccount(`0x${"7".repeat(64)}`);
  const rogue = privateKeyToAccount(`0x${"8".repeat(64)}`);
  const sas = new Map<string, SettlementAuthorization>();
  for (const jobId of ["11", "12", "13"]) {
    const sa = await fixtureSa({
      account: registered,
      body: { bound_to: { job_id: jobId, expires_at: "2027-01-01T00:00:00.000Z" } },
    });
    sas.set(computeDeliverableHash(sa), sa);
  }
  const bad = await fixtureSa({
    account: rogue,
    body: { bound_to: { job_id: "14", expires_at: "2027-01-01T00:00:00.000Z" } },
  });
  const badSaHash = computeDeliverableHash(bad);
  sas.set(badSaHash, bad);
  return { sas, signers: [registered.address], badSaHash, payee: FIXTURE_PAYEE, legAmount: 1_500_000n };
}
