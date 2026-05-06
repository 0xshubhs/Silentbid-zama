/* eslint-disable no-console */
/**
 * Cron-flow E2E test (zero-bid auctions).
 *
 *   node --env-file=.env.local scripts/local-e2e-cron.mjs
 *
 * What this proves:
 *   1. POST /api/scheduler successfully registers a one-shot at cron-job.org
 *      using the on-chain endTime (not anything client-supplied).
 *   2. cron-job.org actually pings our tunnel URL ~90s after endTime.
 *   3. The /api/cron/finalize?auctionId=N route processes the live → ended →
 *      finalized state machine for a specific auction in one invocation.
 *
 * What this does NOT cover:
 *   - Bid placement (FHE encryption, cUSDC wrap, etc). We've already verified
 *     bidding works end-to-end via the UI; the cron flow is independent.
 *
 * The contract handles 0-bid auctions correctly: `finalizeAuctionItem` writes
 * winner=address(0), amount=0 and marks the auction finalized — exactly the
 * code path we want to exercise.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseAbi,
  decodeEventLog,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"

const RPC = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://sepolia.gateway.tenderly.co"
const DEPLOYER_PK = process.env.KEEPER_PRIVATE_KEY
const KEEPER_URL = (process.env.KEEPER_URL ?? "").replace(/\/$/, "")
const AUCTION_ADDR = process.env.NEXT_PUBLIC_AUCTION_ADDRESS

if (!DEPLOYER_PK?.startsWith("0x")) throw new Error("KEEPER_PRIVATE_KEY missing")
if (!KEEPER_URL) throw new Error("KEEPER_URL missing")
if (!AUCTION_ADDR) throw new Error("NEXT_PUBLIC_AUCTION_ADDRESS missing")

console.log("[boot]", { RPC, KEEPER_URL, AUCTION_ADDR })

const AUCTION_ABI = parseAbi([
  "function createAuctionItem(string itemName, string itemDescription, uint64 minBidPlain, uint64 durationSeconds) payable returns (uint256)",
  "function getAuction(uint256 id) view returns ((uint8 mode,address seller,string itemName,string itemDescription,address tokenX,uint256 totalSupply,uint64 minBidPlain,bytes32 minBidEnc,uint64 endTime,bool ended,bool finalized,bytes32 runningHighestBid,bytes32 runningHighestBidder,address winnerPlain,uint64 winningAmountPlain,uint64 clearingPricePlain,uint256 unsoldReturned,uint256 gasDeposit))",
  "event AuctionCreatedItem(uint256 indexed auctionId, address indexed seller, string itemName, uint64 minBidPlain, uint64 endTime, uint256 gasDeposit)",
])

const D = privateKeyToAccount(DEPLOYER_PK)
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) })
const walletClient = createWalletClient({ account: D, chain: sepolia, transport: http(RPC) })
console.log("[deployer]", D.address)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let _nonce = null
async function nextNonce() {
  if (_nonce === null) {
    _nonce = Number(await publicClient.getTransactionCount({ address: D.address, blockTag: "pending" }))
    console.log(`[nonce] starting at ${_nonce}`)
  }
  return _nonce++
}

async function waitTx(hash, label) {
  const r = await publicClient.waitForTransactionReceipt({ hash })
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`)
  console.log(`  ${label} ✓ ${hash}`)
  return r
}

async function createAuction(durationSec, name) {
  console.log(`\n[auction] creating ${name} (${durationSec}s)`)
  const nonce = await nextNonce()
  const hash = await walletClient.writeContract({
    address: AUCTION_ADDR,
    abi: AUCTION_ABI,
    functionName: "createAuctionItem",
    args: [name, `cron flow E2E (${durationSec}s)`, 1_000_000n, BigInt(durationSec)],
    account: D,
    chain: sepolia,
    value: parseEther("0.005"),
    gas: 1_500_000n,
    nonce,
  })
  const receipt = await waitTx(hash, `createAuctionItem(${name})`)
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: AUCTION_ABI, data: log.data, topics: log.topics })
      if (decoded.eventName === "AuctionCreatedItem") {
        const id = decoded.args.auctionId
        const endTime = decoded.args.endTime
        console.log(`  → auctionId=${id} endTime=${endTime} (${new Date(Number(endTime) * 1000).toISOString()})`)
        return { id, endTime: Number(endTime) }
      }
    } catch {}
  }
  throw new Error("no AuctionCreatedItem event")
}

async function scheduleAuction(auctionId) {
  console.log(`\n[schedule] POST /api/scheduler { auctionId: ${auctionId} }`)
  const res = await fetch(`${KEEPER_URL}/api/scheduler`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auctionId: auctionId.toString() }),
  })
  const body = await res.json()
  console.log(`  → ${res.status}`, JSON.stringify(body))
  if (!res.ok) throw new Error(`scheduler failed: ${JSON.stringify(body)}`)
  return body
}

async function pollUntilFinalized(auctionId, label, expectedEndTime, deadlineMs) {
  console.log(`\n[poll] watching auction ${auctionId} (${label}); endTime=${expectedEndTime} (${new Date(expectedEndTime * 1000).toISOString()})`)
  const start = Date.now()
  let endedAt = null
  while (Date.now() < deadlineMs) {
    try {
      const a = await publicClient.readContract({
        address: AUCTION_ADDR,
        abi: AUCTION_ABI,
        functionName: "getAuction",
        args: [auctionId],
      })
      const state = a.finalized ? "FINALIZED" : a.ended ? "ENDED" : "LIVE"
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)
      const sinceEnd = ((Date.now() / 1000) - expectedEndTime).toFixed(0)
      console.log(`  [t+${elapsed}s | endTime${sinceEnd >= 0 ? "+" : ""}${sinceEnd}s] auction ${auctionId} state=${state}`)
      if (a.ended && !endedAt) endedAt = Date.now()
      if (a.finalized) {
        console.log(`  ✓ ${label} FINALIZED  endTime→ended=${((endedAt - start) / 1000).toFixed(0)}s  endTime→finalized=${(((Date.now()) / 1000 - expectedEndTime)).toFixed(0)}s after endTime`)
        return a
      }
    } catch (e) {
      console.warn(`  [poll] read failed (transient): ${e.message?.slice(0, 120)}`)
    }
    await sleep(15_000)
  }
  throw new Error(`${label} did not finalize before deadline`)
}

async function main() {
  const t0 = Date.now()

  const a3 = await createAuction(180, "E2E-3min-cron")
  const a15 = await createAuction(15 * 60, "E2E-15min-cron")

  await scheduleAuction(a3.id)
  await scheduleAuction(a15.id)

  console.log(`\n[wait] both auctions scheduled. cron-job.org should ping endTime+90s.`)
  console.log(`  3-min auction ${a3.id}: cron ping ~${new Date((a3.endTime + 90) * 1000).toISOString()}`)
  console.log(`  15-min auction ${a15.id}: cron ping ~${new Date((a15.endTime + 90) * 1000).toISOString()}`)

  // 3-min: deadline 6 min after endTime (gives cron-job.org 4 min of slack
  // before GH safety net would otherwise need to take over).
  await pollUntilFinalized(a3.id, "3-min auction", a3.endTime, (a3.endTime + 6 * 60) * 1000)
  // 15-min: same idea — 6 min slack after endTime.
  await pollUntilFinalized(a15.id, "15-min auction", a15.endTime, (a15.endTime + 6 * 60) * 1000)

  console.log(`\n[done] total ${((Date.now() - t0) / 1000 / 60).toFixed(1)} minutes`)
  process.exit(0)
}

main().catch((e) => {
  console.error("[fatal]", e)
  process.exit(1)
})
