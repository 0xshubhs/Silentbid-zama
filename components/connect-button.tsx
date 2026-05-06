"use client"

import { ConnectButton } from "@rainbow-me/rainbowkit"
import { cn } from "@/lib/utils"

export function ConnectButtonWrapper({ className }: { className?: string }) {
  return (
    <div className={cn(className)}>
      <ConnectButton showBalance chainStatus="full" />
    </div>
  )
}
