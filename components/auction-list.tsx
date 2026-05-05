"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import Link from "next/link"
import { usePublicClient } from "wagmi"
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

const CACHE_TTL = 15_000

function statusLabel(s: AuctionStatus) {
  switch (s) {
    case "live": return "Live"
    case "ended": return "Ended"
    case "finalized": return "Settled"
  }
}

const STATUS_ORDER: Record<AuctionStatus, number> = { live: 0, ended: 1, finalized: 2 }

function secondsToTime(seconds: number): string {
  if (seconds <= 0) return "0s"
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

export function AuctionList({ filter }: { filter?: AuctionStatus }) {
  const publicClient = usePublicClient({ chainId })
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  const [auctions, setAuctions] = useState<AuctionData[]>([])
  const [bidCounts, setBidCounts] = useState<Record<string, bigint>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const lastFetchRef = useRef<number>(0)
  const fetchingRef = useRef(false)

  const fetchAuctions = useCallback(async (isBackground: boolean) => {
    if (!publicClient || !AUCTION_ADDRESS || fetchingRef.current) return
    fetchingRef.current = true
    try {
      if (!isBackground) setLoading(true)
      // `auctionCount` returns the next auction id (i.e. total minted so far,
      // since ids are 1-indexed in the v1 Zama contract — we still iterate from
      // 1 below).
      const next = (await publicClient.readContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "auctionCount",
      })) as bigint
      const total = Number(next)

      if (total === 0) {
        setAuctions([])
        setError(null)
        lastFetchRef.current = Date.now()
        return
      }

      const contracts = Array.from({ length: total }, (_, i) => ({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "getAuction" as const,
        args: [BigInt(i + 1)] as const,
      }))
      const results = await publicClient.multicall({ contracts })
      const list: AuctionData[] = results
        .map((r, i): AuctionData | null => {
          if (r.status !== "success") return null
          return parseAuctionTuple(r.result, BigInt(i + 1))
        })
        .filter((x): x is AuctionData => x !== null)
      setAuctions(list)

      // Fetch bidCount per auction in a second multicall.
      const bidCountContracts = list.map((a) => ({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "bidCount" as const,
        args: [a.id] as const,
      }))
      const bidResults = await publicClient.multicall({ contracts: bidCountContracts })
      const counts: Record<string, bigint> = {}
      bidResults.forEach((r, i) => {
        counts[list[i].id.toString()] = r.status === "success" ? (r.result as bigint) : 0n
      })
      setBidCounts(counts)

      setError(null)
      lastFetchRef.current = Date.now()
    } catch (err) {
      if (auctions.length === 0) {
        setError(err instanceof Error ? err.message : "Failed to fetch auctions")
      }
    } finally {
      setLoading(false)
      fetchingRef.current = false
    }
  }, [publicClient]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!publicClient) return
    fetchAuctions(false)
  }, [publicClient, fetchAuctions])

  useEffect(() => {
    if (!publicClient) return
    const interval = setInterval(() => {
      if (Date.now() - lastFetchRef.current >= CACHE_TTL) fetchAuctions(true)
    }, CACHE_TTL)
    return () => clearInterval(interval)
  }, [publicClient, fetchAuctions])

  const withLiveStatus = auctions.map((a) => ({ ...a, _status: auctionStatus(a, now) }))
  const filtered = filter
    ? withLiveStatus.filter((a) => a._status === filter)
    : [...withLiveStatus].sort((a, b) => STATUS_ORDER[a._status] - STATUS_ORDER[b._status])

  if (loading) {
    return (
      <div className="border border-border/40 p-12 text-center">
        <p className="font-mono text-sm text-muted-foreground animate-pulse">
          Loading auctions from {networkName}...
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="border border-destructive/50 bg-destructive/10 p-6">
        <p className="font-mono text-sm text-destructive">{error}</p>
      </div>
    )
  }

  if (!AUCTION_ADDRESS) {
    return (
      <div className="border border-border/40 p-12 text-center">
        <p className="font-mono text-sm text-muted-foreground">
          Auction contract not configured. Set <code className="text-accent">NEXT_PUBLIC_AUCTION_ADDRESS</code> in .env.local.
        </p>
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="border border-border/40 p-12 md:p-16 text-center">
        <p className="font-mono text-sm text-muted-foreground">
          {filter
            ? `No ${statusLabel(filter).toLowerCase()} auctions right now.`
            : `No auctions yet on ${networkName}.`}
        </p>
        {filter && (
          <Link href="/auctions" className="mt-4 inline-block font-mono text-xs uppercase tracking-widest text-accent hover:underline">
            View all
          </Link>
        )}
      </div>
    )
  }

  return (
    <>
      <span className="mb-4 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {filtered.length} auction{filtered.length !== 1 ? "s" : ""} on {networkName}
      </span>
      <ul className="grid gap-4 md:gap-6">
        {filtered.map((auction) => {
          const secondsLeft = Number(auction.endTime) - now
          return (
            <li key={auction.id.toString()}>
              <Link
                href={`/auctions/${auction.id.toString()}`}
                className={cn(
                  "block border border-border/40 p-6 md:p-8 transition-all duration-200",
                  "hover:border-accent/60 hover:bg-accent/5",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="font-[var(--font-bebas)] text-2xl md:text-4xl tracking-tight">
                        {auction.itemName || `AUCTION #${auction.id.toString()}`}
                      </span>
                      <span className={cn(
                        "font-mono text-[10px] uppercase tracking-widest px-2 py-1 border",
                        auction._status === "live" && "border-accent/60 text-accent",
                        auction._status === "ended" && "border-yellow-500/60 text-yellow-500",
                        auction._status === "finalized" && "border-muted-foreground/40 text-muted-foreground",
                      )}>
                        {statusLabel(auction._status)}
                      </span>
                    </div>
                    {auction.itemDescription && (
                      <p className="mt-2 font-mono text-xs text-muted-foreground max-w-md truncate">
                        {auction.itemDescription}
                      </p>
                    )}
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
                      Seller {auction.seller.slice(0, 6)}…{auction.seller.slice(-4)} · #{auction.id.toString()}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-6 md:gap-10 font-mono text-xs text-muted-foreground">
                    <div>
                      <span className="block text-[10px] uppercase tracking-widest text-muted-foreground/70">Floor</span>
                      <span className="text-foreground">{formatUsdc(auction.minBidPlain, 2)} USDC</span>
                    </div>
                    <div>
                      <span className="block text-[10px] uppercase tracking-widest text-muted-foreground/70">Bids</span>
                      <span className="text-foreground">{(bidCounts[auction.id.toString()] ?? 0n).toString()}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] uppercase tracking-widest text-muted-foreground/70">
                        {auction._status === "live" ? "Ends in" : auction._status === "finalized" ? "Winner paid" : "Ended"}
                      </span>
                      <span className="text-foreground">
                        {auction._status === "live"
                          ? `~${secondsToTime(secondsLeft)}`
                          : auction._status === "finalized"
                            ? `${formatUsdc(auction.winningAmountPlain, 2)} USDC`
                            : "Closed"}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
    </>
  )
}
