"use client"

import { useRef, useEffect } from "react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

gsap.registerPlugin(ScrollTrigger)

const workflows = [
  {
    step: "01",
    name: "Encrypt & Bid",
    route: "encryptInputs → placeBid",
    offchain: "client.encryptInputs([Encryptable.uint64(bid)]).execute() builds an InEuint64 struct client-side. Signature + ctHash prove the ciphertext came from the user.",
    onchain: "placeBid(auctionId) pulls encrypted escrow from cUSDC, runs FHE.gt / FHE.max / FHE.select to update highestBid and highestBidder — all in ciphertext.",
    accent: "accent",
  },
  {
    step: "02",
    name: "End & Decrypt",
    route: "endAuction → KMS gateway",
    offchain: "CoFHE threshold network picks up FHE.allowPublic requests and decrypts handles off-chain (~25s), then posts plaintext back on-chain.",
    onchain: "endAuction() flips state to ended and calls FHE.allowPublic on highestBid + highestBidder. No sync decryption — the oracle handles it.",
    accent: "amber-500",
  },
  {
    step: "03",
    name: "Publish & Settle",
    route: "publishWinner → settleBid",
    offchain: "Anyone reads the decrypted handles (via client.decryptForTx or public getters) and triggers publishWinner with the plaintext winner + amount + signatures.",
    onchain: "publishWinner records the plaintext outcome. Each loser calls settleBid to get their encrypted escrow back via cUSDC.transferEncrypted.",
    accent: "emerald-500",
  },
]

export function CreSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const cardsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sectionRef.current || !headerRef.current || !cardsRef.current) return

    const ctx = gsap.context(() => {
      gsap.from(headerRef.current, {
        x: -60,
        opacity: 0,
        duration: 1,
        ease: "power3.out",
        scrollTrigger: {
          trigger: headerRef.current,
          start: "top 85%",
          toggleActions: "play none none reverse",
        },
      })

      const cards = cardsRef.current?.querySelectorAll(":scope > div")
      if (cards) {
        gsap.from(cards, {
          y: 60,
          opacity: 0,
          duration: 0.8,
          stagger: 0.15,
          ease: "power3.out",
          scrollTrigger: {
            trigger: cardsRef.current,
            start: "top 90%",
            toggleActions: "play none none reverse",
          },
        })
      }
    }, sectionRef)

    return () => ctx.revert()
  }, [])

  return (
    <section ref={sectionRef} id="cofhe" className="relative py-32 pl-6 md:pl-28 pr-6 md:pr-12">
      {/* Section header */}
      <div ref={headerRef} className="mb-16 flex items-end justify-between">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent">
            03 / Zama FHE
          </span>
          <h2 className="mt-4 font-[var(--font-bebas)] text-5xl md:text-7xl tracking-tight">
            COFHE LIFECYCLE
          </h2>
        </div>
        <p className="hidden md:block max-w-xs font-mono text-xs text-muted-foreground text-right leading-relaxed">
          Three on-chain phases. Bid amounts stay encrypted end-to-end; only the winning handle is ever decrypted.
        </p>
      </div>

      {/* Workflow cards */}
      <div ref={cardsRef} className="grid gap-6 md:grid-cols-3">
        {workflows.map((wf) => (
          <div
            key={wf.step}
            className="group relative border border-border/40 p-6 md:p-8 flex flex-col gap-6 hover:border-accent/60 transition-all duration-500"
          >
            {/* Step number + name */}
            <div>
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                Step {wf.step}
              </span>
              <h3 className="mt-2 font-[var(--font-bebas)] text-3xl md:text-4xl tracking-tight group-hover:text-accent transition-colors duration-300">
                {wf.name}
              </h3>
              <code className="mt-1 block font-mono text-[11px] text-accent/80">
                {wf.route}
              </code>
            </div>

            {/* Offchain */}
            <div>
              <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground">
                Off-chain (@zama-fhe/relayer-sdk / KMS gateway)
              </span>
              <p className="mt-2 font-mono text-xs text-muted-foreground leading-relaxed">
                {wf.offchain}
              </p>
            </div>

            {/* Onchain */}
            <div>
              <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground">
                On-chain (FHE.sol)
              </span>
              <p className="mt-2 font-mono text-xs text-foreground/80 leading-relaxed">
                {wf.onchain}
              </p>
            </div>

            {/* Corner accent */}
            <div className="absolute top-0 right-0 w-10 h-10 opacity-0 group-hover:opacity-100 transition-opacity duration-500">
              <div className="absolute top-0 right-0 w-full h-[1px] bg-accent" />
              <div className="absolute top-0 right-0 w-[1px] h-full bg-accent" />
            </div>
          </div>
        ))}
      </div>

      {/* Summary bar */}
      <div className="mt-12 border border-border/30 p-6 flex flex-col md:flex-row md:items-center gap-4 md:gap-8">
        <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-accent shrink-0">
          Key point
        </span>
        <p className="font-mono text-xs text-muted-foreground leading-relaxed">
          Bid amounts, escrow balances, and the running best-bidder all live on-chain as encrypted euint64 / eaddress handles.
          The CoFHE threshold network holds the decryption key shares — the contract decides when handles become public
          via FHE.allowPublic. Losing bids are never decrypted; escrow returns to the bidder as ciphertext.
        </p>
      </div>
    </section>
  )
}
