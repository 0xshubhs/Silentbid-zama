# SilentBID-ZAMA — Project Status

Last updated: 2026-05-06

## ✅ Done

### Contracts (live on Sepolia, all verified on Etherscan)
- `MockUSDC` — `0xE9e7315988B5F0B7f4e50b64986947AE72B9D0B2`
- `MockTokenX` — `0xb9eF338684ba9C5876E8708180C95e2D87FB6D44`
- `ConfidentialUSDC` — `0x0a229d9E8CB39C4724deBFFF376acD23D102Fa83`
- `Treasury` — `0x10692e22152330eF971A18129247CDbF776aA068`
- `SilentBidAuction` — `0xa10314F70e90F8e12a8C6C6e5A2fbdb0f398D84c`
- Deployer EOA: `0xf43F4FC18BaCEFE1C96e4FA6bdc8585FBAEd4Cf7` (Foundry keystore `default`, password `meow`)
- Foundry test suite: passing (Treasury, USDC/TokenX, ConfidentialUSDC w/ forge-fhevm)

### Frontend (Next.js 16 + wagmi + Zama relayer-sdk)
- Pages: `/`, `/auctions`, `/auctions/[id]`, `/auctions/new`, `/my-bids`, `/wallet`, `/admin/treasury`
- Wallet flow: mint USDC → approve → wrap to cUSDC → unwrap (request + claim)
- Auction flow: create ITEM/TOKEN → place encrypted bid → end → reveal + finalize
- Manual finalize button kept as fallback in `app/auctions/[id]/reveal-panel.tsx`
- All ABI / addresses pulled from `.env.local` via static `process.env.X` literals (webpack-replaceable)
- Tenderly Sepolia gateway (`sepolia.gateway.tenderly.co`) used to bypass publicnode's ~10M gas-estimate cap
- Explicit `gas:` caps on every `writeContract` to skip RPC `eth_estimateGas`

### Auto-finalize keeper (the new bit)
- `app/api/cron/finalize/route.ts` — stateless Next.js cron handler
- `vercel.json` — `*/2 * * * *` schedule
- `next.config.ts` — `serverExternalPackages: [node-tfhe, node-tkms, @zama-fhe/relayer-sdk]` so the WASM blobs aren't broken by webpack
- State machine (chain is the source of truth, no DB):
  - `live` → skip
  - `endTime` reached, `!ended` → call `endAuction`
  - `ended && !finalized` → `relayer.publicDecrypt(handles)` → `finalizeAuctionItem(id, winner, amount, proof)`
  - `finalized` → skip
- Verified live: 3 keeper invocations finalized auctions #0 and #1 with no manual intervention
  - `0xaa7a3a7be21e65872258456ed1cd3b13532a79f14569fe841d96f26388dc71ed` (finalize #0)
  - `0x9f61a65d67342984dd33dcc7f6b9e811a8e6e7792df5595baf7a311dbe98d161` (finalize #1)

## 🟡 Partial / Caveats

- **Keeper supports ITEM mode only.** TOKEN mode is gated behind a contract bug — see Remaining.
- **Vercel Hobby cron caps at 1/day per job.** Per-minute requires Pro, or run the keeper on any always-on Node host (Railway / Fly / VPS / laptop).
- **Privacy of TOKEN-mode losers.** `endAuction` makes every bid's `(encPrice, encQty)` publicly decryptable — every loser's bid leaks at settlement. ITEM mode losers stay private.
- **Bid count, bidder address, and participation flag** are plaintext on-chain (event topics + `hasBid` mapping). This is unchanged from the original architecture.

## ❌ Remaining

### Blocking TOKEN-mode auto-finalize (one contract redeploy)
**Bug**: `SilentBidAuction.sol:545` calls
```solidity
FHE.checkSignatures(handles, abi.encode(cleartexts), decryptionProof);
```
where `cleartexts` is `uint256[]`. This produces a *dynamic-array* encoding (offset + length + elements), but the Zama KMS signs a *positional* encoding (`abi.encode(uint256, uint256, …)`). Verification will fail every time.

**Fix**: build positional encoding manually, e.g.:
```solidity
bytes memory packed = "";
for (uint i = 0; i < n; i++) {
    packed = bytes.concat(packed, abi.encode(uint256(prices[i])), abi.encode(uint256(qtys[i])));
}
FHE.checkSignatures(handles, packed, decryptionProof);
```
Then redeploy and update `NEXT_PUBLIC_AUCTION_ADDRESS`. Re-enable TOKEN branch in `app/api/cron/finalize/route.ts`.

### Project is NOT a Uniswap CCA port (renaming or scope honesty)
Audit found ~5% mechanism fidelity. SilentBID is a **single-round sealed-bid auction** (running-max ITEM / sort-and-clear UCP TOKEN), not continuous + tick-based. To genuinely port CCA you'd need:
1. Tick book (`TickStorage`) + price-time priority
2. Checkpoints + step schedule (`CheckpointStorage`/`StepStorage`)
3. Partial fills + early exit (`exitPartiallyFilledBid`)
4. UCP computation entirely inside FHE so only clearing price decrypts (the genuinely hard part)
5. Factory + graduation + claim block

For now, pitch as: *"Sealed-bid auction with Zama FHE, inspired by CCA's clearing-price idea."* — not a port.

### Smaller follow-ups
- [ ] Generate a dedicated keeper EOA (separate from deployer) and fund with ~0.05 ETH; rotate `KEEPER_PRIVATE_KEY` in Vercel env
- [ ] Add `npm run keeper` script for local always-on operation as alternative to Vercel cron
- [ ] Auction #2 (live, has 1 bid) will be the first non-trivial keeper test once it expires (~2026-05-07 06:34 UTC)
- [ ] Add winner/clearing display to UI once `finalized=true` (read `winnerPlain` / `winningAmountPlain`)
- [ ] Consider Chainlink Automation upkeep as keeper alternative (decentralized infra, ~$0.50/finalize)

## File map for new contributors

```
contracts/src/SilentBidAuction.sol     — ITEM + TOKEN modes; check :530–546 for the encoding bug
app/api/cron/finalize/route.ts          — auto-finalize keeper (Vercel cron handler)
vercel.json                              — cron schedule + maxDuration
next.config.ts                           — serverExternalPackages for the SDK WASM
lib/zama.ts                              — relayer-sdk wrapper (client-side encryption + decryption)
lib/zama-contracts.ts                    — ABIs + addresses + AuctionData type + parseAuctionTuple
lib/chain-config.ts                      — sepolia chain export
app/auctions/[id]/reveal-panel.tsx       — manual finalize fallback (still works alongside the keeper)
.env.local                               — addresses + KEEPER_PRIVATE_KEY + CRON_SECRET (gitignored)
```
