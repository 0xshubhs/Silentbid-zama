/* eslint-disable no-console */
// Standalone refund script — sweeps any remaining ETH from the persisted
// bidders in scripts/.bidders.json back to the deployer, then deletes the
// file. Safe to run multiple times.

import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import { readFileSync, existsSync, unlinkSync } from "node:fs"

const RPC = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://sepolia.gateway.tenderly.co"
const DEPLOYER_PK = process.env.KEEPER_PRIVATE_KEY
if (!DEPLOYER_PK) throw new Error("KEEPER_PRIVATE_KEY missing")

const FILE = new URL("./.bidders.json", import.meta.url).pathname
if (!existsSync(FILE)) {
  console.log("no .bidders.json — nothing to refund")
  process.exit(0)
}

const D = privateKeyToAccount(DEPLOYER_PK)
const pc = createPublicClient({ chain: sepolia, transport: http(RPC) })
const pks = JSON.parse(readFileSync(FILE, "utf8"))
let allOk = true

for (const pk of pks) {
  const acct = privateKeyToAccount(pk)
  const wc = createWalletClient({ account: acct, chain: sepolia, transport: http(RPC) })
  try {
    const bal = await pc.getBalance({ address: acct.address })
    const gasPrice = await pc.getGasPrice()
    const reserve = (gasPrice * 21_000n * 3n) / 2n
    if (bal <= reserve) {
      console.log(`${acct.address} balance ${bal} too low; skip`)
      continue
    }
    const sweep = bal - reserve
    const hash = await wc.sendTransaction({
      to: D.address,
      value: sweep,
      account: acct,
      chain: sepolia,
      gas: 21_000n,
    })
    const r = await pc.waitForTransactionReceipt({ hash })
    if (r.status !== "success") {
      throw new Error(`refund tx ${hash} reverted`)
    }
    console.log(`${acct.address} → ${(Number(sweep) / 1e18).toFixed(5)} ETH ✓ ${hash}`)
  } catch (e) {
    allOk = false
    console.warn(`${acct.address} refund failed:`, e.message?.slice(0, 200) ?? e)
  }
}

if (allOk) {
  unlinkSync(FILE)
  console.log(`deleted ${FILE}`)
} else {
  console.warn(`KEEPING ${FILE} — rerun to retry`)
  process.exit(1)
}
