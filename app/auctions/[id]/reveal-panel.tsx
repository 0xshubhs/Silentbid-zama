"use client"

import { useCallback, useEffect, useState } from "react"
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi"
import { getAddress, formatEther, type Address } from "viem"
import { cn } from "@/lib/utils"
import { ensureZamaInit, userDecrypt, publicDecrypt, getLastPublicDecryptProof } from "@/lib/zama"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  TREASURY_ABI,
  TREASURY_ADDRESS,
  formatUsdc,
  type AuctionData,
} from "@/lib/zama-contracts"
import { chainId } from "@/lib/chain-config"

type BidRow = {
  index: number
  bidder: Address
  encPriceHandle: string
  encQtyHandle: string
  encEscrowHandle: string
  settled: boolean
  allocatedTokenX: bigint
  refundedCUSDC: bigint
  /** unsealed plain price once we've decrypted */
  plainPrice?: bigint
  plainQty?: bigint
}

export function RevealPanel({
  auction,
  onUpdate,
}: {
  auction: AuctionData
  onUpdate?: () => void
}) {
  const { address: myAddr } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { data: walletClient } = useWalletClient()

  const [endingAuction, setEndingAuction] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [busyReveal, setBusyReveal] = useState<number | null>(null)
  const [bids, setBids] = useState<BidRow[]>([])
  const [loadingBids, setLoadingBids] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Read treasury fee
  const { data: feeBps } = useReadContract({
    address: TREASURY_ADDRESS || undefined,
    abi: TREASURY_ABI,
    functionName: "feeBasisPoints",
    query: { enabled: !!TREASURY_ADDRESS && TREASURY_ADDRESS !== "0x0000000000000000000000000000000000000000" },
  })

  const feePercent = feeBps ? (Number(feeBps) / 100).toFixed(1) : "2.5"

  const fetchBids = useCallback(async () => {
    if (!publicClient || !AUCTION_ADDRESS) return
    try {
      const n = Number(auction.numBids)
      if (n === 0) {
        setBids([])
        return
      }
      const contracts = Array.from({ length: n }, (_, i) => ({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "getBid" as const,
        args: [auction.id, BigInt(i)] as const,
      }))
      const results = await publicClient.multicall({ contracts })
      const rows: BidRow[] = results
        .map((r, i): BidRow | null => {
          if (r.status !== "success") return null
          const [bidder, encPriceHandle, encQtyHandle, encEscrowHandle, settled, allocatedTokenX, refundedCUSDC] =
            r.result as [Address, string, string, string, boolean, bigint, bigint]
          const existing = bids.find((b) => b.index === i)
          return {
            index: i,
            bidder,
            encPriceHandle,
            encQtyHandle,
            encEscrowHandle,
            settled,
            allocatedTokenX,
            refundedCUSDC,
            plainPrice: existing?.plainPrice,
            plainQty: existing?.plainQty,
          }
        })
        .filter((x): x is BidRow => x !== null)
      setBids(rows)
    } finally {
      setLoadingBids(false)
    }
  }, [publicClient, auction.id, auction.numBids]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchBids()
  }, [fetchBids])

  async function handleEndAuction() {
    if (!publicClient || !walletClient || !AUCTION_ADDRESS) return
    setError(null)
    try {
      setEndingAuction(true)
      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "endAuction",
        args: [auction.id],
        account: walletClient.account!,
        chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw new Error("endAuction reverted")
      onUpdate?.()
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "endAuction failed")
    } finally {
      setEndingAuction(false)
    }
  }

  async function handleFinalizeAuction() {
    if (!publicClient || !walletClient || !AUCTION_ADDRESS) return
    setError(null)
    try {
      setFinalizing(true)
      await ensureZamaInit(publicClient as never, walletClient)

      if (auction.mode === "ITEM") {
        // Public-decrypt the running highest bidder + amount handles. The contract
        // also returns the decryptionProof we hand back to finalizeAuctionItem.
        const [bidderPlain, amountPlain] = await publicDecrypt([
          auction.highestBidderHandle,
          auction.highestBidHandle,
        ])
        const winner = getAddress("0x" + bidderPlain.toString(16).padStart(40, "0"))
        const winningAmount = amountPlain as bigint
        const decryptionProof = getLastPublicDecryptProof()

        const hash = await walletClient.writeContract({
          address: AUCTION_ADDRESS,
          abi: AUCTION_ABI,
          functionName: "finalizeAuctionItem",
          args: [auction.id, winner, winningAmount, decryptionProof],
          account: walletClient.account!,
          chain: walletClient.chain,
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== "success") throw new Error("finalizeAuctionItem reverted")
      } else {
        // TOKEN mode: decrypt all bid (price, qty) handles in order.
        const handles: string[] = []
        for (const b of bids) {
          handles.push(b.encPriceHandle)
          handles.push(b.encQtyHandle)
        }
        const cleartexts = await publicDecrypt(handles)
        const prices: bigint[] = []
        const qtys: bigint[] = []
        for (let i = 0; i < bids.length; i++) {
          prices.push(cleartexts[i * 2] as bigint)
          qtys.push(cleartexts[i * 2 + 1] as bigint)
        }
        const decryptionProof = getLastPublicDecryptProof()

        const hash = await walletClient.writeContract({
          address: AUCTION_ADDRESS,
          abi: AUCTION_ABI,
          functionName: "finalizeAuctionToken",
          args: [auction.id, prices, qtys, decryptionProof],
          account: walletClient.account!,
          chain: walletClient.chain,
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== "success") throw new Error("finalizeAuctionToken reverted")
      }
      onUpdate?.()
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "finalizeAuction failed")
    } finally {
      setFinalizing(false)
    }
  }

  async function handleUnsealMyBid(bidIndex: number) {
    if (!publicClient || !walletClient) return
    setError(null)
    try {
      setBusyReveal(bidIndex)
      await ensureZamaInit(publicClient as never, walletClient)
      const target = bids.find((b) => b.index === bidIndex)
      if (!target) throw new Error("bid not found")
      const plain = (await userDecrypt(target.encPriceHandle, AUCTION_ADDRESS)) as bigint
      setBids((curr) =>
        curr.map((b) => (b.index === bidIndex ? { ...b, plainPrice: plain as bigint } : b)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "unseal failed")
    } finally {
      setBusyReveal(null)
    }
  }

  const needsEnd = !auction.ended
  const needsFinalize = auction.ended && !auction.finalized
  const gasPool = auction.gasDeposit ?? 0n

  return (
    <div>
      <h2 className="font-[var(--font-bebas)] text-2xl md:text-3xl tracking-tight">Results</h2>
      <p className="mt-2 font-mono text-xs text-muted-foreground max-w-2xl">
        The auction deadline has passed. End the auction to publish FHE handles, then finalize to
        decrypt + settle bids and collect the {feePercent}% platform fee.
      </p>

      {error && (
        <div className="mt-4 border border-destructive/50 bg-destructive/10 p-4">
          <p className="font-mono text-xs text-destructive break-all">{error}</p>
        </div>
      )}

      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <button
          onClick={handleEndAuction}
          disabled={!needsEnd || endingAuction}
          className={cn(
            "py-3 px-4 font-mono text-[11px] uppercase tracking-widest border transition-colors",
            needsEnd
              ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
              : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
          )}
        >
          {auction.ended ? "Auction ended" : endingAuction ? "Ending…" : "1. End auction"}
        </button>
        <button
          onClick={handleFinalizeAuction}
          disabled={needsEnd || !needsFinalize || finalizing}
          className={cn(
            "py-3 px-4 font-mono text-[11px] uppercase tracking-widest border transition-colors",
            needsFinalize && !needsEnd
              ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
              : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
          )}
        >
          {auction.finalized
            ? "Finalized"
            : finalizing
              ? "Decrypting + settling…"
              : "2. Finalize (decrypt + settle)"}
        </button>
      </div>

      {gasPool > 0n && !auction.finalized && (
        <p className="mt-3 font-mono text-[10px] text-muted-foreground/70">
          Gas pool: {formatEther(gasPool)} ETH — caller of finalize gets compensated, remainder refunded to seller.
        </p>
      )}

      {auction.finalized && (
        <div className="mt-6 border border-accent/40 bg-accent/5 p-5 font-mono">
          {auction.mode === "ITEM" ? (
            <>
              <p className="text-[10px] uppercase tracking-[0.3em] text-accent">Winner</p>
              <p className="mt-2 text-lg text-foreground break-all">{auction.winnerPlain}</p>
              <p className="mt-3 text-[10px] uppercase tracking-[0.3em] text-accent">Winning bid</p>
              <p className="mt-2 text-2xl tabular-nums text-foreground">
                {formatUsdc(auction.winningAmountPlain, 2)} USDC
              </p>
            </>
          ) : (
            <>
              <p className="text-[10px] uppercase tracking-[0.3em] text-accent">Clearing price</p>
              <p className="mt-2 text-2xl tabular-nums text-foreground">
                {formatUsdc(auction.clearingPricePlain, 2)} USDC / unit
              </p>
              <p className="mt-3 text-[10px] uppercase tracking-[0.3em] text-accent">Unsold supply returned</p>
              <p className="mt-2 text-lg tabular-nums text-foreground">
                {auction.unsoldReturned.toString()} units
              </p>
            </>
          )}
          <p className="mt-3 text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">
            Platform fee: {feePercent}% to Treasury
          </p>
        </div>
      )}

      <div className="mt-10">
        <h3 className="font-[var(--font-bebas)] text-xl tracking-tight">Bid ledger</h3>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
          Your bids show as •••• (sealed). Click &quot;Unseal&quot; to view your own bid amount. All bids settle when finalized.
        </p>
        {loadingBids ? (
          <div className="mt-4 space-y-2">
            <p className="font-mono text-xs text-muted-foreground/60">Loading sealed bids…</p>
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-8 bg-muted/20 animate-pulse border border-border/20 rounded" />
              ))}
            </div>
          </div>
        ) : bids.length === 0 ? (
          <p className="mt-4 font-mono text-xs text-muted-foreground/60">No bids were placed.</p>
        ) : (
          <ul className="mt-4 space-y-2 font-mono text-[12px]">
            {bids.map((b) => {
              const isMyBid = myAddr && b.bidder.toLowerCase() === myAddr.toLowerCase()
              const isWinner =
                auction.finalized &&
                auction.mode === "ITEM" &&
                b.bidder.toLowerCase() === auction.winnerPlain.toLowerCase()
              const showPlain =
                b.plainPrice !== undefined
                  ? `${formatUsdc(b.plainPrice, 2)} USDC`
                  : isWinner
                    ? `${formatUsdc(auction.winningAmountPlain, 2)} USDC`
                    : isMyBid && auction.ended
                      ? "••••• USDC (tap unseal →)"
                      : "sealed"
              return (
                <li
                  key={b.index}
                  className="flex items-center gap-3 justify-between border-b border-border/20 pb-2 flex-wrap"
                >
                  <div className="min-w-0">
                    <span className="text-muted-foreground/80">
                      #{b.index} {b.bidder.slice(0, 6)}…{b.bidder.slice(-4)}
                    </span>
                    {isWinner && (
                      <span className="ml-2 text-accent uppercase tracking-widest text-[9px]">winner</span>
                    )}
                    {isMyBid && (
                      <span className="ml-2 text-purple-400 uppercase tracking-widest text-[9px]">you</span>
                    )}
                    {b.settled && (
                      <span className="ml-2 text-muted-foreground/60 uppercase tracking-widest text-[9px]">
                        {isWinner ? "paid to seller" : b.allocatedTokenX > 0n ? `${b.allocatedTokenX.toString()} units` : "refunded"}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "tabular-nums",
                        showPlain.includes("USDC") ? "text-accent" : "text-purple-400",
                      )}
                    >
                      {showPlain}
                    </span>
                    {isMyBid && b.plainPrice === undefined && auction.ended && (
                      <button
                        onClick={() => handleUnsealMyBid(b.index)}
                        disabled={busyReveal === b.index}
                        className="text-[10px] uppercase tracking-widest px-2 py-1 border border-accent/40 text-accent hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
                      >
                        {busyReveal === b.index ? "…" : "Unseal"}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
