import { getDefaultConfig } from "@rainbow-me/rainbowkit"
import { sepolia } from "viem/chains"
import { http } from "wagmi"

const RPC =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://eth-sepolia.public.blastapi.io"

export const wagmiConfig = getDefaultConfig({
  appName: "SilentBID-ZAMA",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "demo",
  chains: [sepolia],
  transports: { [sepolia.id]: http(RPC) },
  ssr: true,
})
