"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"
import type { AuctionStatus } from "@/lib/zama-contracts"

const TABS: { value: "all" | AuctionStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "ended", label: "Ended" },
  { value: "finalized", label: "Settled" },
]

export function AuctionStatusTabs() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const current = searchParams.get("status") || "all"

  function setStatus(value: string) {
    const next = new URLSearchParams(searchParams)
    if (value === "all") next.delete("status")
    else next.set("status", value)
    router.push(`/auctions?${next.toString()}`)
  }

  return (
    <div className="flex flex-wrap gap-2 font-mono text-xs">
      {TABS.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => setStatus(value)}
          className={cn(
            "px-4 py-2 uppercase tracking-widest border transition-all duration-200",
            current === value
              ? "border-accent text-accent bg-accent/10"
              : "border-border/40 text-muted-foreground hover:border-foreground/40 hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
