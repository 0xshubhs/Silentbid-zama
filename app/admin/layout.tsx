"use client"

import Link from "next/link"
import { cn } from "@/lib/utils"
import { usePathname } from "next/navigation"

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()

  return (
    <div className="px-6 md:px-12 py-12 md:py-20">
      <Link href="/" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors">
        ← Home
      </Link>

      <div className="mt-8 md:mt-12">
        <div className="grid grid-cols-1 md:grid-cols-[200px,1fr] gap-8 md:gap-12">
          <nav className="space-y-2 font-mono text-sm">
            <Link
              href="/admin/treasury"
              className={cn(
                "block px-3 py-2 border transition-colors",
                pathname === "/admin/treasury"
                  ? "border-accent text-accent bg-accent/10"
                  : "border-border/40 text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              )}
            >
              Treasury
            </Link>
          </nav>

          <div>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
