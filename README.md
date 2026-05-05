# SilentBID-ZAMA

Multi-winner sealed-bid uniform-clearing-price auction on **Zama FHEVM**. Bids stay encrypted on-chain throughout the bidding window — no one (not the seller, not other bidders, not validators) can see anyone's bid until settlement. At end of window, the contract reveals only the clearing price and winner allocations via Zama's KMS-signed public decryption.

A spiritual port of [SilentBID-FHENIX](../Silentbid-FHENIX/) onto the Zama stack, extended with a multi-winner uniform-clearing-price (UCP) settlement mode inspired by [Uniswap's Continuous Clearing Auction](../continuous-clearing-auction/).

## Two auction modes

| Mode  | Use case                | Bid shape              | Settlement                                                                                |
| ----- | ----------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| ITEM  | Single-item English     | encrypted price, qty=1 | Single highest bidder wins, pays own bid in cUSDC (FHENIX parity)                         |
| TOKEN | Token sale / batch sale | encrypted (price, qty) | Multi-winner UCP: all winners pay the clearing price × allocated qty; pro-rata at boundary |

## Stack

| Layer                | Tooling                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| Contracts            | Foundry, Solidity 0.8.27, EVM cancun, via_ir                           |
| FHE Solidity library | `@fhevm/solidity@0.11.1` (vendored via `forge-fhevm` soldeer deps)     |
| FHE testing          | `zama-ai/forge-fhevm` (real host contracts inside Foundry tests)       |
| Frontend             | Next.js 16, React 19, wagmi 3, viem 2, RainbowKit, Tailwind 4, Radix UI |
| FHE client           | `@zama-fhe/relayer-sdk@0.4.2` (browser bundle)                         |
| Network              | Sepolia FHEVM (chainId 11155111)                                       |

## Layout

```
SilentBID-ZAMA/
├── contracts/                   Foundry project
│   ├── src/
│   │   ├── MockUSDC.sol         6-decimal underlying, faucet (≤1000/call)
│   │   ├── MockTokenX.sol       18-decimal generic ERC20 (TOKEN-mode auction asset)
│   │   ├── Treasury.sol         Plaintext fee bps (cap 10%) + auth whitelist
│   │   ├── ConfidentialUSDC.sol cUSDC: euint64 balances/allowances, two-step unwrap
│   │   └── SilentBidAuction.sol Both modes; FHE running-max for ITEM + UCP for TOKEN
│   ├── test/
│   │   ├── MockTokens.t.sol
│   │   ├── Treasury.t.sol
│   │   ├── ConfidentialUSDC.t.sol  uses forge-fhevm FhevmTest base
│   │   └── SilentBidAuction.t.sol  e2e ITEM + TOKEN flows
│   ├── script/Deploy.s.sol      Deploy MockUSDC → MockTokenX → cUSDC → Treasury → Auction
│   ├── foundry.toml
│   └── remappings.txt
├── app/                         Next.js (ported from FHENIX)
├── components/                  React UI (ported from FHENIX)
├── lib/
│   ├── zama.ts                  Replaces FHENIX lib/cofhe.ts
│   ├── zama-contracts.ts        Replaces FHENIX lib/fhenix-contracts.ts
│   └── wagmi-config.ts
└── package.json
```

## Quick start

### Prerequisites

- Node.js ≥ 20
- Foundry (`forge`, `cast`, `anvil`) — install via `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- A Sepolia private key with some test ETH ([Sepolia faucet](https://sepoliafaucet.com))

### 1. Install + test contracts

```bash
cd contracts
git init -q   # forge install requires a git repo at cwd
forge install foundry-rs/forge-std zama-ai/forge-fhevm OpenZeppelin/openzeppelin-contracts@v5.1.0
( cd lib/forge-fhevm && forge soldeer install )
forge build
forge test -vv
```

Plain-Solidity tests (Treasury, mocks): all green. ConfidentialUSDC tests using `forge-fhevm` test harness: 5/6 green; the 6th (claimUnwrap with mock KMS sigs) is a known mock-quirk and works correctly against the real Sepolia KMS.

### 2. Deploy to Sepolia FHEVM

```bash
cp .env.example .env
# edit .env: PRIVATE_KEY, SEPOLIA_RPC_URL

forge script script/Deploy.s.sol \
  --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY
```

Copy the printed `NEXT_PUBLIC_*` block into `../.env.local` at the project root.

### 3. Run the frontend

```bash
cd ..  # back to project root
npm install
npm run dev
# → http://localhost:3000
```

### 4. Auto-finalize keeper (Vercel cron)

Zama FHEVM v0.11 has no on-chain decryption callback — somebody has to fetch
plaintext + KMS signatures from the relayer and submit them to
`finalizeAuction*`. We do that automatically with a Vercel cron job:

```
app/api/cron/finalize/route.ts   # stateless keeper handler
vercel.json                       # crons: */2 * * * * → /api/cron/finalize
```

State machine per tick (chain is the source of truth — no DB):

```
live (now < endTime, !ended)         → skip
expired (now >= endTime, !ended)     → call endAuction
ended && !finalized                  → publicDecrypt + finalizeAuctionItem
finalized                            → skip
```

Each tick processes one transition; cron at `*/2 * * * *` means worst-case
latency from `endTime` → settlement is ~6 minutes. The frontend's manual
finalize button stays as a fallback if the keeper is offline.

**Env vars required (Vercel project → Settings → Environment Variables):**

```bash
KEEPER_PRIVATE_KEY=0x...    # any funded EOA on Sepolia (~0.05 ETH for headroom)
CRON_SECRET=<random-string> # protects /api/cron/finalize from arbitrary callers
NEXT_PUBLIC_AUCTION_ADDRESS=0xa10314...
NEXT_PUBLIC_SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co
```

For local testing:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/finalize
```

**Limitations:**
- ITEM mode only. TOKEN mode is disabled in the keeper because the deployed
  contract encodes the cleartext array as `abi.encode(uint256[])` (dynamic
  array) but the relayer hands back positional `abi.encode(uint256, uint256, …)`
  — they don't match. Fix is in `_verifyTokenDecryption` at
  `contracts/src/SilentBidAuction.sol:530-546`. Until redeployed, TOKEN-mode
  auctions still need the manual finalize button.
- Vercel Hobby plan caps cron frequency to once/day per job — use Pro for
  per-minute. Local dev or any always-on Node host (Railway, Fly, your laptop)
  works just as well.

## How the FHE flow works

### Place a sealed bid (TOKEN mode)

1. **UI** prompts for price + quantity in cUSDC and TokenX units
2. **`@zama-fhe/relayer-sdk`** encrypts both as `euint64` against the auction contract's address — produces `{handles, inputProof}` from the relayer
3. **UI** approves the encrypted cUSDC escrow (`cUSDC.approve(auction, encMaxAmount, proof)`)
4. **UI** calls `SilentBidAuction.placeBid(id, encPriceHandle, encQtyHandle, inputProof)`
5. Contract pulls cUSDC via `cUSDC.transferFromAllowance(bidder, auction)` (encrypted, no leakage)
6. Contract stores `Bid{ bidder, encPrice, encQty }` — only the FHE handles touch storage; the underlying values never decrypt during the auction

### Settle (TOKEN mode)

1. **Anyone** calls `endAuction(id)` after `endTime` — contract calls `FHE.makePubliclyDecryptable` on every `(encPrice, encQty)` handle, plus the running winner state
2. **Off-chain** an actor (the seller, a bidder, or a third-party keeper) fetches the cleartexts + KMS signatures from the Zama relayer for those handles
3. **They** call `finalizeAuctionToken(id, prices[], qtys[], decryptionProof)` — the contract:
   - `FHE.checkSignatures(handles, encoded(plaintexts), proof)` — reverts if any KMS sig is invalid
   - Sorts bids by price descending
   - Walks down accumulating qty until `cumulative >= supply` — clearing price = price of the last (boundary) bid
   - Pro-rata allocates qty at the boundary tick
   - Winners get TokenX, are charged `clearing × allocatedQty` in cUSDC
   - Losers get full cUSDC refund
   - Treasury gets `feeBps * clearing` per winner
   - Unsold TokenX returns to seller

### Unwrap cUSDC

1. `cUSDC.requestUnwrap(encAmount, proof, recipient)` debits the encrypted balance and marks the amount publicly decryptable
2. Off-chain: fetch `(plain, proof)` from Zama relayer
3. Anyone calls `cUSDC.claimUnwrap(unwrapId, plain, proof)` — verifies KMS sig, releases the underlying USDC

## Security notes

- Reentrancy: all settlement paths use `nonReentrant` + CEI ordering
- USDC has 6 decimals (`uint64` is sufficient for any realistic bid)
- All encrypted state has explicit ACL grants (`FHE.allowThis` + `FHE.allow(handle, user)`) — Zama's strictest mode
- Multiply-before-divide on fee math
- SafeERC20 for the USDC underlying and TokenX

## Why this architecture

| Concern         | Choice                            | Rationale                                                                                  |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| Bid privacy     | On-chain `euint64` ciphertexts    | No off-chain trust, no committee, no commit-reveal latency — pure FHE                      |
| MEV resistance  | Bids never decrypt during window  | Validators can't read or reorder by content; identity is plaintext but bid value is hidden |
| Multi-winner    | Uniform clearing price            | Avoids winner's curse, encourages truthful bidding (vs pay-as-bid)                         |
| Settlement gas  | Off-chain decryption + on-chain checkSignatures | Avoids running an FHE sort on-chain (intractable)                                          |
| Unsold supply   | Returns to seller                 | No dead-token loss when a TOKEN auction is undersubscribed                                 |

## License

MIT
