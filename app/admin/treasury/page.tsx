"use client"

import { useState } from "react"
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi"
import { cn } from "@/lib/utils"
import {
  TREASURY_ABI,
  TREASURY_ADDRESS,
  CUSDC_ABI,
  CUSDC_ADDRESS,
} from "@/lib/zama-contracts"

export default function TreasuryPage() {
  const { address: myAddr } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [newFeeBps, setNewFeeBps] = useState("")
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read current fee
  const { data: feeBps, refetch: refetchFee } = useReadContract({
    address: TREASURY_ADDRESS || undefined,
    abi: TREASURY_ABI,
    functionName: "feeBasisPoints",
    query: { enabled: !!TREASURY_ADDRESS && TREASURY_ADDRESS !== "0x0000000000000000000000000000000000000000" },
  })

  // Read treasury owner
  const { data: owner } = useReadContract({
    address: TREASURY_ADDRESS || undefined,
    abi: TREASURY_ABI,
    functionName: "owner",
    query: { enabled: !!TREASURY_ADDRESS && TREASURY_ADDRESS !== "0x0000000000000000000000000000000000000000" },
  })

  // Read treasury cUSDC balance
  const { data: treasuryBalance } = useReadContract({
    address: CUSDC_ADDRESS || undefined,
    abi: CUSDC_ABI,
    functionName: "balanceOf",
    args: [TREASURY_ADDRESS || "0x0000000000000000000000000000000000000000"],
    query: {
      enabled: !!TREASURY_ADDRESS && TREASURY_ADDRESS !== "0x0000000000000000000000000000000000000000" && !!CUSDC_ADDRESS,
      refetchInterval: 10_000,
    },
  })

  const ownerAddr = owner as `0x${string}` | undefined
  const isOwner = !!(myAddr && ownerAddr && myAddr.toLowerCase() === ownerAddr.toLowerCase())
  const feeBpsNum = feeBps !== undefined && feeBps !== null ? Number(feeBps) : undefined
  const currentFeePercent = feeBpsNum !== undefined ? (feeBpsNum / 100).toFixed(1) : "—"
  const newFeePercent = newFeeBps ? (parseFloat(newFeeBps) / 100).toFixed(1) : ""

  async function handleSetFee(e: React.FormEvent) {
    e.preventDefault()
    if (!newFeeBps || !walletClient || !TREASURY_ADDRESS || !publicClient) return
    setError(null)
    try {
      setUpdating(true)
      const bps = BigInt(Math.round(parseFloat(newFeeBps)))
      if (bps > 1000n) {
        throw new Error("Fee cannot exceed 10% (1000 bps)")
      }

      const hash = await walletClient.writeContract({
        address: TREASURY_ADDRESS,
        abi: TREASURY_ABI,
        functionName: "setFeeBasisPoints",
        args: [Number(bps)],
        account: walletClient.account!,
        chain: walletClient.chain,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      refetchFee()
      setNewFeeBps("")
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "Update failed")
    } finally {
      setUpdating(false)
    }
  }

  if (TREASURY_ADDRESS === "0x0000000000000000000000000000000000000000") {
    return (
      <div>
        <h1 className="font-[var(--font-bebas)] text-3xl md:text-4xl tracking-tight mb-6">Treasury</h1>
        <div className="border border-destructive/50 bg-destructive/10 p-6">
          <p className="font-mono text-sm text-destructive">
            Treasury contract not configured. Set NEXT_PUBLIC_TREASURY_ADDRESS in .env.local.
          </p>
        </div>
      </div>
    )
  }

  if (!isOwner) {
    return (
      <div>
        <h1 className="font-[var(--font-bebas)] text-3xl md:text-4xl tracking-tight mb-6">Treasury</h1>
        <div className="border border-yellow-500/50 bg-yellow-500/10 p-6">
          <p className="font-mono text-sm text-yellow-300">
            Only the Treasury owner can manage this page.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 className="font-[var(--font-bebas)] text-3xl md:text-4xl tracking-tight mb-6">Treasury</h1>

      <div className="space-y-8">
        {/* Current Fee */}
        <div className="border border-border/40 p-6">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-4">Current Platform Fee</h2>
          <p className="font-mono text-3xl tabular-nums mb-2">
            {currentFeePercent}%
          </p>
          <p className="font-mono text-[10px] text-muted-foreground/70">
            {feeBpsNum !== undefined && `${feeBpsNum} basis points`}
          </p>
        </div>

        {/* Treasury Balance */}
        <div className="border border-border/40 p-6">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-4">Treasury cUSDC Balance</h2>
          <p className="font-mono text-sm text-muted-foreground">
            {treasuryBalance && treasuryBalance !== "0x0000000000000000000000000000000000000000000000000000000000000000"
              ? "Encrypted (requires oracle decryption)"
              : "No fees collected yet or balance is zero"}
          </p>
          <p className="font-mono text-[10px] text-muted-foreground/60 mt-2">
            Fees from winning bids are automatically transferred here on finalization.
          </p>
        </div>

        {/* Update Fee */}
        <form onSubmit={handleSetFee} className="border border-border/40 p-6">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-4">Update Platform Fee</h2>

          <div className="space-y-4">
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
                New fee (basis points)
              </label>
              <div className="flex items-baseline gap-2 border border-border/40 px-4 py-3">
                <input
                  type="text"
                  inputMode="decimal"
                  value={newFeeBps}
                  onChange={(e) => setNewFeeBps(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="250"
                  className="flex-1 bg-transparent font-mono text-xl tabular-nums focus:outline-none"
                  disabled={updating}
                  min="0"
                  max="1000"
                />
                <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  bps
                </span>
              </div>
              {newFeePercent && (
                <p className="mt-2 font-mono text-[10px] text-accent">
                  = {newFeePercent}%
                </p>
              )}
              <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                Maximum 1000 bps (10%). 250 bps = 2.5% fee.
              </p>
            </div>

            {error && (
              <div className="border border-destructive/50 bg-destructive/10 p-4">
                <p className="font-mono text-xs text-destructive break-all">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={!newFeeBps || updating}
              className={cn(
                "w-full py-4 font-mono text-xs uppercase tracking-[0.3em] border transition-all",
                newFeeBps && !updating
                  ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
                  : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
              )}
            >
              {updating ? "Updating…" : "Update Fee"}
            </button>
          </div>
        </form>

        {/* Info */}
        <div className="border border-purple-500/30 bg-purple-500/5 p-4 font-mono text-[10px] text-muted-foreground space-y-1">
          <p className="text-purple-400 uppercase tracking-widest">Treasury Info</p>
          <p>Address: {TREASURY_ADDRESS}</p>
          <p>Owner: {ownerAddr?.slice(0, 6)}…{ownerAddr?.slice(-4)}</p>
          <p>The Treasury collects a percentage of each winning bid after settlement.</p>
        </div>
      </div>
    </div>
  )
}
