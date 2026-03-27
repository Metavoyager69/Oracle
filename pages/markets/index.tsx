import React, { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import Navbar from "../../components/Navbar";
import MarketCard from "../../components/MarketCard";
import {
  DEMO_MARKETS,
  MARKET_CATEGORIES,
  type DemoMarket,
  type MarketCategory,
} from "../../utils/program";
import { deserializeMarket, type ApiMarket } from "../../utils/api";

// Discovery is midway through the demo-to-mainnet transition. It boots from
// bundled sample data, then replaces that with backend data when the API is up.
// On mainnet, the API should be authoritative and fallbacks should be explicit.
type StatusFilter = "all" | "open" | "settled";
type CategoryFilter = "all" | MarketCategory;

export default function MarketsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [markets, setMarkets] = useState<DemoMarket[]>(DEMO_MARKETS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadMarkets() {
      setLoading(true);
      setLoadError(null);

      try {
        // Pages consume serialized API data and convert it back into Date-rich
        // UI models locally. Keep that boundary when hardening for mainnet.
        const response = await fetch("/api/markets");
        const contentType = response.headers.get("content-type"); if (!contentType || !contentType.includes("application/json")) { const text = await response.text(); throw new Error(`Expected JSON but got ${contentType || "unknown"}. Status: ${response.status}. Preview: ${text.slice(0, 100)}`); } const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload?.error ?? "Could not load markets.");
        }

        if (!cancelled) {
          const marketItems = Array.isArray(payload?.markets)
            ? (payload.markets as ApiMarket[]).map((item) => deserializeMarket(item))
            : DEMO_MARKETS;
          setMarkets(marketItems);
        }
      } catch (caught) {
        if (!cancelled) {
          const message = caught instanceof Error ? caught.message : "Unknown API error.";
          setLoadError(message);
          // Demo fallback is convenient during development, but production
          // should make backend outages obvious instead of hiding them.
          setMarkets(DEMO_MARKETS);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadMarkets();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredMarkets = useMemo(
    () =>
      markets.filter((market) => {
        if (statusFilter === "open" && market.status !== "Open") return false;
        if (statusFilter === "settled" && market.status !== "Settled") return false;
        if (categoryFilter !== "all" && market.category !== categoryFilter) return false;
        return true;
      }),
    [markets, statusFilter, categoryFilter]
  );

  return (
    <>
      <Head>
        <title>Oracle | Markets</title>
        <meta
          name="description"
          content="Browse encrypted prediction markets and track outcomes in real time."
        />
      </Head>

      <Navbar />

      <main className="pink-grid-bg" style={{ minHeight: "100vh", paddingTop: "72px" }}>
        <div className="mx-auto max-w-6xl px-6 py-12">
          <section className="mb-10">
            <h1 className="font-display text-4xl tracking-widest text-white">MARKETS</h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
              Explore active and settled markets. Connect your wallet to submit a private position.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/create" className="btn-primary">
                CREATE MARKET
              </Link>
              <Link href="/portfolio" className="btn-secondary">
                PORTFOLIO
              </Link>
            </div>
          </section>

          <section>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-3xl tracking-widest text-white">DISCOVERY</h2>
              {loading ? (
                <p className="font-mono text-xs text-slate-500">Loading data...</p>
              ) : loadError ? (
                <p className="font-mono text-xs text-amber-300">Fallback data: {loadError}</p>
              ) : (
                <p className="font-mono text-xs text-emerald-300">Live backend data</p>
              )}
            </div>

            <div className="mb-6 grid gap-4 md:grid-cols-2">
              <div>
                <p className="mb-2 font-mono text-xs tracking-widest text-slate-500">CATEGORY</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setCategoryFilter("all")}
                    className="rounded-lg border border-white/10 px-4 py-2 font-mono text-xs text-slate-300"
                    style={{
                      background: categoryFilter === "all" ? "rgba(107,63,160,0.25)" : "transparent",
                    }}
                  >
                    ALL
                  </button>
                  {MARKET_CATEGORIES.map((category) => (
                    <button
                      key={category}
                      onClick={() => setCategoryFilter(category)}
                      className="rounded-lg border border-white/10 px-4 py-2 font-mono text-xs text-slate-300"
                      style={{
                        background:
                          categoryFilter === category ? "rgba(107,63,160,0.25)" : "transparent",
                      }}
                    >
                      {category.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 font-mono text-xs tracking-widest text-slate-500">STATUS</p>
                <div className="flex flex-wrap gap-2">
                  {(["all", "open", "settled"] as const).map((value) => (
                    <button
                      key={value}
                      onClick={() => setStatusFilter(value)}
                      className="rounded-lg border border-white/10 px-4 py-2 font-mono text-xs text-slate-300"
                      style={{
                        background: statusFilter === value ? "rgba(107,63,160,0.25)" : "transparent",
                      }}
                    >
                      {value.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filteredMarkets.length === 0 ? (
              <div className="py-10 font-mono text-sm text-slate-500">No markets found.</div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {filteredMarkets.map((market) => (
                  <MarketCard key={market.id} {...market} />
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
