import React, { useEffect, useState } from "react";
import Head from "next/head";
import Navbar from "../../components/Navbar";

export default function AuditPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchMetrics() {
      try {
        const res = await fetch("/api/audit/metrics");
        const json = await res.json();
        setData(json);
      } catch (err) {
        console.error("Failed to fetch audit metrics", err);
      } finally {
        setLoading(false);
      }
    }
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div className="p-10 text-white font-mono">LOADING SYSTEM METRICS...</div>;
  const volumeValue =
    data?.stats?.volumeVisibility === "encrypted"
      ? "ENCRYPTED"
      : `${data?.stats?.totalVolumeSol} SOL`;

  return (
    <>
      <Head><title>Oracle | System Health</title></Head>
      <Navbar />
      <main className="pink-grid-bg min-h-screen pt-24 px-6">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-4xl font-display text-white tracking-widest mb-8">SYSTEM OBSERVABILITY</h1>
          
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-12">
            {[
              { label: "STATUS", value: data?.stats?.systemStatus, color: "text-emerald-400" },
              { label: "ACTIVE MARKETS", value: data?.stats?.activeMarkets, color: "text-white" },
              { label: "DISPUTES", value: data?.stats?.disputeCount, color: "text-amber-400" },
              { label: "TOTAL VOLUME", value: volumeValue, color: "text-cyan-400" },
            ].map(stat => (
              <div key={stat.label} className="card p-6 border-white/10 bg-white/5">
                <p className="text-[10px] font-mono text-slate-500 tracking-[0.2em] mb-2">{stat.label}</p>
                <p className={`text-2xl font-display tracking-tight ${stat.color}`}>{stat.value}</p>
              </div>
            ))}
          </div>

          <section className="card p-6 bg-slate-900/50 border-white/5">
            <h2 className="text-sm font-mono text-cyan-300 tracking-widest mb-6">RECENT AUDIT LOGS (REAL-TIME)</h2>
            <div className="space-y-3">
              {data?.recentAudit?.map((log: any) => (
                <div key={log.id} className="flex items-center justify-between text-xs font-mono border-b border-white/5 pb-3">
                  <div className="flex gap-4">
                    <span className="text-slate-500">[{log.timestamp.split('T')[1].split('.')[0]}]</span>
                    <span className="text-emerald-500 font-bold">{log.type}</span>
                    <span className="text-slate-300">{log.details}</span>
                  </div>
                  <span className="text-slate-600">SLOT: {log.slot}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
