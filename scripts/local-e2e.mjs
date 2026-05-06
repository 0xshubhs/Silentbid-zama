/* eslint-disable no-console */
/**
 * Local E2E test driver for the cron-job.org one-shot keeper flow.
 *
 * Run with:
 *   node --env-file=.env.local scripts/local-e2e.mjs
 *
 * The script:
 *   1. Loads (or generates and persists) 3 bidder EOAs to scripts/.bidders.json.
 *   2. Funds each with 0.04 Sepolia ETH from the deployer.
 *   3. For each bidder: mint 200 USDC, approve cUSDC, wrap 100 USDC → cUSDC.
 *   4. Deployer creates a 3-min ITEM auction.
 *   5. Deployer creates a 15-min ITEM auction.
 *   6. POSTs /api/scheduler for both auctions (registers cron-job.org one-shots).
 *   7. Each bidder places one encrypted bid on each auction (different prices).
 *   8. Polls chain state every 20s and prints when each auction reaches
 *      ended → finalized.
 *   9. Sweeps remaining bidder ETH back to the deployer.
 *
 * Persistence: bidder keys live in scripts/.bidders.json (gitignored). If the
 * script crashes mid-run, rerun it — the same bidders will be reused so no
 * funds get stranded. The file is deleted only after a successful refund.
 *
 * Nonce: explicit local nonce tracking for the deployer. Tenderly's RPC
 * occasionally returns stale `eth_getTransactionCount` for sequential txs;
 * we read once at the start and increment locally to be safe.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseAbi,
  decodeEventLog,
} from "viem"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { sepolia } from "viem/chains"
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node"
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"

// ----------------------- env / config -----------------------

const RPC = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://sepolia.gateway.tenderly.co"
const DEPLOYER_PK = process.env.KEEPER_PRIVATE_KEY
const CRON_SECRET = process.env.CRON_SECRET
const KEEPER_URL = (process.env.KEEPER_URL ?? "").replace(/\/$/, "")
const USDC_ADDR = process.env.NEXT_PUBLIC_USDC_ADDRESS
const CUSDC_ADDR = process.env.NEXT_PUBLIC_CUSDC_ADDRESS
const AUCTION_ADDR = process.env.NEXT_PUBLIC_AUCTION_ADDRESS

if (!DEPLOYER_PK || !DEPLOYER_PK.startsWith("0x")) throw new Error("KEEPER_PRIVATE_KEY missing/malformed")
if (!CRON_SECRET) throw new Error("CRON_SECRET missing")
if (!KEEPER_URL) throw new Error("KEEPER_URL missing")
if (!USDC_ADDR || !CUSDC_ADDR || !AUCTION_ADDR) throw new Error("contract addresses missing")

console.log("[boot]", { RPC, KEEPER_URL, USDC_ADDR, CUSDC_ADDR, AUCTION_ADDR })

const BIDDERS_FILE = new URL("./.bidders.json", import.meta.url).pathname

// ----------------------- ABIs -----------------------

const USDC_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
])

const CUSDC_ABI = parseAbi([
  "function wrap(uint64 amount)",
  "function approve(address spender, bytes32 encExtAmount, bytes inputProof)",
  "function balanceOf(address account) view returns (bytes32)",
])

const AUCTION_ABI = parseAbi([
  "function createAuctionItem(string itemName, string itemDescription, uint64 minBidPlain, uint64 durationSeconds) payable returns (uint256)",
  "function placeBid(uint256 auctionId, bytes32 encExtPrice, bytes32 encExtQty, bytes priceProof, bytes qtyProof) payable returns (uint256)",
  "function getAuction(uint256 id) view returns ((uint8 mode,address seller,string itemName,string itemDescription,address tokenX,uint256 totalSupply,uint64 minBidPlain,bytes32 minBidEnc,uint64 endTime,bool ended,bool finalized,bytes32 runningHighestBid,bytes32 runningHighestBidder,address winnerPlain,uint64 winningAmountPlain,uint64 clearingPricePlain,uint256 unsoldReturned,uint256 gasDeposit))",
  "function nextAuctionId() view returns (uint256)",
  "event AuctionCreatedItem(uint256 indexed auctionId, address indexed seller, string itemName, uint64 minBidPlain, uint64 endTime, uint256 gasDeposit)",
])

// ----------------------- clients + nonce mgmt -----------------------

const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) })

function walletFor(pk) {
  const acct = privateKeyToAccount(pk)
  return {
    account: acct,
    address: acct.address,
    client: createWalletClient({ account: acct, chain: sepolia, transport: http(RPC) }),
  }
}

const D = walletFor(DEPLOYER_PK)
console.log("[deployer]", D.address)

// Local nonce counter — explicit so we don't get bitten by RPC eventual
// consistency on `eth_getTransactionCount`. Initialised once at startup; we
// pre-increment for every tx broadcast from the deployer.
let _deployerNonce = null
async function nextDeployerNonce() {
  if (_deployerNonce === null) {
    _deployerNonce = Number(
      await publicClient.getTransactionCount({ address: D.address, blockTag: "pending" }),
    )
    console.log(`[nonce] deployer starting at ${_deployerNonce}`)
  }
  return _deployerNonce++
}

// ----------------------- utilities -----------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitTx(hash, label) {
  const r = await publicClient.waitForTransactionReceipt({ hash })
  if (r.status !== "success") {
    throw new Error(`${label} reverted: ${hash}`)
  }
  console.log(`  ${label} ✓ ${hash}`)
  return r
}

function bytes32From(handle) {
  return `0x${handle.toString(16).padStart(64, "0")}`
}

// Lightweight retry wrapper for RPC calls that can hit transient rate-limits
// (Tenderly returns "Request exceeds defined limit" on bursty load).
async function retry(fn, label, attempts = 3, baseMs = 2000) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const msg = e?.message ?? String(e)
      const isTransient =
        msg.includes("exceeds defined limit") ||
        msg.includes("rate limit") ||
        msg.includes("429") ||
        msg.includes("ECONNRESET") ||
        msg.includes("timeout")
      console.warn(`  [retry] ${label} attempt ${i + 1}/${attempts} failed${isTransient ? " (transient)" : ""}: ${msg.slice(0, 160)}`)
      if (!isTransient) break
      await sleep(baseMs * Math.pow(2, i))
    }
  }
  throw lastErr
}

// ----------------------- bidders: load or generate -----------------------

const NUM_BIDDERS = 3

function loadOrCreateBidders() {
  let pks
  if (existsSync(BIDDERS_FILE)) {
    pks = JSON.parse(readFileSync(BIDDERS_FILE, "utf8"))
    if (!Array.isArray(pks) || pks.length !== NUM_BIDDERS) {
      throw new Error(`bad ${BIDDERS_FILE} — delete it manually if you're sure`)
    }
    console.log(`[bidders] reusing ${BIDDERS_FILE}`)
  } else {
    pks = Array.from({ length: NUM_BIDDERS }, () => generatePrivateKey())
    writeFileSync(BIDDERS_FILE, JSON.stringify(pks, null, 2), "utf8")
    console.log(`[bidders] generated and persisted to ${BIDDERS_FILE}`)
  }
  return pks.map(walletFor)
}

const bidders = loadOrCreateBidders()
console.log("[bidders]")
bidders.forEach((b, i) => console.log(`  #${i}`, b.address))

// ----------------------- step 2: fund bidders -----------------------

async function fundBidders() {
  console.log("\n[fund] sending 0.04 ETH to each bidder (only those <0.03)")
  for (const b of bidders) {
    const bal = await publicClient.getBalance({ address: b.address })
    if (bal >= parseEther("0.03")) {
      console.log(`  ${b.address.slice(0, 8)}… already has ${(Number(bal) / 1e18).toFixed(4)} ETH; skip`)
      continue
    }
    const nonce = await nextDeployerNonce()
    const hash = await retry(
      () =>
        D.client.sendTransaction({
          to: b.address,
          value: parseEther("0.04"),
          account: D.account,
          chain: sepolia,
          nonce,
        }),
      `fund-bcast ${b.address.slice(0, 8)}…`,
    )
    await waitTx(hash, `fund ${b.address.slice(0, 8)}…`)
  }
}

// ----------------------- step 3: mint, approve, wrap -----------------------

async function setupCUSDC() {
  console.log("\n[cUSDC] mint 200 USDC + approve + wrap 100 USDC for each bidder (skip if already wrapped)")
  await Promise.all(
    bidders.map(async (b) => {
      const cusdcHandle = await publicClient.readContract({
        address: CUSDC_ADDR,
        abi: CUSDC_ABI,
        functionName: "balanceOf",
        args: [b.address],
      })
      const ZERO_HANDLE = "0x0000000000000000000000000000000000000000000000000000000000000000"
      if (cusdcHandle !== ZERO_HANDLE) {
        console.log(`  ${b.address.slice(0, 8)}… already has cUSDC handle; skip wrap`)
        return
      }
      const mintHash = await b.client.writeContract({
        address: USDC_ADDR,
        abi: USDC_ABI,
        functionName: "mint",
        args: [b.address, 200_000_000n],
        account: b.account,
        chain: sepolia,
        gas: 200_000n,
      })
      await waitTx(mintHash, `mint USDC ${b.address.slice(0, 8)}…`)

      const approveHash = await b.client.writeContract({
        address: USDC_ADDR,
        abi: USDC_ABI,
        functionName: "approve",
        args: [CUSDC_ADDR, 200_000_000n],
        account: b.account,
        chain: sepolia,
        gas: 200_000n,
      })
      await waitTx(approveHash, `approve USDC→cUSDC ${b.address.slice(0, 8)}…`)

      const wrapHash = await b.client.writeContract({
        address: CUSDC_ADDR,
        abi: CUSDC_ABI,
        functionName: "wrap",
        args: [100_000_000n],
        account: b.account,
        chain: sepolia,
        gas: 1_500_000n,
      })
      await waitTx(wrapHash, `wrap 100 cUSDC ${b.address.slice(0, 8)}…`)
    }),
  )
}

// ----------------------- step 4: create auctions -----------------------

async function createAuction(durationSec, name) {
  console.log(`\n[auction] creating ${name} (${durationSec}s)`)
  const nonce = await nextDeployerNonce()
  const hash = await D.client.writeContract({
    address: AUCTION_ADDR,
    abi: AUCTION_ABI,
    functionName: "createAuctionItem",
    args: [name, `E2E test (${durationSec}s)`, 1_000_000n, BigInt(durationSec)],
    account: D.account,
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
        return { id, endTime }
      }
    } catch {}
  }
  throw new Error("no AuctionCreatedItem event")
}

// ----------------------- step 5: schedule via /api/scheduler -----------------------

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

// ----------------------- step 6: place encrypted bids -----------------------

let _zama
async function getZama() {
  if (_zama) return _zama
  console.log("\n[zama] initialising relayer-sdk/node …")
  const t0 = Date.now()
  _zama = await createInstance({ ...SepoliaConfig, network: RPC })
  console.log(`  ready in ${Date.now() - t0}ms`)
  return _zama
}

async function placeBid(bidder, auctionId, priceUsdc) {
  const z = await getZama()
  const priceRaw = BigInt(Math.floor(priceUsdc * 1_000_000))
  const qtyRaw = 1n

  const auctionInput = z.createEncryptedInput(AUCTION_ADDR, bidder.address)
  auctionInput.add64(priceRaw)
  auctionInput.add64(qtyRaw)
  const auctionEnc = await auctionInput.encrypt()

  const cusdcInput = z.createEncryptedInput(CUSDC_ADDR, bidder.address)
  cusdcInput.add64(priceRaw * qtyRaw)
  const cusdcEnc = await cusdcInput.encrypt()

  const approveHash = await bidder.client.writeContract({
    address: CUSDC_ADDR,
    abi: CUSDC_ABI,
    functionName: "approve",
    args: [AUCTION_ADDR, bytes32From(cusdcEnc.handles[0]), cusdcEnc.inputProof],
    account: bidder.account,
    chain: sepolia,
    gas: 3_500_000n,
  })
  await waitTx(approveHash, `cUSDC.approve ${bidder.address.slice(0, 8)}…`)

  const bidHash = await bidder.client.writeContract({
    address: AUCTION_ADDR,
    abi: AUCTION_ABI,
    functionName: "placeBid",
    args: [
      auctionId,
      bytes32From(auctionEnc.handles[0]),
      bytes32From(auctionEnc.handles[1]),
      auctionEnc.inputProof,
      auctionEnc.inputProof,
    ],
    account: bidder.account,
    chain: sepolia,
    gas: 12_000_000n,
  })
  await waitTx(bidHash, `placeBid id=${auctionId} bidder=${bidder.address.slice(0, 8)}… price=${priceUsdc}`)
}

// ----------------------- refund: sweep ETH back to deployer -----------------------

async function refundEth() {
  console.log("\n[refund] sweeping bidder ETH back to deployer", D.address)
  let allOk = true
  for (const b of bidders) {
    try {
      const bal = await publicClient.getBalance({ address: b.address })
      const gasPrice = await publicClient.getGasPrice()
      const reserve = (gasPrice * 21_000n * 3n) / 2n
      if (bal <= reserve) {
        console.log(`  ${b.address.slice(0, 8)}… balance ${bal} too low to sweep; skip`)
        continue
      }
      const sweep = bal - reserve
      const hash = await retry(
        () =>
          b.client.sendTransaction({
            to: D.address,
            value: sweep,
            account: b.account,
            chain: sepolia,
            gas: 21_000n,
          }),
        `refund-bcast ${b.address.slice(0, 8)}…`,
      )
      await waitTx(hash, `refund ${b.address.slice(0, 8)}… → ${(Number(sweep) / 1e18).toFixed(5)} ETH`)
    } catch (e) {
      allOk = false
      console.warn(`  refund ${b.address.slice(0, 8)}… failed:`, e.message?.slice(0, 200) ?? e)
    }
  }
  // Only delete the bidder file if every refund succeeded — otherwise we
  // need the keys around to retry.
  if (allOk && existsSync(BIDDERS_FILE)) {
    unlinkSync(BIDDERS_FILE)
    console.log(`  deleted ${BIDDERS_FILE}`)
  } else if (!allOk) {
    console.warn(`  KEEPING ${BIDDERS_FILE} for retry — rerun the script to recover stranded funds`)
  }
}

// ----------------------- step 7: poll for finalization -----------------------

async function pollUntilFinalized(auctionId, label, deadlineMs) {
  console.log(`\n[poll] watching auction ${auctionId} (${label})`)
  const start = Date.now()
  while (Date.now() < deadlineMs) {
    const a = await publicClient.readContract({
      address: AUCTION_ADDR,
      abi: AUCTION_ABI,
      functionName: "getAuction",
      args: [auctionId],
    })
    const state = a.finalized ? "FINALIZED" : a.ended ? "ENDED" : "LIVE"
    const elapsed = ((Date.now() - start) / 1000).toFixed(0)
    console.log(`  [${elapsed}s] auction ${auctionId} state=${state} winner=${a.winnerPlain} amount=${a.winningAmountPlain}`)
    if (a.finalized) {
      console.log(`  ✓ ${label} finalized after ${elapsed}s`)
      return a
    }
    await sleep(20_000)
  }
  throw new Error(`${label} did not finalize before deadline`)
}

// ----------------------- main -----------------------

async function main() {
  const t0 = Date.now()

  await fundBidders()
  await setupCUSDC()

  const a3 = await createAuction(180, "E2E-3min")
  const a15 = await createAuction(15 * 60, "E2E-15min")

  await scheduleAuction(a3.id)
  await scheduleAuction(a15.id)

  console.log("\n[bids] placing 3 bids on each auction")
  const PRICES_3 = [10, 20, 30]
  const PRICES_15 = [15, 25, 18]
  for (let i = 0; i < bidders.length; i++) {
    await placeBid(bidders[i], a3.id, PRICES_3[i])
  }
  for (let i = 0; i < bidders.length; i++) {
    await placeBid(bidders[i], a15.id, PRICES_15[i])
  }

  console.log("\n[wait] all txs landed. Watching for keeper firings.")
  console.log(`[t+${((Date.now() - t0) / 1000).toFixed(0)}s] expected: 3-min auction settles around endTime=${a3.endTime}, 15-min around endTime=${a15.endTime}`)

  await pollUntilFinalized(a3.id, "3-min auction", Date.now() + 8 * 60 * 1000)
  await pollUntilFinalized(a15.id, "15-min auction", Date.now() + 20 * 60 * 1000)

  await refundEth()

  console.log(`\n[done] total ${((Date.now() - t0) / 1000 / 60).toFixed(1)} minutes`)
  process.exit(0)
}

main().catch(async (e) => {
  console.error("[fatal]", e)
  try {
    await refundEth()
  } catch (refundErr) {
    console.error("[fatal] refund also failed:", refundErr)
  }
  process.exit(1)
})
