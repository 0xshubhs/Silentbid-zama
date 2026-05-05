import Link from "next/link"

export default function AuctionNotFound() {
  return (
    <div className="px-6 md:px-12 py-20 md:py-32 text-center">
      <h1 className="font-[var(--font-bebas)] text-4xl md:text-6xl tracking-tight">
        Auction not found
      </h1>
      <p className="mt-4 font-mono text-sm text-muted-foreground max-w-md mx-auto">
        This auction does not exist or has been removed.
      </p>
      <Link
        href="/auctions"
        className="mt-8 inline-block border border-foreground/20 px-6 py-3 font-mono text-xs uppercase tracking-widest text-foreground hover:border-accent hover:text-accent transition-all duration-200"
      >
        View all auctions
      </Link>
    </div>
  )
}
