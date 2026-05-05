"use client"

import { useState } from "react"
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi"
import { formatEther } from "viem"
import { cn } from "@/lib/utils"
import { ensureZamaInit, encryptInputs } from "@/lib/zama"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  CUSDC_ABI,
  CUSDC_ADDRESS,
  SCALE,
  type AuctionData,
} from "@/lib/zama-contracts"

type Step = "idle" | "init" | "encrypt" | "approve" | "bid" | "done" | "error"

// The relayer-sdk hands us handles as bigints. Contracts expect bytes32-shaped
// hex. Pad to 32 bytes (64 hex chars) and prefix with 0x.
function handleToBytes32(h: bigint): `0x${string}` {
  return `0x${h.toString(16).padStart(64, "0")}` as `0x${string}`
}

const STEP_LABEL: Record<Step, string> = {
  idle: "Place sealed bid",
  init: "Initialising FHE session…",
  encrypt: "Encrypting bid…",
  approve: "Approving encrypted cUSDC…",
  bid: "Submitting sealed bid…",
  done: "Bid submitted",
  error: "Bid failed — retry",
}

export function PlaceBidForm({
  auctionId,
  auction,
  onBidSuccess,
}: {
  auctionId: bigint
  auction?: AuctionData
  onBidSuccess?: () => void
}) {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const isTokenMode = auction?.mode === "TOKEN"

  const [amount, setAmount] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [step, setStep] = useState<Step>("idle")
  const [error, setError] = useState<string | null>(null)

  const { data: cUsdcHandle, refetch: refetchCUsdc } = useReadContract({
    address: CUSDC_ADDRESS || undefined,
    abi: CUSDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!CUSDC_ADDRESS, refetchInterval: 10_000 },
  })

  // Read minimum bid gas fee from contract (optional - may not exist on Zama version)
  const { data: minBidGasFee } = useReadContract({
    address: AUCTION_ADDRESS || undefined,
    abi: AUCTION_ABI,
    functionName: "minBidGasFee",
    query: { enabled: !!AUCTION_ADDRESS },
  })

  const gasFeeWei = (minBidGasFee as bigint | undefined) ?? 0n

  const amtNum = parseFloat(amount)
  const amtRaw =
    Number.isFinite(amtNum) && amtNum > 0
      ? BigInt(Math.floor(amtNum * Number(SCALE)))
      : 0n

  const qtyNum = parseFloat(quantity)
  const qtyRaw =
    Number.isFinite(qtyNum) && qtyNum > 0
      ? BigInt(Math.floor(qtyNum))
      : (isTokenMode ? 0n : 1n)

  const ZERO_HANDLE = "0x0000000000000000000000000000000000000000000000000000000000000000"
  const hasSealedBalance =
    typeof cUsdcHandle === "string" && cUsdcHandle !== ZERO_HANDLE

  const canSubmit =
    isConnected &&
    !!AUCTION_ADDRESS &&
    !!CUSDC_ADDRESS &&
    amtRaw > 0n &&
    qtyRaw > 0n &&
    hasSealedBalance &&
    (step === "idle" || step === "done" || step === "error")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !publicClient || !walletClient || !address) return
    setError(null)
    try {
      setStep("init")
      await ensureZamaInit(publicClient as never, walletClient)

      setStep("encrypt")
      // Encrypt (price, qty) tuple. ITEM mode the contract overrides qty to 1 on-chain
      // but we still pass an encrypted dummy so the call shape is consistent.
      const encrypted = await encryptInputs(
        [
          { type: "uint64", value: amtRaw },
          { type: "uint64", value: qtyRaw },
        ],
        AUCTION_ADDRESS,
        address,
      )
      const encPriceHandle = handleToBytes32(encrypted.handles[0])
      const encQtyHandle = handleToBytes32(encrypted.handles[1])
      const inputProof = encrypted.inputProof

      // For cUSDC.approve we re-encrypt the escrow ceiling separately, since
      // the auction contract pulls via transferFromAllowance.
      const encApprove = await encryptInputs(
        [{ type: "uint64", value: amtRaw * qtyRaw }],
        CUSDC_ADDRESS,
        address,
      )
      const encApproveHandle = handleToBytes32(encApprove.handles[0])
      const encApproveProof = encApprove.inputProof

      // Sepolia FHEVM gas notes:
      //   - Each FHE op costs 200k–1M gas via on-chain HCU enforcement.
      //   - We cap `gas` explicitly so the wallet skips eth_estimateGas. Public
      //     RPCs (publicnode, blastapi) reject estimates >~10–30M with the
      //     literal string "gas limit too high", which viem then surfaces as a
      //     contract revert. Cap = bypass that path.
      //   - Numbers are conservative upper bounds verified via Foundry traces;
      //     unused gas is refunded.
      setStep("approve")
      const approveHash = await walletClient.writeContract({
        address: CUSDC_ADDRESS,
        abi: CUSDC_ABI,
        functionName: "approve",
        args: [AUCTION_ADDRESS, encApproveHandle, encApproveProof],
        account: walletClient.account!,
        chain: walletClient.chain,
        gas: 3_500_000n,
      })
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
      if (approveReceipt.status !== "success") throw new Error("cUSDC approve reverted")

      setStep("bid")
      // The contract takes priceProof + qtyProof separately. Both encrypted
      // handles came from the same encryptInputs() call, so they share one
      // proof — pass it twice.
      const bidHash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "placeBid",
        args: [auctionId, encPriceHandle, encQtyHandle, inputProof, inputProof],
        value: gasFeeWei,
        account: walletClient.account!,
        chain: walletClient.chain,
        gas: 12_000_000n,
      })
      const bidReceipt = await publicClient.waitForTransactionReceipt({ hash: bidHash })
      if (bidReceipt.status !== "success") throw new Error("placeBid reverted")

      setStep("done")
      refetchCUsdc()
      onBidSuccess?.()
      setTimeout(() => setStep("idle"), 2500)
      setAmount("")
    } catch (err) {
      setStep("error")
      setError(err instanceof Error ? err.message.slice(0, 200) : "Unknown error")
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-8 space-y-6 max-w-lg">
      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          {isTokenMode ? "Bid price per unit (USDC)" : "Bid amount (USDC)"}
        </label>
        <div className="flex items-baseline gap-2 border border-border/40 px-4 py-3">
          <input
            type="text"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0"
            className="flex-1 bg-transparent font-mono text-xl tabular-nums focus:outline-none"
            disabled={step !== "idle" && step !== "done" && step !== "error"}
          />
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            USDC
          </span>
        </div>
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
          Sealed cUSDC balance:{" "}
          <span className="text-accent">
            {hasSealedBalance ? "encrypted (wrap more if low)" : "0 — wrap USDC first"}
          </span>
        </p>
        {gasFeeWei > 0n && (
          <p className="mt-1 font-mono text-[10px] text-muted-foreground/50">
            Gas fee: {formatEther(gasFeeWei)} ETH (covers settlement costs)
          </p>
        )}
      </div>

      {isTokenMode && (
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
            Quantity (units)
          </label>
          <div className="flex items-baseline gap-2 border border-border/40 px-4 py-3">
            <input
              type="text"
              inputMode="numeric"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="1"
              className="flex-1 bg-transparent font-mono text-xl tabular-nums focus:outline-none"
              disabled={step !== "idle" && step !== "done" && step !== "error"}
            />
            <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              units
            </span>
          </div>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
            Total escrow = price × qty (sealed). Exceed = bid is dropped at clearing.
          </p>
        </div>
      )}

      {!isConnected && (
        <div className="border border-border/40 p-4">
          <p className="font-mono text-xs text-muted-foreground">Connect a wallet to bid.</p>
        </div>
      )}

      {isConnected && !hasSealedBalance && (
        <div className="border border-yellow-500/50 bg-yellow-500/10 p-4">
          <p className="font-mono text-xs text-yellow-300">
            No sealed cUSDC. Mint test USDC and wrap it at{" "}
            <a href="/wallet" className="underline hover:text-yellow-200">/wallet</a> first.
          </p>
        </div>
      )}

      {error && (
        <div className="border border-destructive/50 bg-destructive/10 p-4">
          <p className="font-mono text-xs text-destructive break-all">{error}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className={cn(
          "w-full py-4 font-mono text-xs uppercase tracking-[0.3em] border transition-all",
          canSubmit
            ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
            : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
        )}
      >
        {STEP_LABEL[step]}
      </button>
    </form>
  )
}
