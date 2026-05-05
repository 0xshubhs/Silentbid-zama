"use client"

import { useState } from "react"
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi"
import { decodeEventLog } from "viem"
import { cn } from "@/lib/utils"
import { ensureZamaInit, encryptInputs, userDecrypt, publicDecrypt, getLastPublicDecryptProof } from "@/lib/zama"
import {
  CUSDC_ABI,
  CUSDC_ADDRESS,
  SCALE,
  USDC_ABI,
  USDC_ADDRESS,
  formatUsdc,
} from "@/lib/zama-contracts"

function handleToBytes32(h: bigint): `0x${string}` {
  return `0x${h.toString(16).padStart(64, "0")}` as `0x${string}`
}

const QUICK = ["10", "50", "250", "1000"]

export function WalletPanel() {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [mode, setMode] = useState<"wrap" | "unwrap">("wrap")
  const [amount, setAmount] = useState("50")
  const [busy, setBusy] = useState<"mint" | "wrap" | "unwrap" | "reveal" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<{ handle: string; value: bigint } | null>(null)

  const { data: usdcBalance, refetch: refetchUsdc } = useReadContract({
    address: USDC_ADDRESS || undefined,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!USDC_ADDRESS, refetchInterval: 10_000 },
  })

  const { data: cUsdcHandle, refetch: refetchCUsdc } = useReadContract({
    address: CUSDC_ADDRESS || undefined,
    abi: CUSDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!CUSDC_ADDRESS, refetchInterval: 10_000 },
  })

  const handle = (cUsdcHandle as string | undefined) ?? "0x0000000000000000000000000000000000000000000000000000000000000000"
  const hasSealed = handle !== "0x0000000000000000000000000000000000000000000000000000000000000000"
  const revealedForCurrent = revealed && revealed.handle === handle ? revealed.value : null

  const amtNum = parseFloat(amount)
  const amtRaw =
    Number.isFinite(amtNum) && amtNum > 0
      ? BigInt(Math.floor(amtNum * Number(SCALE)))
      : 0n

  const tooMuchUsdc = mode === "wrap" && amtRaw > ((usdcBalance as bigint | undefined) ?? 0n)

  async function handleMint() {
    if (!address || !publicClient || !walletClient || !USDC_ADDRESS) return
    setError(null)
    try {
      setBusy("mint")
      const hash = await walletClient.writeContract({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: "mint",
        args: [address, 1000n * SCALE],
        account: walletClient.account!,
        chain: walletClient.chain,
        gas: 200_000n,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw new Error("mint reverted")
      refetchUsdc()
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 140) : "Mint failed")
    } finally {
      setBusy(null)
    }
  }

  async function handleWrap() {
    if (!address || !publicClient || !walletClient || amtRaw === 0n || !USDC_ADDRESS || !CUSDC_ADDRESS) return
    setError(null)
    try {
      setBusy("wrap")
      // Approve USDC if needed
      const allowance = (await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: "allowance",
        args: [address, CUSDC_ADDRESS],
      })) as bigint
      if (allowance < amtRaw) {
        const MAX = (1n << 256n) - 1n
        const aHash = await walletClient.writeContract({
          address: USDC_ADDRESS,
          abi: USDC_ABI,
          functionName: "approve",
          args: [CUSDC_ADDRESS, MAX],
          account: walletClient.account!,
          chain: walletClient.chain,
          gas: 100_000n,
        })
        const aRec = await publicClient.waitForTransactionReceipt({ hash: aHash })
        if (aRec.status !== "success") throw new Error("USDC approve reverted")
      }
      const wHash = await walletClient.writeContract({
        address: CUSDC_ADDRESS,
        abi: CUSDC_ABI,
        functionName: "wrap",
        args: [amtRaw],
        account: walletClient.account!,
        chain: walletClient.chain,
        // wrap mints encrypted balance via FHE.add — single FHE op + ACL grants.
        gas: 1_500_000n,
      })
      const wRec = await publicClient.waitForTransactionReceipt({ hash: wHash })
      if (wRec.status !== "success") throw new Error("wrap reverted")
      refetchUsdc()
      refetchCUsdc()
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 140) : "Wrap failed")
    } finally {
      setBusy(null)
    }
  }

  async function handleUnwrap() {
    if (!address || !publicClient || !walletClient || amtRaw === 0n || !CUSDC_ADDRESS) return
    setError(null)
    try {
      setBusy("unwrap")
      await ensureZamaInit(publicClient as never, walletClient)
      const encrypted = await encryptInputs(
        [{ type: "uint64", value: amtRaw }],
        CUSDC_ADDRESS,
        address,
      )
      const encAmountHandle = handleToBytes32(encrypted.handles[0])

      const reqHash = await walletClient.writeContract({
        address: CUSDC_ADDRESS,
        abi: CUSDC_ABI,
        functionName: "requestUnwrap",
        args: [encAmountHandle, encrypted.inputProof, address],
        account: walletClient.account!,
        chain: walletClient.chain,
        // FHE.fromExternal + sub + makePubliclyDecryptable + ACL grants.
        gas: 3_000_000n,
      })
      const reqRec = await publicClient.waitForTransactionReceipt({ hash: reqHash })
      if (reqRec.status !== "success") throw new Error("requestUnwrap reverted")

      const evt = reqRec.logs
        .map((l) => {
          try { return decodeEventLog({ abi: CUSDC_ABI, data: l.data, topics: l.topics }) }
          catch { return null }
        })
        .find((d) => d?.eventName === "UnwrapRequested")
      if (!evt || !evt.args) throw new Error("UnwrapRequested event missing")
      const args = evt.args as unknown as { unwrapId: bigint; encAmountHandle: string }

      // Public-decrypt so we get the KMS proof needed by claimUnwrap.
      const [plain] = await publicDecrypt([args.encAmountHandle])
      const decryptionProof = getLastPublicDecryptProof()

      const cHash = await walletClient.writeContract({
        address: CUSDC_ADDRESS,
        abi: CUSDC_ABI,
        functionName: "claimUnwrap",
        args: [args.unwrapId, plain, decryptionProof],
        account: walletClient.account!,
        chain: walletClient.chain,
        // checkSignatures (KMS sig verify) + plaintext ERC20 transfer.
        gas: 800_000n,
      })
      const cRec = await publicClient.waitForTransactionReceipt({ hash: cHash })
      if (cRec.status !== "success") throw new Error("claimUnwrap reverted")
      refetchUsdc()
      refetchCUsdc()
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 160) : "Unwrap failed")
    } finally {
      setBusy(null)
    }
  }

  async function handleReveal() {
    if (!publicClient || !walletClient || !hasSealed || !address) return
    setError(null)
    try {
      setBusy("reveal")
      await ensureZamaInit(publicClient as never, walletClient)
      const plain = (await userDecrypt(handle, CUSDC_ADDRESS, address, walletClient)) as bigint
      setRevealed({ handle, value: plain as bigint })
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 140) : "Reveal failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="border border-border/40 p-6 bg-muted/10">
      <h3 className="font-[var(--font-bebas)] text-xl tracking-tight">Wallet</h3>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
        Mint test USDC → wrap into sealed cUSDC → bid.
      </p>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <div className="border border-border/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
            USDC (public)
          </p>
          <p className="mt-1 font-mono text-lg tabular-nums">
            {isConnected ? formatUsdc(usdcBalance as bigint | undefined, 2) : "—"}
          </p>
          <button
            onClick={handleMint}
            disabled={!isConnected || busy === "mint"}
            className={cn(
              "mt-3 w-full py-2 font-mono text-[10px] uppercase tracking-widest border transition-colors",
              isConnected && busy !== "mint"
                ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
                : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
            )}
          >
            {busy === "mint" ? "Minting…" : "Mint 1,000 USDC"}
          </button>
        </div>

        <div className="border border-purple-500/40 p-4 bg-purple-500/5">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-widest text-purple-400">
              cUSDC (sealed)
            </p>
            {hasSealed && (
              <button
                onClick={revealedForCurrent !== null ? () => setRevealed(null) : handleReveal}
                disabled={busy === "reveal"}
                className="text-[10px] uppercase tracking-widest text-accent/80 hover:text-accent disabled:opacity-50"
              >
                {busy === "reveal" ? "…" : revealedForCurrent !== null ? "Hide" : "Reveal"}
              </button>
            )}
          </div>
          <p className="mt-1 font-mono text-lg tabular-nums">
            {!isConnected
              ? "—"
              : !hasSealed
                ? "0"
                : revealedForCurrent !== null
                  ? formatUsdc(revealedForCurrent, 2)
                  : "****"}
          </p>
          <p className="mt-2 font-mono text-[9px] text-muted-foreground/50 break-all">
            {hasSealed ? `handle ${handle.slice(0, 14)}…` : "no sealed balance"}
          </p>
        </div>
      </div>

      <div className="mt-5">
        <div className="inline-flex items-center border border-border/40">
          {(["wrap", "unwrap"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              disabled={busy !== null}
              className={cn(
                "px-4 py-2 font-mono text-[10px] uppercase tracking-widest transition-colors",
                mode === m
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-baseline gap-2 border border-border/40 px-4 py-3">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder="0"
            className="flex-1 bg-transparent font-mono text-xl tabular-nums focus:outline-none"
            disabled={busy !== null}
          />
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {mode === "wrap" ? "USDC" : "cUSDC"}
          </span>
        </div>

        <div className="mt-2 flex items-center gap-1">
          {QUICK.map((v) => (
            <button
              key={v}
              onClick={() => setAmount(v)}
              className="px-2 py-1 font-mono text-[10px] text-muted-foreground/70 hover:text-accent transition-colors"
            >
              {v}
            </button>
          ))}
        </div>

        {tooMuchUsdc && (
          <p className="mt-2 font-mono text-[10px] text-destructive">
            Exceeds your USDC balance.
          </p>
        )}

        <button
          onClick={mode === "wrap" ? handleWrap : handleUnwrap}
          disabled={
            !isConnected ||
            amtRaw === 0n ||
            tooMuchUsdc ||
            busy !== null ||
            (mode === "unwrap" && !hasSealed)
          }
          className={cn(
            "mt-4 w-full py-3 font-mono text-[11px] uppercase tracking-[0.3em] border transition-colors",
            isConnected && amtRaw > 0n && !tooMuchUsdc && busy === null && (mode !== "unwrap" || hasSealed)
              ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
              : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
          )}
        >
          {busy === "wrap" ? "Wrapping…" : busy === "unwrap" ? "Unwrapping…" : mode === "wrap" ? "Wrap USDC" : "Unwrap cUSDC"}
        </button>

        {error && (
          <div className="mt-4 border border-destructive/50 bg-destructive/10 p-3">
            <p className="font-mono text-[10px] text-destructive break-all">{error}</p>
          </div>
        )}
      </div>
    </section>
  )
}
