/**
 * Thin USDC transfer adapter. Two modes:
 * - simulated (default): deterministic `simulated-` txHashes, for demos and
 *   tests; the UI labels them so nothing pretends to be on-chain.
 * - arc: real ERC-20 transfers on Arc testnet via viem, waits 1 confirmation.
 * Selection via CHAIN_MODE — the degradation path is a config flip, not a
 * code change (design doc §9).
 */
import { createPublicClient, createWalletClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export interface ChainAdapter {
  readonly mode: "simulated" | "arc";
  transferUsdc(input: { to: Address; amount: bigint; memo: string }): Promise<{ txHash: string }>;
  explorerUrl(txHash: string): string;
}

export function makeSimulatedAdapter(): ChainAdapter {
  let counter = 0;
  return {
    mode: "simulated",
    transferUsdc: async ({ memo }) => ({ txHash: `simulated-${++counter}-${memo}` }),
    explorerUrl: () => "#simulated",
  };
}

export function makeArcAdapter(opts: {
  rpcUrl: string;
  privateKey: Hex;
  usdcAddress: Address;
  explorerBase?: string;
}): ChainAdapter {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);
  const wallet = createWalletClient({ account, transport });
  const publicClient = createPublicClient({ transport });
  const explorerBase = opts.explorerBase ?? "https://explorer-testnet.arc.network/tx/";
  return {
    mode: "arc",
    async transferUsdc({ to, amount }) {
      const hash = await wallet.writeContract({
        address: opts.usdcAddress,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, amount],
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      return { txHash: hash };
    },
    explorerUrl: (txHash) => `${explorerBase}${txHash}`,
  };
}

export function pickAdapter(env: Record<string, string | undefined>): ChainAdapter {
  if (env["CHAIN_MODE"] === "arc") {
    const rpcUrl = env["ARC_RPC_URL"];
    const privateKey = env["POOL_WALLET_KEY"];
    const usdcAddress = env["ARC_USDC_ADDRESS"];
    if (!rpcUrl || !privateKey || !usdcAddress) {
      throw new Error("CHAIN_MODE=arc requires ARC_RPC_URL, POOL_WALLET_KEY, ARC_USDC_ADDRESS");
    }
    return makeArcAdapter({ rpcUrl, privateKey: privateKey as Hex, usdcAddress: usdcAddress as Address });
  }
  return makeSimulatedAdapter();
}
