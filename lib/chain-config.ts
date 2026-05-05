import { sepolia } from "viem/chains"

export const activeChain = sepolia
export const chainId = sepolia.id // 11155111
export const networkName = "Sepolia FHEVM"
export const blockExplorerUrl = sepolia.blockExplorers?.default.url ?? "https://sepolia.etherscan.io"
