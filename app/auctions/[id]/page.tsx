"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useAccount, usePublicClient } from "wagmi"
import { useEffect, useState, useCallback, useRef } from "react"
import { PlaceBidForm } from "./place-bid-form"
import { LatestBids } from "./latest-bids"
import { RevealPanel } from "./reveal-panel"
import { cn } from "@/lib/utils"
import { chainId, networkName } from "@/lib/chain-config"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  formatUsdc,
  auctionStatus,
  parseAuctionTuple,
  type AuctionData,
  type AuctionStatus,
} from "@/lib/zama-contracts"

function statusLabel(s: AuctionStatus) {
  switch (s) {
    case "live": return "Live"
    case "ended": return "Ended"
    case "finalized": return "Settled"
  }
}

function secondsToTime(s: number): string {
  if (s <= 0) return "0s"
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export default function AuctionDetailPage() {
  const params = useParams()
  const idStr = params.id as string
  const auctionId = (() => {
    try { return BigInt(idStr) } catch { return null }
  })()
  const { address: myAddr } = useAccount()
  const publicClient = usePublicClient({ chainId })

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  const [auction, setAuction] = useState<AuctionData | null>(null)
  const [bidCount, setBidCount] = useState<bigint>(0n)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])
  const lastFetchedId = useRef<string | null>(null)

  const fetchAuction = useCallback(async () => {
    if (!publicClient || auctionId === null || !AUCTION_ADDRESS) return
    try {
      const tup = await publicClient.readContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "getAuction",
        args: [auctionId],
      })
      const cnt = (await publicClient.readContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "bidCount",
        args: [auctionId],
      })) as bigint
      const v = parseAuctionTuple(tup, auctionId)
      v.numBids = cnt
      setAuction(v)
      setBidCount(cnt)
      setFetchError(null)
    } catch (err) {
      if (!auction) setFetchError(err instanceof Error ? err.message : "Failed to fetch auction")
    } finally {
      setLoading(false)
    }
  }, [publicClient, auctionId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (auctionId === null) return
    const key = auctionId.toString()
    if (lastFetchedId.current === key) fetchAuction()
    else {
      lastFetchedId.current = key
      fetchAuction()
    }
  }, [auctionId, fetchAuction, refreshKey])

  useEffect(() => {
    const t = setInterval(() => fetchAuction(), 10_000)
    return () => clearInterval(t)
  }, [fetchAuction])

  if (auctionId === null) {
    return (
      <div className="px-6 md:px-12 py-12 md:py-20">
        <Link href="/auctions" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors">
          &larr; All auctions
        </Link>
        <div className="mt-8 border border-destructive/50 bg-destructive/10 p-6">
          <p className="font-mono text-sm text-destructive">Invalid auction id.</p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="px-6 md:px-12 py-12 md:py-20">
        <p className="font-mono text-sm text-muted-foreground animate-pulse">
          Loading auction from {networkName}...
        </p>
      </div>
    )
  }

  if (fetchError || !auction) {
    return (
      <div className="px-6 md:px-12 py-12 md:py-20">
        <Link href="/auctions" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors">
          &larr; All auctions
        </Link>
        <div className="mt-8 border border-destructive/50 bg-destructive/10 p-6">
          <p className="font-mono text-sm text-destructive">{fetchError ?? "Auction not found."}</p>
        </div>
      </div>
    )
  }

  const status = auctionStatus(auction, now)
  const secondsLeft = Number(auction.endTime) - now
  const canBid = status === "live"
  const isSeller = myAddr && myAddr.toLowerCase() === auction.seller.toLowerCase()

  return (
    <div className="px-6 md:px-12 py-12 md:py-20">
      <Link href="/auctions" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors">
        &larr; All auctions
      </Link>

      <div className="mt-8 md:mt-12 max-w-5xl">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-[var(--font-bebas)] text-4xl md:text-6xl tracking-tight">
            {auction.itemName || `AUCTION #${auction.id.toString()}`}
          </h1>
          <span className={cn(
            "font-mono text-[10px] uppercase tracking-widest px-2 py-1 border",
            status === "live" && "border-accent/60 text-accent",
            status === "ended" && "border-yellow-500/60 text-yellow-500",
            status === "finalized" && "border-muted-foreground/40 text-muted-foreground",
          )}>
            {statusLabel(status)}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-widest px-2 py-1 border border-purple-500/60 text-purple-400">
            FHE-Encrypted
          </span>
        </div>
        {auction.itemDescription && (
          <p className="mt-3 font-mono text-sm text-muted-foreground max-w-2xl">
            {auction.itemDescription}
          </p>
        )}
        <p className="mt-3 font-mono text-[10px] text-muted-foreground/60">
          Seller {auction.seller.slice(0, 6)}…{auction.seller.slice(-4)} · Auction #{auction.id.toString()} · {networkName}
        </p>

        <dl className="mt-10 grid grid-cols-2 md:grid-cols-4 gap-6 font-mono text-sm">
          <div>
            <dt className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Floor (display)</dt>
            <dd className="mt-1 text-foreground">{formatUsdc(auction.minBidPlain, 2)} USDC</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Sealed bids</dt>
            <dd className="mt-1 text-foreground">{bidCount.toString()}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
              {status === "live" ? "Ends in" : "Ended"}
            </dt>
            <dd className="mt-1 text-foreground">
              {status === "live" ? `~${secondsToTime(secondsLeft)}` : "Closed"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
              {auction.finalized ? "Winning bid" : "Winning bid"}
            </dt>
            <dd className="mt-1 text-foreground">
              {auction.finalized
                ? `${formatUsdc(auction.winningAmountPlain, 2)} USDC`
                : <span className="text-purple-400 text-[10px]">hidden until finalized</span>}
            </dd>
          </div>
        </dl>

        <div className="mt-8 border border-purple-500/30 bg-purple-500/5 p-4 font-mono text-[10px] text-muted-foreground space-y-1">
          <p className="text-purple-400 uppercase tracking-widest">Zama FHE sealed-bid auction</p>
          <p>Bid amounts are FHE-encrypted end to end. The running max is computed on-chain over encrypted handles. Bidders can opt in to reveal their own bid after the auction ends.</p>
        </div>

        {canBid && (
          <div className="mt-14 pt-10 border-t border-border/40">
            <div className="grid grid-cols-1 md:grid-cols-[1fr,minmax(280px,380px)] gap-8 md:gap-12 items-start">
              <div className="min-w-0">
                <h2 className="font-[var(--font-bebas)] text-2xl md:text-3xl tracking-tight">Place sealed bid</h2>
                <p className="mt-2 font-mono text-xs text-muted-foreground">
                  The amount stays encrypted on-chain. Your cUSDC is escrowed until settlement.
                </p>
                {isSeller ? (
                  <p className="mt-6 font-mono text-xs text-yellow-500/80">
                    You are the seller of this auction and cannot bid.
                  </p>
                ) : (
                  <PlaceBidForm auctionId={auction.id} auction={auction} onBidSuccess={bumpRefresh} />
                )}
              </div>
              <div className="min-w-0 border border-border/40 rounded-sm p-4 bg-muted/20">
                <h3 className="font-[var(--font-bebas)] text-xl tracking-tight text-muted-foreground mb-3">Sealed bids</h3>
                <LatestBids auctionId={auction.id} refreshKey={refreshKey} />
              </div>
            </div>
          </div>
        )}

        {(status === "ended" || status === "finalized") && (
          <div className="mt-14 pt-10 border-t border-border/40">
            <RevealPanel auction={auction} onUpdate={bumpRefresh} />
          </div>
        )}
      </div>
    </div>
  )
}
