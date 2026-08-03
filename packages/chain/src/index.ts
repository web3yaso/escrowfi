/**
 * Thin USDC transfer adapter. Two modes:
 * - simulated (default): deterministic `simulated-` txHashes, for demos and
 *   tests; the UI labels them so nothing pretends to be on-chain.
 * - arc: real ERC-20 transfers on Arc testnet via viem, waits 1 confirmation.
 * Selection via CHAIN_MODE — the degradation path is a config flip, not a
 * code change (design doc §9).
 */
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http } from "viem";
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
  chainId: number;
  explorerBase?: string;
}): ChainAdapter {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);
  // Bind every tx to the intended chain id — never sign chain-unbound.
  const chain = defineChain({
    id: opts.chainId,
    name: "arc-testnet",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const wallet = createWalletClient({ account, transport, chain });
  const publicClient = createPublicClient({ transport, chain });
  const explorerBase = opts.explorerBase ?? "https://explorer-testnet.arc.network/tx/";
  return {
    mode: "arc",
    async transferUsdc({ to, amount }) {
      const hash = await wallet.writeContract({
        address: opts.usdcAddress,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, amount],
        chain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      // A mined-but-reverted transfer moved no money — that must be an error,
      // never a recorded txHash (fail closed).
      if (receipt.status !== "success") {
        throw new Error(`transfer reverted on-chain: ${hash}`);
      }
      return { txHash: hash };
    },
    explorerUrl: (txHash) => `${explorerBase}${txHash}`,
  };
}

export function pickAdapter(env: Record<string, string | undefined>): ChainAdapter {
  const mode = env["CHAIN_MODE"] ?? "simulated";
  if (mode === "arc") {
    const rpcUrl = env["ARC_RPC_URL"];
    const privateKey = env["POOL_WALLET_KEY"];
    const usdcAddress = env["ARC_USDC_ADDRESS"];
    const chainId = Number(env["ARC_CHAIN_ID"]);
    if (!rpcUrl || !privateKey || !usdcAddress || !Number.isInteger(chainId) || chainId <= 0) {
      throw new Error("CHAIN_MODE=arc requires ARC_RPC_URL, POOL_WALLET_KEY, ARC_USDC_ADDRESS, ARC_CHAIN_ID");
    }
    return makeArcAdapter({ rpcUrl, privateKey: privateKey as Hex, usdcAddress: usdcAddress as Address, chainId });
  }
  if (mode !== "simulated") {
    // An unrecognized mode must never silently fall back to fake money.
    throw new Error(`unknown CHAIN_MODE: ${mode} (expected "arc" or "simulated")`);
  }
  return makeSimulatedAdapter();
}
