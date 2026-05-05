/**
 * Auto-finalize keeper — Vercel cron handler.
 *
 * Why this exists: Zama FHEVM v0.11 has no on-chain decryption callback.
 * `FHE.makePubliclyDecryptable(...)` only marks a handle as decryptable; an
 * off-chain caller still has to fetch cleartext + KMS signatures from the
 * relayer and submit them to `finalizeAuction*`. This endpoint plays that
 * caller, automatically, on a cron schedule. The chain itself remains the
 * state machine — no DB, no queue.
 *
 * Per-tick state machine (idempotent — chain is the source of truth):
 *   live (now < endTime, !ended)                  → skip
 *   expired (now >= endTime, !ended, !finalized)  → call endAuction
 *   ended && !finalized                           → publicDecrypt + finalize
 *   finalized                                     → skip
 *
 * Each invocation processes at most ONE state transition and returns. With
 * cron firing every minute the worst-case latency from `endTime` to
 * settlement is ~3 minutes (one tick to end, one tick of relayer lag, one
 * tick to finalize) — and there is no manual button to press.
 */

import { NextResponse } from "next/server"
import {
  type Address,
  createPublicClient,
  createWalletClient,
  http,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  parseAuctionTuple,
} from "@/lib/zama-contracts"

// Force the Node.js runtime — relayer-sdk/node uses native node-tfhe and
// node-tkms bindings that don't exist on the Edge runtime.
export const runtime = "nodejs"
// Vercel Pro: up to 300s, Hobby: 60s. We bound each tick at ~50s so a
// single slow RPC roundtrip can't time-out the entire run.
export const maxDuration = 60
export const dynamic = "force-dynamic"

// Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` if set.
// Compare in constant time to avoid trivial timing oracles.
function isAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const got = req.headers.get("authorization") ?? ""
  if (got.length !== `Bearer ${expected}`.length) return false
  let diff = 0
  const a = got
  const b = `Bearer ${expected}`
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

type ActionResult = {
  auctionId: string
  action: "endAuction" | "finalizeAuctionItem" | "finalizeAuctionToken" | "skip-token" | "noop"
  tx?: `0x${string}`
  error?: string
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const pk = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined
  const rpcUrl =
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://sepolia.gateway.tenderly.co"

  if (!pk || !pk.startsWith("0x")) {
    return NextResponse.json(
      { ok: false, error: "KEEPER_PRIVATE_KEY missing or malformed (must be 0x-prefixed hex)" },
      { status: 500 },
    )
  }
  if (!AUCTION_ADDRESS) {
    return NextResponse.json(
      { ok: false, error: "NEXT_PUBLIC_AUCTION_ADDRESS not configured" },
      { status: 500 },
    )
  }

  const account = privateKeyToAccount(pk)
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) })

  // Lazy-initialise the Zama node SDK only if/when we actually need to
  // decrypt — saves ~3s of cold-start when there's nothing to do.
  let zamaInstance: Awaited<ReturnType<typeof import("@zama-fhe/relayer-sdk/node").createInstance>> | null = null
  async function getZama() {
    if (zamaInstance) return zamaInstance
    const { createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/node")
    zamaInstance = await createInstance({ ...SepoliaConfig, network: rpcUrl })
    return zamaInstance
  }

  let auctionCount: bigint
  try {
    auctionCount = (await publicClient.readContract({
      address: AUCTION_ADDRESS,
      abi: AUCTION_ABI,
      functionName: "nextAuctionId",
    })) as bigint
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `auctionCount read failed: ${(e as Error).message.slice(0, 200)}` },
      { status: 502 },
    )
  }

  const now = BigInt(Math.floor(Date.now() / 1000))
  const results: ActionResult[] = []

  // Process at most ONE state transition per tick. The cron tick eventually
  // catches up — over-greedy work risks blowing the maxDuration on a slow
  // relayer call.
  for (let id = 0n; id < auctionCount; id++) {
    const tuple = await publicClient.readContract({
      address: AUCTION_ADDRESS,
      abi: AUCTION_ABI,
      functionName: "getAuction",
      args: [id],
    })
    const a = parseAuctionTuple(tuple, id)

    if (a.finalized) continue
    if (!a.ended && now < a.endTime) continue

    // Transition 1: live → ended
    if (!a.ended) {
      try {
        const hash = await walletClient.writeContract({
          address: AUCTION_ADDRESS,
          abi: AUCTION_ABI,
          functionName: "endAuction",
          args: [id],
          gas: 8_000_000n,
          account,
          chain: sepolia,
        })
        await publicClient.waitForTransactionReceipt({ hash })
        results.push({ auctionId: id.toString(), action: "endAuction", tx: hash })
        return NextResponse.json({ ok: true, results, count: auctionCount.toString() })
      } catch (e) {
        results.push({
          auctionId: id.toString(),
          action: "endAuction",
          error: (e as Error).message.slice(0, 240),
        })
        continue
      }
    }

    // Transition 2: ended → finalized
    if (a.mode === "TOKEN") {
      // TOKEN-mode finalize requires positional encoding of an arbitrary number
      // of (price,qty) pairs. The currently deployed contract encodes them as a
      // dynamic uint256[] which doesn't match the relayer's flat positional
      // encoding — so on-chain checkSignatures will reject it. Skip until the
      // contract is redeployed with positional encoding fixed.
      results.push({
        auctionId: id.toString(),
        action: "skip-token",
        error: "TOKEN-mode finalize disabled in keeper (contract encoding mismatch — see README)",
      })
      continue
    }

    // ITEM mode: handles = [bidder, bid], cleartexts = abi.encode(uint256, uint256)
    try {
      const inst = await getZama()
      const handleBidder = a.highestBidderHandle.toLowerCase() as `0x${string}`
      const handleBid = a.highestBidHandle.toLowerCase() as `0x${string}`

      const r = await inst.publicDecrypt([handleBidder, handleBid])

      // clearValues is keyed by handle hex; values are bigint for euint64,
      // bigint (already as address-as-uint) for eaddress.
      const winnerRaw = r.clearValues[handleBidder]
      const amountRaw = r.clearValues[handleBid]
      if (winnerRaw === undefined || amountRaw === undefined) {
        throw new Error("relayer returned no plaintext for ITEM handles")
      }
      const winnerBig = typeof winnerRaw === "bigint" ? winnerRaw : BigInt(winnerRaw as string)
      const amountBig = typeof amountRaw === "bigint" ? amountRaw : BigInt(amountRaw as string)
      const winner = (`0x${winnerBig.toString(16).padStart(40, "0")}`) as Address

      // A zero-bid auction is fine: the running state is (address(0), 0) and
      // the bid array is empty, so finalizeAuctionItem just marks finalized
      // and emits the event with no settlement loop. We let the contract
      // handle that case rather than special-casing it here.

      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "finalizeAuctionItem",
        args: [id, winner, amountBig, r.decryptionProof],
        gas: 12_000_000n,
        account,
        chain: sepolia,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      results.push({ auctionId: id.toString(), action: "finalizeAuctionItem", tx: hash })
      return NextResponse.json({ ok: true, results, count: auctionCount.toString() })
    } catch (e) {
      results.push({
        auctionId: id.toString(),
        action: "finalizeAuctionItem",
        error: (e as Error).message.slice(0, 300),
      })
      // Don't bail — try the next auction. Common transient cause: relayer
      // hasn't observed the makePubliclyDecryptable call yet (1–2 block lag).
      continue
    }
  }

  return NextResponse.json({
    ok: true,
    results,
    keeper: account.address,
    count: auctionCount.toString(),
    now: now.toString(),
  })
}
