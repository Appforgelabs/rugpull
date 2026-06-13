import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, ScatterChart, Scatter, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid,
} from "recharts";
import {
  TrendingUp, Wallet, BookOpen, BarChart3, Sparkles, Settings as SettingsIcon,
  Plus, Trash2, X, RefreshCw, Download, Upload, Pencil, Activity, Target, Layers,
  AlertTriangle, CheckCircle2, Info, Zap, Shield, ShieldAlert, ShieldCheck, Gauge,
  Coins, CalendarClock, Grip, TrendingDown, Hand,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  CONSTANTS & HELPERS                                                */
/* ------------------------------------------------------------------ */

const STORE_KEY = "rugpull_journal_v3";
const STRATEGIES = ["Swing", "Day Trade", "Breakout", "Momentum", "Earnings", "Covered Call", "Cash-Secured Put", "Vertical Spread", "Long Call/Put", "Mean Reversion", "Other"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const todayStr = () => new Date().toISOString().slice(0, 10);

const fmtMoney = (n, dp = 2) => (n == null || isNaN(n) ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const fmtSigned = (n, dp = 2) => (n == null || isNaN(n) ? "—" : `${n > 0 ? "+" : n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const fmtK = (n) => (n == null || isNaN(n) ? "—" : `${n < 0 ? "-" : ""}$${(Math.abs(n) / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1)}k`);
const fmtPct = (n, dp = 1) => (n == null || isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(dp)}%`);
const fmtNum = (n, dp = 2) => (n == null || isNaN(n) ? "—" : n.toFixed(dp));

const mult = (t) => (t.assetType === "option" ? 100 : 1);
const dirFactor = (t) => (t.direction === "short" ? -1 : 1);
const costBasis = (t) => Math.abs((t.entryPrice || 0) * (t.quantity || 0) * mult(t));
const markOf = (t) => (t.currentPrice != null ? t.currentPrice : t.entryPrice);
const marketValue = (t) => Math.abs(markOf(t) * t.quantity * mult(t));

const realizedPnl = (t) => (t.status !== "closed" || t.exitPrice == null ? 0 : dirFactor(t) * (t.exitPrice - t.entryPrice) * t.quantity * mult(t) - (t.fees || 0));
const unrealizedPnl = (t) => dirFactor(t) * (markOf(t) - t.entryPrice) * t.quantity * mult(t) - (t.fees || 0);
const tradePnl = (t) => (t.status === "closed" ? realizedPnl(t) : unrealizedPnl(t));
const tradeReturnPct = (t) => (costBasis(t) ? (tradePnl(t) / costBasis(t)) * 100 : 0);
const holdDays = (t) => (!t.entryDate || !t.exitDate ? null : Math.max(0, Math.round((new Date(t.exitDate) - new Date(t.entryDate)) / 86400000)));
const rMultiple = (t) => {
  if (t.stop == null || t.stop === "" || t.stop === t.entryPrice) return null;
  const risk = Math.abs(t.entryPrice - t.stop) * t.quantity * mult(t);
  return risk ? realizedPnl(t) / risk : null;
};

/* ------------------------------------------------------------------ */
/*  MARGIN MODEL  (educational approximation, broker-style)            */
/* ------------------------------------------------------------------ */

const maintRate = (t, s) => {
  if (t.assetType === "option") return t.direction === "long" ? 1.0 : (s.maintShortOpt ?? 1.0);
  return t.direction === "long" ? s.maintLong : s.maintShort;
};

function baseCash(trades, s) {
  let cash = Number(s.startCapital) || 0;
  trades.forEach((t) => {
    if (t.status === "closed") cash += realizedPnl(t);
    else cash += (t.direction === "long" ? -1 : 1) * t.entryPrice * t.quantity * mult(t);
  });
  return cash;
}

function computeMargin(trades, s) {
  const open = trades.filter((t) => t.status === "open");
  const cash = baseCash(trades, s);
  let LMV = 0, SMV = 0, maint = 0;
  open.forEach((t) => {
    const mv = marketValue(t);
    if (t.direction === "long") LMV += mv; else SMV += mv;
    maint += mv * maintRate(t, s);
  });
  const equity = cash + LMV - SMV;
  const debit = Math.max(0, -cash);
  const cushion = equity - maint;
  const util = equity > 0 ? maint / equity : maint > 0 ? Infinity : 0;
  const leverage = equity > 0 ? (LMV + SMV) / equity : 0;
  const levered = debit > 0.5 || SMV > 0.5;
  return { open, cash, LMV, SMV, equity, debit, maint, cushion, util, leverage, levered };
}

function scenarioAt(trades, s, shock) {
  const open = trades.filter((t) => t.status === "open");
  const cash = baseCash(trades, s);
  let LMV = 0, SMV = 0, maint = 0;
  open.forEach((t) => {
    let mk = markOf(t);
    if (t.assetType !== "option") mk = mk * (1 + shock); // shock equities; options held at mark (no greeks tracked)
    const mv = Math.abs(mk * t.quantity * mult(t));
    if (t.direction === "long") LMV += mv; else SMV += mv;
    maint += mv * maintRate(t, s);
  });
  const equity = cash + LMV - SMV;
  return { shock, equity, maint, cushion: equity - maint };
}

function callShock(trades, s) {
  // scan downward for first maintenance breach
  const m0 = computeMargin(trades, s);
  if (!m0.levered) return null;
  if (m0.cushion < 0) return 0;
  for (let sh = -0.005; sh >= -0.9; sh -= 0.005) {
    if (scenarioAt(trades, s, sh).cushion < 0) return sh;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  SAMPLE DATA                                                        */
/* ------------------------------------------------------------------ */

const sampleTrades = () => {
  const t = (o) => ({ id: crypto.randomUUID(), assetType: "stock", direction: "long", optionType: null, strike: null, expiry: null, fees: 1.5, stop: null, currentPrice: null, tags: [], setup: "", notes: "", rating: 3, ...o });
  return [
    t({ symbol: "NVDA", strategy: "Swing", quantity: 40, entryPrice: 118.2, entryDate: "2026-03-04", exitPrice: 134.6, exitDate: "2026-03-19", status: "closed", stop: 112, setup: "Pullback to 21EMA", rating: 5 }),
    t({ symbol: "TSLA", assetType: "option", direction: "short", optionType: "call", strike: 290, expiry: "2026-04-17", strategy: "Covered Call", quantity: 3, entryPrice: 6.4, entryDate: "2026-03-21", exitPrice: 1.1, exitDate: "2026-04-16", status: "closed", fees: 3.9, setup: "Sold premium into strength", rating: 4 }),
    t({ symbol: "AMD", strategy: "Breakout", quantity: 60, entryPrice: 168.0, entryDate: "2026-03-26", exitPrice: 159.4, exitDate: "2026-03-31", status: "closed", stop: 160, setup: "Failed breakout, stopped", rating: 2 }),
    t({ symbol: "SPY", assetType: "etf", strategy: "Swing", quantity: 30, entryPrice: 548.0, entryDate: "2026-04-02", exitPrice: 571.5, exitDate: "2026-04-29", status: "closed", stop: 538, setup: "Trend continuation", rating: 4 }),
    t({ symbol: "PLTR", strategy: "Momentum", quantity: 120, entryPrice: 47.5, entryDate: "2026-04-10", exitPrice: 43.2, exitDate: "2026-04-28", status: "closed", stop: 44, setup: "Chased extension", notes: "Held past stop", rating: 1 }),
    t({ symbol: "ASPN", strategy: "Earnings", quantity: 150, entryPrice: 22.1, entryDate: "2026-05-01", exitPrice: 27.8, exitDate: "2026-05-12", status: "closed", stop: 20, setup: "Earnings beat gap", rating: 5 }),
    t({ symbol: "INTC", direction: "short", strategy: "Mean Reversion", quantity: 80, entryPrice: 31.2, entryDate: "2026-05-06", exitPrice: 33.0, exitDate: "2026-05-09", status: "closed", stop: 33, setup: "Faded too early", rating: 2 }),
    t({ symbol: "AAPL", strategy: "Swing", quantity: 35, entryPrice: 198.0, entryDate: "2026-05-15", exitPrice: 211.4, exitDate: "2026-06-02", status: "closed", stop: 191, setup: "Base breakout", rating: 4 }),
    // open book
    t({ symbol: "SPY", assetType: "etf", strategy: "Swing", quantity: 60, entryPrice: 571.0, entryDate: "2026-06-03", currentPrice: 566.0, status: "open", stop: 552, setup: "Core position" }),
    t({ symbol: "NVDA", strategy: "Swing", quantity: 25, entryPrice: 141.0, entryDate: "2026-06-04", currentPrice: 148.3, status: "open", stop: 134, setup: "Re-entry on strength" }),
    t({ symbol: "ASPN", strategy: "Swing", quantity: 100, entryPrice: 28.4, entryDate: "2026-06-09", currentPrice: 27.1, status: "open", stop: 25.5, setup: "Add on dip" }),
    t({ symbol: "TSLA", assetType: "option", direction: "short", optionType: "call", strike: 300, expiry: "2026-06-19", strategy: "Covered Call", quantity: 3, entryPrice: 5.2, entryDate: "2026-06-05", currentPrice: 3.1, status: "open", setup: "Premium against shares" }),
  ];
};

/* ------------------------------------------------------------------ */
/*  STORAGE                                                            */
/* ------------------------------------------------------------------ */

const defaultSettings = { apiKey: "", startCapital: 25000, currency: "USD", marginEnabled: true, maintLong: 0.25, maintShort: 0.30, maintShortOpt: 1.0, autoExpire: true };

async function loadState() {
  try { const v = localStorage.getItem(STORE_KEY); if (v) return JSON.parse(v); } catch (e) {}
  return null;
}
async function saveState(state) { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { console.error(e); } }

/* ------------------------------------------------------------------ */
/*  COUNT-UP                                                           */
/* ------------------------------------------------------------------ */

function useCountUp(target, deps) {
  const [val, setVal] = useState(0);
  const raf = useRef();
  useEffect(() => {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setVal(target); return; }
    const start = performance.now(), dur = 900;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
      setVal(target * e);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, deps); // eslint-disable-line
  return val;
}

/* ------------------------------------------------------------------ */
/*  STYLES                                                             */
/* ------------------------------------------------------------------ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
:root{--ink:#080B14;--ink2:#0C111E;--panel:#111728;--panel2:#161D31;--line:#222B43;--line2:#2C3650;
--gold:#E5B94E;--mint:#4ADE9E;--coral:#FF6B7A;--blue:#6AA9FF;--text:#EAEEF7;--muted:#8893AC;--dim:#566079;
--serif:'Fraunces',Georgia,serif;--ui:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;}
*{box-sizing:border-box}
.tj{font-family:var(--ui);color:var(--text);background:var(--ink);min-height:100vh;position:relative;overflow-x:hidden}
.tj.dragging{user-select:none}
.tj::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;background:radial-gradient(1100px 600px at 80% -10%,rgba(229,185,78,.07),transparent 60%),radial-gradient(900px 500px at 0% 0%,rgba(74,222,158,.04),transparent 55%)}
.tj .wrap{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:0 20px 90px}
.tj .top{display:flex;align-items:center;justify-content:space-between;padding:22px 20px;max-width:1180px;margin:0 auto;position:relative;z-index:1}
.tj .brand{display:flex;align-items:center;gap:12px}
.tj .logo{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(150deg,var(--gold),#a9842b);box-shadow:0 0 0 1px rgba(229,185,78,.3),0 8px 24px rgba(229,185,78,.18)}
.tj .brand h1{font-family:var(--serif);font-weight:500;font-size:21px;letter-spacing:.3px;margin:0;line-height:1}
.tj .brand .sub{font-family:var(--mono);font-size:10.5px;color:var(--gold);letter-spacing:2.5px;text-transform:uppercase;margin-top:3px}
.tj .nav{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:26px}
.tj .navbtn{appearance:none;background:none;border:none;cursor:pointer;color:var(--muted);font-family:var(--ui);font-size:13.5px;font-weight:500;padding:12px 13px;display:flex;align-items:center;gap:7px;border-bottom:2px solid transparent;margin-bottom:-1px;transition:.15s;border-radius:6px 6px 0 0}
.tj .navbtn:hover{color:var(--text);background:rgba(255,255,255,.02)}
.tj .navbtn.on{color:var(--gold);border-bottom-color:var(--gold)}
.tj .navbtn svg{width:16px;height:16px}
.tj .panel{background:linear-gradient(180deg,var(--panel),var(--ink2));border:1px solid var(--line);border-radius:16px;padding:20px}
.tj .panel.lg{padding:24px}
.tj .ptitle{font-family:var(--mono);font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);margin:0 0 16px;display:flex;align-items:center;gap:8px}
.tj .ptitle svg{width:14px;height:14px;color:var(--gold)}
.tj .grid{display:grid;gap:16px}
.tj .g4{grid-template-columns:repeat(4,1fr)}.tj .g3{grid-template-columns:repeat(3,1fr)}.tj .g2{grid-template-columns:repeat(2,1fr)}
@media(max-width:880px){.tj .g4{grid-template-columns:repeat(2,1fr)}.tj .g3,.tj .g2{grid-template-columns:1fr}}
@media(max-width:520px){.tj .g4{grid-template-columns:1fr}}
.tj .stat{background:linear-gradient(180deg,var(--panel),var(--ink2));border:1px solid var(--line);border-radius:14px;padding:18px}
.tj .stat .lab{font-family:var(--mono);font-size:10.5px;letter-spacing:1.6px;text-transform:uppercase;color:var(--dim)}
.tj .stat .val{font-family:var(--mono);font-weight:600;font-size:24px;margin-top:8px;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.tj .stat .meta{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:5px}
.tj .hero{background:radial-gradient(600px 300px at 85% 20%,rgba(229,185,78,.10),transparent 70%),linear-gradient(180deg,var(--panel),var(--ink2));border:1px solid var(--line);border-radius:20px;padding:26px 28px;overflow:hidden;position:relative}
.tj .hero .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:var(--gold)}
.tj .hero .big{font-family:var(--mono);font-weight:700;font-size:clamp(34px,6vw,54px);letter-spacing:-1.5px;margin:6px 0 2px;font-variant-numeric:tabular-nums}
.tj .hero .row{display:flex;gap:22px;flex-wrap:wrap;margin-top:14px}
.tj .hero .row .it .k{font-family:var(--mono);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--dim)}
.tj .hero .row .it .v{font-family:var(--mono);font-size:15px;font-weight:600;margin-top:3px}
.tj .pos{color:var(--mint)}.tj .neg{color:var(--coral)}.tj .gold{color:var(--gold)}.tj .blue{color:var(--blue)}
.tj .mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.tj .btn{appearance:none;cursor:pointer;font-family:var(--ui);font-weight:600;font-size:13px;border-radius:10px;padding:10px 16px;border:1px solid var(--line2);background:var(--panel2);color:var(--text);display:inline-flex;align-items:center;gap:7px;transition:.15s}
.tj .btn:hover{border-color:var(--gold);color:var(--gold)}.tj .btn svg{width:15px;height:15px}
.tj .btn.gold{background:linear-gradient(150deg,var(--gold),#b78f30);color:#1a1405;border:none}
.tj .btn.gold:hover{filter:brightness(1.08);color:#1a1405}
.tj .btn.ghost{background:none}.tj .btn.danger:hover{border-color:var(--coral);color:var(--coral)}
.tj .btn.sm{padding:7px 11px;font-size:12px}
.tj .iconbtn{appearance:none;cursor:pointer;background:none;border:none;color:var(--dim);padding:6px;border-radius:8px;transition:.15s}
.tj .iconbtn:hover{color:var(--gold);background:rgba(255,255,255,.04)}.tj .iconbtn svg{width:16px;height:16px;display:block}
.tj .iconbtn.del:hover{color:var(--coral)}
.tj label{font-family:var(--mono);font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:var(--dim);display:block;margin-bottom:6px}
.tj input,.tj select,.tj textarea{width:100%;background:var(--ink2);border:1px solid var(--line);border-radius:9px;color:var(--text);font-family:var(--mono);font-size:13.5px;padding:9px 11px;outline:none;transition:.15s}
.tj input:focus,.tj select:focus,.tj textarea:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(229,185,78,.12)}
.tj select{font-family:var(--ui)}.tj textarea{resize:vertical;min-height:60px}
.tj .pill{font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.5px;padding:3px 8px;border-radius:6px;display:inline-flex;align-items:center;gap:4px;text-transform:uppercase}
.tj .pill.long{background:rgba(74,222,158,.12);color:var(--mint)}.tj .pill.short{background:rgba(255,107,122,.12);color:var(--coral)}
.tj .pill.opt{background:rgba(229,185,78,.12);color:var(--gold)}.tj .pill.open{background:rgba(136,147,172,.14);color:var(--muted)}
.tj .tbl{width:100%;border-collapse:collapse;font-size:13px}
.tj .tbl th{font-family:var(--mono);font-size:10px;letter-spacing:1.3px;text-transform:uppercase;color:var(--dim);text-align:right;padding:10px 12px;border-bottom:1px solid var(--line);font-weight:500;white-space:nowrap}
.tj .tbl th:first-child,.tj .tbl td:first-child{text-align:left}
.tj .tbl td{padding:12px;border-bottom:1px solid rgba(34,43,67,.5);font-family:var(--mono);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tj .tbl tr:hover td{background:rgba(255,255,255,.015)}
.tj .sym{font-weight:700;font-size:13.5px;letter-spacing:.3px}.tj .scroll{overflow-x:auto}
.tj .ins{border:1px solid var(--line);border-radius:14px;padding:18px;background:var(--ink2);position:relative;overflow:hidden}
.tj .ins::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px}
.tj .ins.good::before{background:var(--mint)}.tj .ins.warn::before{background:var(--gold)}.tj .ins.bad::before{background:var(--coral)}
.tj .ins .ih{display:flex;align-items:center;gap:9px;font-weight:600;font-size:14px;margin-bottom:7px}
.tj .ins .ih svg{width:17px;height:17px}
.tj .ins.good .ih svg{color:var(--mint)}.tj .ins.warn .ih svg{color:var(--gold)}.tj .ins.bad .ih svg{color:var(--coral)}
.tj .ins p{margin:0;font-size:13px;line-height:1.55;color:var(--muted)}
.tj .ins .sug{margin-top:9px;font-size:12.5px;color:var(--text);font-weight:500}
.tj .scrim{position:fixed;inset:0;background:rgba(4,6,12,.72);backdrop-filter:blur(4px);z-index:50;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto}
.tj .modal{background:linear-gradient(180deg,var(--panel),var(--ink2));border:1px solid var(--line2);border-radius:18px;padding:24px;width:100%;max-width:680px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.tj .modal.sm{max-width:420px}
.tj .modal h3{font-family:var(--serif);font-weight:500;font-size:20px;margin:0}
.tj .formgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:18px}
@media(max-width:620px){.tj .formgrid{grid-template-columns:1fr 1fr}}
.tj .span2{grid-column:span 2}.tj .span3{grid-column:1/-1}
.tj .empty{text-align:center;padding:70px 20px}
.tj .empty .ico{width:64px;height:64px;border-radius:18px;margin:0 auto 20px;display:grid;place-items:center;background:linear-gradient(150deg,rgba(229,185,78,.18),rgba(229,185,78,.04));border:1px solid rgba(229,185,78,.25)}
.tj .empty h2{font-family:var(--serif);font-weight:500;font-size:26px;margin:0 0 10px}
.tj .empty p{color:var(--muted);max-width:460px;margin:0 auto 24px;line-height:1.6;font-size:14px}
.tj .empty .acts{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.tj .note{font-family:var(--mono);font-size:11px;color:var(--dim);line-height:1.5}
.tj .ratebar{display:inline-flex;gap:2px}.tj .ratebar i{width:6px;height:6px;border-radius:50%;background:var(--line2)}.tj .ratebar i.on{background:var(--gold)}
.tj .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--gold);color:var(--gold);font-family:var(--mono);font-size:12.5px;padding:11px 18px;border-radius:10px;z-index:60;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.tj .sec-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px;flex-wrap:wrap}
.tj .sec-head h2{font-family:var(--serif);font-weight:500;font-size:23px;margin:0}
/* board */
.tj .zones{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px;position:sticky;top:8px;z-index:5}
.tj .zone{border:1.5px dashed var(--line2);border-radius:14px;padding:14px 12px;text-align:center;background:rgba(12,17,30,.85);backdrop-filter:blur(6px);transition:.15s}
.tj .zone .zt{font-family:var(--mono);font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;justify-content:center;gap:6px}
.tj .zone .zt svg{width:15px;height:15px}
.tj .zone .zd{font-size:11px;color:var(--dim);margin-top:3px}
.tj .zone.buy.hot{border-color:var(--mint);background:rgba(74,222,158,.1)}.tj .zone.buy.hot .zt{color:var(--mint)}
.tj .zone.sell.hot{border-color:var(--coral);background:rgba(255,107,122,.1)}.tj .zone.sell.hot .zt{color:var(--coral)}
.tj .zone.expire.hot{border-color:var(--gold);background:rgba(229,185,78,.1)}.tj .zone.expire.hot .zt{color:var(--gold)}
.tj .board{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:106px;gap:12px;grid-auto-flow:dense}
@media(max-width:760px){.tj .board{grid-template-columns:repeat(2,1fr);grid-auto-rows:100px}}
.tj .tile{position:relative;border-radius:16px;padding:14px;cursor:grab;touch-action:none;overflow:hidden;border:1px solid var(--line2);background:linear-gradient(160deg,var(--panel2),var(--ink2));display:flex;flex-direction:column;justify-content:space-between;transition:transform .12s,box-shadow .12s,opacity .12s}
.tj .tile:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(0,0,0,.35)}
.tj .tile:active{cursor:grabbing}
.tj .tile.up{box-shadow:inset 0 0 0 1px rgba(74,222,158,.25)}.tj .tile.down{box-shadow:inset 0 0 0 1px rgba(255,107,122,.25)}
.tj .tile.xl{grid-column:span 2;grid-row:span 2}.tj .tile.lg{grid-column:span 2}
.tj .tile .accent{position:absolute;left:0;top:0;bottom:0;width:3px}
.tj .tile .tsym{font-weight:700;font-size:15px;letter-spacing:.3px;display:flex;align-items:center;gap:6px}
.tj .tile.xl .tsym{font-size:22px}.tj .tile.lg .tsym{font-size:18px}
.tj .tile .tsub{font-family:var(--mono);font-size:10px;color:var(--dim);margin-top:2px;text-transform:uppercase;letter-spacing:.5px}
.tj .tile .tpnl{font-family:var(--mono);font-weight:600;font-size:14px;font-variant-numeric:tabular-nums}
.tj .tile.xl .tpnl{font-size:20px}
.tj .tile .tmv{font-family:var(--mono);font-size:11px;color:var(--muted)}
.tj .tile .twt{position:absolute;right:12px;top:12px;font-family:var(--mono);font-size:10px;color:var(--dim)}
.tj .tile .grip{position:absolute;right:10px;bottom:10px;color:var(--line2)}
.tj .tile .grip svg{width:14px;height:14px}
.tj .tile.exp{border-color:rgba(229,185,78,.5);animation:pulse 1.8s infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(229,185,78,.0)}50%{box-shadow:0 0 0 3px rgba(229,185,78,.18)}}
.tj .ghost{position:fixed;pointer-events:none;z-index:80;border-radius:14px;padding:12px 16px;background:linear-gradient(160deg,var(--panel2),var(--ink2));border:1px solid var(--gold);box-shadow:0 20px 50px rgba(0,0,0,.5);transform:translate(-50%,-50%) rotate(-3deg)}
.tj .ghost .gs{font-weight:700;font-size:16px}.tj .ghost .gp{font-family:var(--mono);font-size:13px;margin-top:2px}
.tj .sheet-act{display:flex;flex-direction:column;gap:8px;margin-top:18px}
.tj .sheet-act .btn{justify-content:flex-start;font-size:14px;padding:13px 16px}
.tj .gauge{height:9px;border-radius:6px;background:var(--ink2);overflow:hidden;border:1px solid var(--line)}
.tj .gauge i{display:block;height:100%;border-radius:6px}
.tj .statusbar{border-radius:14px;padding:18px 20px;display:flex;align-items:center;gap:14px;border:1px solid}
.tj .statusbar svg{width:26px;height:26px;flex:none}
.tj .statusbar .st{font-family:var(--serif);font-size:19px;font-weight:500}
.tj .statusbar .sd{font-size:12.5px;color:var(--muted);margin-top:2px}
.tj .toggle{display:flex;align-items:center;gap:10px;cursor:pointer}
.tj .toggle .tk{width:40px;height:22px;border-radius:12px;background:var(--line2);position:relative;transition:.15s;flex:none}
.tj .toggle .tk i{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--muted);transition:.15s}
.tj .toggle.on .tk{background:rgba(229,185,78,.4)}.tj .toggle.on .tk i{left:20px;background:var(--gold)}
.tj .toggle span{font-size:13px;color:var(--text)}
`;

/* ------------------------------------------------------------------ */
/*  SHARED SMALL COMPONENTS                                            */
/* ------------------------------------------------------------------ */

const Stat = ({ lab, val, meta, cls }) => (
  <div className="stat"><div className="lab">{lab}</div><div className={`val ${cls || ""}`}>{val}</div>{meta && <div className="meta">{meta}</div>}</div>
);
const Rate = ({ n }) => <span className="ratebar">{[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= (n || 0) ? "on" : ""} />)}</span>;
const Toggle = ({ on, onChange, label }) => (
  <div className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} tabIndex={0}
    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(!on); } }}>
    <div className="tk"><i /></div><span>{label}</span>
  </div>
);
const ChartTip = ({ active, payload, label, money }) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: "#0C111E", border: "1px solid #2C3650", borderRadius: 10, padding: "9px 12px", fontFamily: "var(--mono)", fontSize: 12 }}>
      <div style={{ color: "#566079", fontSize: 10, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => <div key={i} style={{ color: p.color || "#EAEEF7" }}>{p.name}: {money ? fmtSigned(p.value) : fmtNum(p.value)}</div>)}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  TRADE FORM MODAL                                                   */
/* ------------------------------------------------------------------ */

const blank = { symbol: "", assetType: "stock", direction: "long", optionType: "call", strike: "", expiry: "", strategy: "Swing", quantity: "", entryPrice: "", entryDate: "", exitPrice: "", exitDate: "", currentPrice: "", fees: "", stop: "", status: "open", setup: "", notes: "", rating: 3, tags: "" };

function TradeModal({ initial, onSave, onClose }) {
  const [f, setF] = useState(() => initial ? { ...blank, ...initial, strike: initial.strike ?? "", expiry: initial.expiry ?? "", exitPrice: initial.exitPrice ?? "", exitDate: initial.exitDate ?? "", currentPrice: initial.currentPrice ?? "", fees: initial.fees ?? "", stop: initial.stop ?? "", tags: (initial.tags || []).join(", ") } : { ...blank });
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const isOpt = f.assetType === "option";
  const submit = () => {
    if (!f.symbol || !f.quantity || !f.entryPrice || !f.entryDate) { alert("Symbol, quantity, entry price and entry date are required."); return; }
    const num = (v) => (v === "" || v == null ? null : Number(v));
    onSave({
      id: initial?.id || crypto.randomUUID(), symbol: f.symbol.toUpperCase().trim(), assetType: f.assetType, direction: f.direction,
      optionType: isOpt ? f.optionType : null, strike: isOpt ? num(f.strike) : null, expiry: isOpt ? (f.expiry || null) : null,
      strategy: f.strategy, quantity: Number(f.quantity), entryPrice: Number(f.entryPrice), entryDate: f.entryDate, status: f.status,
      exitPrice: f.status === "closed" ? num(f.exitPrice) : null, exitDate: f.status === "closed" ? (f.exitDate || null) : null,
      currentPrice: f.status === "open" ? num(f.currentPrice) : null, fees: num(f.fees) || 0, stop: num(f.stop),
      setup: f.setup, notes: f.notes, rating: Number(f.rating), tags: f.tags ? f.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
    });
  };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3>{initial ? "Edit trade" : "New trade"}</h3>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="formgrid">
          <div><label>Symbol</label><input value={f.symbol} onChange={set("symbol")} placeholder="NVDA" /></div>
          <div><label>Asset</label><select value={f.assetType} onChange={set("assetType")}><option value="stock">Stock</option><option value="etf">ETF</option><option value="option">Option</option></select></div>
          <div><label>Direction</label><select value={f.direction} onChange={set("direction")}><option value="long">Long</option><option value="short">Short</option></select></div>
          {isOpt && <>
            <div><label>Type</label><select value={f.optionType} onChange={set("optionType")}><option value="call">Call</option><option value="put">Put</option></select></div>
            <div><label>Strike</label><input value={f.strike} onChange={set("strike")} placeholder="290" /></div>
            <div><label>Expiry</label><input type="date" value={f.expiry} onChange={set("expiry")} /></div>
          </>}
          <div><label>Strategy</label><select value={f.strategy} onChange={set("strategy")}>{STRATEGIES.map((s) => <option key={s}>{s}</option>)}</select></div>
          <div><label>{isOpt ? "Contracts" : "Shares"}</label><input value={f.quantity} onChange={set("quantity")} placeholder="40" /></div>
          <div><label>Status</label><select value={f.status} onChange={set("status")}><option value="open">Open</option><option value="closed">Closed</option></select></div>
          <div><label>Entry price</label><input value={f.entryPrice} onChange={set("entryPrice")} placeholder="118.20" /></div>
          <div><label>Entry date</label><input type="date" value={f.entryDate} onChange={set("entryDate")} /></div>
          <div><label>Stop (opt.)</label><input value={f.stop} onChange={set("stop")} placeholder="112.00" /></div>
          {f.status === "closed" ? <>
            <div><label>Exit price</label><input value={f.exitPrice} onChange={set("exitPrice")} placeholder="134.60" /></div>
            <div><label>Exit date</label><input type="date" value={f.exitDate} onChange={set("exitDate")} /></div>
          </> : <div><label>Current / mark</label><input value={f.currentPrice} onChange={set("currentPrice")} placeholder="auto via API" /></div>}
          <div><label>Fees</label><input value={f.fees} onChange={set("fees")} placeholder="1.50" /></div>
          <div className="span2"><label>Setup</label><input value={f.setup} onChange={set("setup")} placeholder="Pullback to 21EMA" /></div>
          <div><label>Self-grade</label><select value={f.rating} onChange={set("rating")}>{[1, 2, 3, 4, 5].map((i) => <option key={i} value={i}>{i} ★</option>)}</select></div>
          <div className="span3"><label>Tags</label><input value={f.tags} onChange={set("tags")} placeholder="earnings, gap, conviction" /></div>
          <div className="span3"><label>Notes</label><textarea value={f.notes} onChange={set("notes")} placeholder="Thesis? Did you follow your plan?" /></div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn gold" onClick={submit}>{initial ? "Save changes" : "Add trade"}</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  QUICK ACTION MODAL (close / add)                                   */
/* ------------------------------------------------------------------ */

function QuickModal({ mode, trade, onConfirm, onClose }) {
  const closing = mode === "close";
  const verbClose = trade.direction === "long" ? "Sell" : "Buy to cover";
  const verbAdd = trade.direction === "long" ? "Buy more" : "Add to short";
  const [qty, setQty] = useState(trade.quantity);
  const [price, setPrice] = useState(closing ? markOf(trade) : trade.entryPrice);
  const [date, setDate] = useState(todayStr());
  const unit = trade.assetType === "option" ? "contracts" : "shares";
  const go = () => {
    const q = Number(qty), p = Number(price);
    if (!q || q <= 0 || !p || p < 0) { alert("Enter a valid quantity and price."); return; }
    onConfirm(trade, closing ? Math.min(q, trade.quantity) : q, p, date);
  };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal sm" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3>{closing ? verbClose : verbAdd} · {trade.symbol}</h3>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <p className="note" style={{ marginTop: 8 }}>
          {closing
            ? `Closing reduces your ${trade.direction} position. Full size closes it out and books the P&L.`
            : `Adds to your ${trade.direction} position and re-averages your entry.`}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
          <div><label>{unit}{closing ? ` (max ${trade.quantity})` : ""}</label><input value={qty} onChange={(e) => setQty(e.target.value)} /></div>
          <div><label>{closing ? "Exit price" : "Add price"}</label><input value={price} onChange={(e) => setPrice(e.target.value)} /></div>
          <div className="span2"><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className={`btn ${closing ? "" : "gold"}`} onClick={go}>{closing ? "Confirm close" : "Confirm add"}</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  MAIN APP                                                           */
/* ------------------------------------------------------------------ */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [trades, setTrades] = useState([]);
  const [settings, setSettings] = useState(defaultSettings);
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(undefined);
  const [toast, setToast] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const expiredOnce = useRef(false);

  useEffect(() => { (async () => { const s = await loadState(); if (s) { setTrades(s.trades || []); setSettings({ ...defaultSettings, ...(s.settings || {}) }); } setLoading(false); })(); }, []);
  useEffect(() => { if (!loading) saveState({ trades, settings }); }, [trades, settings, loading]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2200); };

  // auto-expire options past expiry (once on load)
  useEffect(() => {
    if (loading || expiredOnce.current || !settings.autoExpire) return;
    expiredOnce.current = true;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let n = 0;
    const upd = trades.map((t) => {
      if (t.status === "open" && t.assetType === "option" && t.expiry && new Date(t.expiry + "T00:00:00") <= today) {
        n++; return { ...t, status: "closed", exitPrice: 0, exitDate: t.expiry, currentPrice: null, notes: (t.notes ? t.notes + " · " : "") + "Auto-expired worthless" };
      }
      return t;
    });
    if (n) { setTrades(upd); flash(`${n} option${n > 1 ? "s" : ""} expired worthless`); }
  }, [loading]); // eslint-disable-line

  const upsert = (t) => { setTrades((p) => { const i = p.findIndex((x) => x.id === t.id); if (i >= 0) { const c = [...p]; c[i] = t; return c; } return [...p, t]; }); setEditing(undefined); flash(editing ? "Trade updated" : "Trade logged"); };
  const remove = (id) => { setTrades((p) => p.filter((x) => x.id !== id)); flash("Trade deleted"); };

  const closePosition = useCallback((trade, qty, exitPrice, exitDate) => {
    setTrades((prev) => {
      const i = prev.findIndex((x) => x.id === trade.id); if (i < 0) return prev;
      const t = prev[i];
      if (qty >= t.quantity) { const c = [...prev]; c[i] = { ...t, status: "closed", exitPrice, exitDate, currentPrice: null }; return c; }
      const c = [...prev];
      c[i] = { ...t, quantity: t.quantity - qty };
      c.push({ ...t, id: crypto.randomUUID(), quantity: qty, status: "closed", exitPrice, exitDate, currentPrice: null });
      return c;
    });
    flash(`Closed ${qty} ${trade.symbol}`);
  }, []);
  const addToPosition = useCallback((trade, qty, price) => {
    setTrades((prev) => { const i = prev.findIndex((x) => x.id === trade.id); if (i < 0) return prev; const t = prev[i]; const nq = t.quantity + qty; const ne = (t.quantity * t.entryPrice + qty * price) / nq; const c = [...prev]; c[i] = { ...t, quantity: nq, entryPrice: ne }; return c; });
    flash(`Added ${qty} ${trade.symbol}`);
  }, []);
  const expireWorthless = useCallback((trade) => { closePosition(trade, trade.quantity, 0, todayStr()); flash(`${trade.symbol} expired worthless`); }, [closePosition]);

  const refreshPrices = useCallback(async () => {
    const open = trades.filter((t) => t.status === "open" && t.assetType !== "option");
    if (!settings.apiKey) { flash("Add an FMP API key in Settings"); return; }
    if (!open.length) { flash("No open stock/ETF positions"); return; }
    setRefreshing(true);
    try {
      const syms = [...new Set(open.map((t) => t.symbol))].join(",");
      const r = await fetch(`https://financialmodelingprep.com/api/v3/quote/${syms}?apikey=${settings.apiKey}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json(); const map = {}; (Array.isArray(data) ? data : []).forEach((q) => { map[q.symbol] = q.price; });
      setTrades((p) => p.map((t) => (t.status === "open" && t.assetType !== "option" && map[t.symbol] != null ? { ...t, currentPrice: map[t.symbol] } : t)));
      flash("Prices updated");
    } catch (e) { flash("Price fetch failed — check key / use manual marks"); } finally { setRefreshing(false); }
  }, [trades, settings.apiKey]);

  const M = useMemo(() => {
    const closed = trades.filter((t) => t.status === "closed");
    const open = trades.filter((t) => t.status === "open");
    const wins = closed.filter((t) => realizedPnl(t) > 0), losses = closed.filter((t) => realizedPnl(t) < 0);
    const realized = closed.reduce((s, t) => s + realizedPnl(t), 0);
    const unreal = open.reduce((s, t) => s + unrealizedPnl(t), 0);
    const grossWin = wins.reduce((s, t) => s + realizedPnl(t), 0), grossLoss = Math.abs(losses.reduce((s, t) => s + realizedPnl(t), 0));
    const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
    const avgWin = wins.length ? grossWin / wins.length : 0, avgLoss = losses.length ? grossLoss / losses.length : 0;
    const profitFactor = grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    const expectancy = closed.length ? realized / closed.length : 0;
    const openValue = open.reduce((s, t) => s + marketValue(t), 0);
    const byExit = [...closed].filter((t) => t.exitDate).sort((a, b) => new Date(a.exitDate) - new Date(b.exitDate));
    let eq = Number(settings.startCapital) || 0; const curve = [{ date: "Start", equity: eq }];
    byExit.forEach((t) => { eq += realizedPnl(t); curve.push({ date: t.exitDate, equity: eq }); });
    return { closed, open, wins, losses, realized, unreal, grossWin, grossLoss, winRate, avgWin, avgLoss, profitFactor, expectancy, openValue, curve };
  }, [trades, settings.startCapital]);

  if (loading) return <div className="tj"><style>{CSS}</style><div style={{ display: "grid", placeItems: "center", height: "100vh", fontFamily: "var(--mono)", color: "#566079", position: "relative", zIndex: 1 }}>Loading journal…</div></div>;

  const empty = trades.length === 0;

  return (
    <div className="tj">
      <style>{CSS}</style>
      <div className="top">
        <div className="brand">
          <div className="logo"><TrendingUp color="#1a1405" size={20} strokeWidth={2.5} /></div>
          <div><h1>Rugpull Journal</h1><div className="sub">Trading Observatory</div></div>
        </div>
        {!empty && <button className="btn gold" onClick={() => setEditing(null)}><Plus />Log trade</button>}
      </div>

      <div className="wrap">
        {empty ? (
          <EmptyState onSample={() => { setTrades(sampleTrades()); setSettings((s) => ({ ...s, marginEnabled: true })); expiredOnce.current = true; flash("Sample journal loaded"); }} onAdd={() => setEditing(null)} />
        ) : (
          <>
            <nav className="nav">
              {[["overview", "Overview", Activity], ["board", "Board", Layers], ["journal", "Journal", BookOpen], ["analytics", "Analytics", BarChart3], ["margin", "Margin", Shield], ["insights", "Insights", Sparkles], ["settings", "Settings", SettingsIcon]].map(([k, l, Ico]) => (
                <button key={k} className={`navbtn ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}><Ico />{l}</button>
              ))}
            </nav>
            {tab === "overview" && <Overview M={M} trades={trades} settings={settings} setTab={setTab} />}
            {tab === "board" && <Board M={M} settings={settings} onEdit={setEditing} onClosePos={closePosition} onAddPos={addToPosition} onExpire={expireWorthless} onRefresh={refreshPrices} refreshing={refreshing} hasKey={!!settings.apiKey} flash={flash} />}
            {tab === "journal" && <Journal trades={trades} onEdit={setEditing} onDelete={remove} />}
            {tab === "analytics" && <Analytics M={M} />}
            {tab === "margin" && <Margin trades={trades} settings={settings} setSettings={setSettings} setTab={setTab} />}
            {tab === "insights" && <Insights M={M} />}
            {tab === "settings" && <SettingsView settings={settings} setSettings={setSettings} trades={trades} setTrades={setTrades} flash={flash} />}
          </>
        )}
      </div>

      {editing !== undefined && <TradeModal initial={editing} onSave={upsert} onClose={() => setEditing(undefined)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  EMPTY                                                              */
/* ------------------------------------------------------------------ */

function EmptyState({ onSample, onAdd }) {
  return (
    <div className="empty">
      <div className="ico"><TrendingUp color="#E5B94E" size={30} /></div>
      <h2>Your desk, before the open</h2>
      <p>Drag positions to buy or sell. Watch concentration in living tiles. Stress-test margin before the market does. Log every trade and let the journal surface your edge.</p>
      <div className="acts"><button className="btn gold" onClick={onSample}><Zap />Explore with sample data</button><button className="btn" onClick={onAdd}><Plus />Log my first trade</button></div>
      <p className="note" style={{ marginTop: 22 }}>Sample data is one click to clear later in Settings.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  OVERVIEW                                                           */
/* ------------------------------------------------------------------ */

function Overview({ M, trades, settings, setTab }) {
  const totalPnl = M.realized + M.unreal;
  const animated = useCountUp(totalPnl, [totalPnl]);
  const equityNow = (Number(settings.startCapital) || 0) + totalPnl;
  const retPct = settings.startCapital ? (totalPnl / settings.startCapital) * 100 : 0;
  const mg = useMemo(() => computeMargin(trades, settings), [trades, settings]);
  const cs = useMemo(() => callShock(trades, settings), [trades, settings]);
  const recent = [...trades].sort((a, b) => new Date(b.exitDate || b.entryDate) - new Date(a.exitDate || a.entryDate)).slice(0, 6);
  const alloc = {}; M.open.forEach((t) => { alloc[t.symbol] = (alloc[t.symbol] || 0) + marketValue(t); });
  const allocData = Object.entries(alloc).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  const PIE = ["#E5B94E", "#4ADE9E", "#6AA9FF", "#C792EA", "#FF6B7A", "#5BC8C8"];

  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="hero">
        <div className="eyebrow">Total P&L · realized + open</div>
        <div className={`big ${totalPnl >= 0 ? "pos" : "neg"}`}>{fmtSigned(animated)}</div>
        <div className="row">
          <div className="it"><div className="k">Account equity</div><div className="v mono">{fmtMoney(equityNow)}</div></div>
          <div className="it"><div className="k">Return</div><div className={`v mono ${retPct >= 0 ? "pos" : "neg"}`}>{fmtPct(retPct)}</div></div>
          <div className="it"><div className="k">Realized</div><div className={`v mono ${M.realized >= 0 ? "pos" : "neg"}`}>{fmtSigned(M.realized)}</div></div>
          <div className="it"><div className="k">Open P&L</div><div className={`v mono ${M.unreal >= 0 ? "pos" : "neg"}`}>{fmtSigned(M.unreal)}</div></div>
          {settings.marginEnabled && mg.levered && <div className="it"><div className="k">Margin call at</div><div className="v mono gold">{cs == null ? "—" : fmtPct(cs * 100, 1)}</div></div>}
        </div>
      </div>

      <div className="grid g4">
        <Stat lab="Win rate" val={`${M.winRate.toFixed(0)}%`} meta={`${M.wins.length}W · ${M.losses.length}L`} cls="gold" />
        <Stat lab="Profit factor" val={M.profitFactor === Infinity ? "∞" : M.profitFactor.toFixed(2)} meta="gross win ÷ loss" />
        <Stat lab="Expectancy" val={fmtSigned(M.expectancy)} meta="per closed trade" cls={M.expectancy >= 0 ? "pos" : "neg"} />
        <Stat lab="Open exposure" val={fmtMoney(M.openValue, 0)} meta={`${M.open.length} position${M.open.length === 1 ? "" : "s"}`} />
      </div>

      <div className="panel lg">
        <div className="ptitle"><Activity />Equity curve</div>
        <div style={{ height: 280 }}>
          <ResponsiveContainer>
            <AreaChart data={M.curve} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
              <defs><linearGradient id="eq" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#E5B94E" stopOpacity={0.35} /><stop offset="100%" stopColor="#E5B94E" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid stroke="#1a2236" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#566079", fontSize: 10, fontFamily: "var(--mono)" }} axisLine={false} tickLine={false} minTickGap={30} />
              <YAxis tick={{ fill: "#566079", fontSize: 10, fontFamily: "var(--mono)" }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtK(v)} width={48} domain={["dataMin - 500", "dataMax + 500"]} />
              <Tooltip content={<ChartTip money />} />
              <Area type="monotone" dataKey="equity" name="equity" stroke="#E5B94E" strokeWidth={2.5} fill="url(#eq)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="ptitle"><Layers />Open allocation</div>
          {allocData.length ? (
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 150, height: 150 }}>
                <ResponsiveContainer><PieChart><Pie data={allocData} dataKey="value" nameKey="name" innerRadius={42} outerRadius={70} paddingAngle={2} stroke="none">{allocData.map((_, i) => <Cell key={i} fill={PIE[i % PIE.length]} />)}</Pie><Tooltip content={<ChartTip money />} /></PieChart></ResponsiveContainer>
              </div>
              <div style={{ flex: 1 }}>{allocData.map((d, i) => <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontFamily: "var(--mono)", fontSize: 12.5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: PIE[i % PIE.length] }} /><span style={{ fontWeight: 700 }}>{d.name}</span><span style={{ marginLeft: "auto", color: "#8893AC" }}>{fmtMoney(d.value, 0)}</span></div>)}</div>
            </div>
          ) : <p className="note">No open positions.</p>}
        </div>
        <div className="panel">
          <div className="ptitle"><BookOpen />Recent activity</div>
          <div className="scroll"><table className="tbl"><thead><tr><th>Symbol</th><th>Strategy</th><th>P&L</th><th>Status</th></tr></thead><tbody>
            {recent.map((t) => { const pnl = tradePnl(t); return (
              <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setTab("journal")}>
                <td><span className="sym">{t.symbol}</span></td>
                <td style={{ color: "#8893AC", fontFamily: "var(--ui)", fontSize: 12.5 }}>{t.strategy}</td>
                <td className={pnl >= 0 ? "pos" : "neg"} style={{ fontWeight: 600 }}>{fmtSigned(pnl)}</td>
                <td><span className={`pill ${t.status === "open" ? "open" : pnl >= 0 ? "long" : "short"}`}>{t.status}</span></td>
              </tr>); })}
          </tbody></table></div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BOARD — interactive concentration tiles                            */
/* ------------------------------------------------------------------ */

function Board({ M, settings, onEdit, onClosePos, onAddPos, onExpire, onRefresh, refreshing, hasKey, flash }) {
  const open = M.open;
  const total = open.reduce((s, t) => s + marketValue(t), 0) || 1;
  const tiles = [...open].sort((a, b) => marketValue(b) - marketValue(a));

  const [drag, setDrag] = useState(null);     // {trade, x, y}
  const [hot, setHot] = useState(null);       // zone id while hovering
  const [sheet, setSheet] = useState(null);   // tapped trade -> action sheet
  const [quick, setQuick] = useState(null);   // {mode, trade}
  const startRef = useRef(null);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const isExpiring = (t) => t.assetType === "option" && t.expiry && new Date(t.expiry + "T00:00:00") <= new Date(today.getTime() + 3 * 86400000);

  const tier = (t) => { const w = marketValue(t) / total; return w >= 0.30 ? "xl" : w >= 0.16 ? "lg" : ""; };

  const zoneFor = (zone, trade) => {
    if (zone === "expire") { if (trade.assetType === "option") onExpire(trade); else flash("Only options can expire"); return; }
    const isClose = (zone === "sell" && trade.direction === "long") || (zone === "buy" && trade.direction === "short");
    setQuick({ mode: isClose ? "close" : "add", trade });
  };

  // global pointer listeners
  useEffect(() => {
    const onMove = (e) => {
      const s = startRef.current; if (!s) return;
      const dx = e.clientX - s.sx, dy = e.clientY - s.sy;
      if (!s.started && Math.hypot(dx, dy) > 8) { s.started = true; document.body.parentElement; }
      if (s.started) {
        setDrag({ trade: s.trade, x: e.clientX, y: e.clientY });
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const z = el && el.closest && el.closest("[data-zone]");
        setHot(z ? z.getAttribute("data-zone") : null);
        e.preventDefault();
      }
    };
    const onUp = (e) => {
      const s = startRef.current;
      if (s && s.started) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const z = el && el.closest && el.closest("[data-zone]");
        if (z) zoneFor(z.getAttribute("data-zone"), s.trade);
      } else if (s && !s.started) { setSheet(s.trade); }
      startRef.current = null; setDrag(null); setHot(null);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [open]); // eslint-disable-line

  const down = (e, trade) => { startRef.current = { trade, sx: e.clientX, sy: e.clientY, started: false }; };

  useEffect(() => { document.querySelector(".tj")?.classList.toggle("dragging", !!drag); }, [drag]);

  return (
    <div>
      <div className="sec-head">
        <h2>Trading floor</h2>
        <button className="btn sm" onClick={onRefresh} disabled={refreshing}><RefreshCw style={refreshing ? { animation: "spin 1s linear infinite" } : {}} />{refreshing ? "Updating…" : "Refresh prices"}</button>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {open.length ? <>
        <div className="zones">
          <div className={`zone buy ${hot === "buy" ? "hot" : ""}`} data-zone="buy"><div className="zt"><TrendingUp />Buy</div><div className="zd">add / cover</div></div>
          <div className={`zone sell ${hot === "sell" ? "hot" : ""}`} data-zone="sell"><div className="zt"><TrendingDown />Sell</div><div className="zd">close / book P&L</div></div>
          <div className={`zone expire ${hot === "expire" ? "hot" : ""}`} data-zone="expire"><div className="zt"><CalendarClock />Expire</div><div className="zd">options → worthless</div></div>
        </div>

        <div className="board">
          {tiles.map((t) => {
            const pnl = unrealizedPnl(t); const w = (marketValue(t) / total) * 100;
            return (
              <div key={t.id} className={`tile ${tier(t)} ${pnl >= 0 ? "up" : "down"} ${isExpiring(t) ? "exp" : ""}`}
                onPointerDown={(e) => down(e, t)} style={{ opacity: drag && drag.trade.id === t.id ? 0.35 : 1 }}>
                <span className="accent" style={{ background: pnl >= 0 ? "var(--mint)" : "var(--coral)" }} />
                <span className="twt">{w.toFixed(0)}%</span>
                <div>
                  <div className="tsym">{t.symbol}{t.assetType === "option" && <span className="pill opt">{t.optionType}</span>}</div>
                  <div className="tsub">{t.assetType === "option" ? `${t.strike} · ${t.expiry}` : `${t.quantity} sh · ${t.direction}`}</div>
                </div>
                <div>
                  <div className={`tpnl ${pnl >= 0 ? "pos" : "neg"}`}>{fmtSigned(pnl)}</div>
                  <div className="tmv">{fmtMoney(marketValue(t), 0)}</div>
                </div>
                <span className="grip"><Grip /></span>
              </div>
            );
          })}
        </div>
        <p className="note" style={{ marginTop: 14 }}>Tile area ≈ position weight. Drag a tile onto a zone — or tap it — to act. {hasKey ? "Live stock/ETF marks via FMP; option marks are manual." : "Add an FMP key in Settings for live marks, or set marks by editing a position."}</p>
      </> : <div className="panel"><p className="note">No open positions. Log a trade with status “Open”, or load sample data in Settings.</p></div>}

      {drag && <div className="ghost" style={{ left: drag.x, top: drag.y }}><div className="gs">{drag.trade.symbol}</div><div className={`gp ${unrealizedPnl(drag.trade) >= 0 ? "pos" : "neg"}`}>{fmtSigned(unrealizedPnl(drag.trade))}</div></div>}

      {sheet && (
        <div className="scrim" onClick={() => setSheet(null)}>
          <div className="modal sm" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>{sheet.symbol} · {sheet.direction}</h3><button className="iconbtn" onClick={() => setSheet(null)}><X /></button>
            </div>
            <div className="sheet-act">
              <button className="btn" onClick={() => { setQuick({ mode: sheet.direction === "long" ? "close" : "add", trade: sheet }); setSheet(null); }}><TrendingDown />{sheet.direction === "long" ? "Sell / close" : "Add to short"}</button>
              <button className="btn" onClick={() => { setQuick({ mode: sheet.direction === "long" ? "add" : "close", trade: sheet }); setSheet(null); }}><TrendingUp />{sheet.direction === "long" ? "Buy more" : "Buy to cover"}</button>
              {sheet.assetType === "option" && <button className="btn" onClick={() => { onExpire(sheet); setSheet(null); }}><CalendarClock />Expire worthless</button>}
              <button className="btn ghost" onClick={() => { onEdit(sheet); setSheet(null); }}><Pencil />Edit details</button>
            </div>
          </div>
        </div>
      )}

      {quick && <QuickModal mode={quick.mode} trade={quick.trade} onClose={() => setQuick(null)}
        onConfirm={(t, q, p, d) => { quick.mode === "close" ? onClosePos(t, q, p, d) : onAddPos(t, q, p, d); setQuick(null); }} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  JOURNAL                                                            */
/* ------------------------------------------------------------------ */

function Journal({ trades, onEdit, onDelete }) {
  const [q, setQ] = useState(""); const [filt, setFilt] = useState("all");
  const rows = useMemo(() => {
    let r = [...trades];
    if (filt === "open") r = r.filter((t) => t.status === "open");
    if (filt === "closed") r = r.filter((t) => t.status === "closed");
    if (filt === "wins") r = r.filter((t) => t.status === "closed" && realizedPnl(t) > 0);
    if (filt === "losses") r = r.filter((t) => t.status === "closed" && realizedPnl(t) < 0);
    if (q) r = r.filter((t) => (t.symbol + t.strategy + (t.setup || "") + (t.tags || []).join(" ")).toLowerCase().includes(q.toLowerCase()));
    return r.sort((a, b) => new Date(b.entryDate) - new Date(a.entryDate));
  }, [trades, q, filt]);
  return (
    <div>
      <div className="sec-head"><h2>Trade journal</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input style={{ width: 180 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={{ width: "auto" }} value={filt} onChange={(e) => setFilt(e.target.value)}><option value="all">All</option><option value="open">Open</option><option value="closed">Closed</option><option value="wins">Wins</option><option value="losses">Losses</option></select>
        </div>
      </div>
      <div className="panel" style={{ padding: 0 }}><div className="scroll"><table className="tbl">
        <thead><tr><th>Symbol</th><th>Strategy</th><th>Dir</th><th>Qty</th><th>Entry</th><th>Exit/Mark</th><th>P&L</th><th>%</th><th>R</th><th>Days</th><th>Grade</th><th></th></tr></thead>
        <tbody>
          {rows.map((t) => { const pnl = tradePnl(t), pct = tradeReturnPct(t), r = rMultiple(t), hd = holdDays(t); return (
            <tr key={t.id}>
              <td><span className="sym">{t.symbol}</span><div style={{ fontSize: 10.5, color: "#566079", textTransform: "uppercase" }}>{t.assetType}{t.assetType === "option" ? ` ${t.optionType} ${t.strike}` : ""}</div></td>
              <td style={{ color: "#8893AC", fontFamily: "var(--ui)", fontSize: 12.5 }}>{t.strategy}</td>
              <td><span className={`pill ${t.direction}`}>{t.direction}</span></td>
              <td>{t.quantity}</td><td>{fmtMoney(t.entryPrice)}</td>
              <td>{t.status === "closed" ? fmtMoney(t.exitPrice) : <span style={{ color: "#8893AC" }}>{fmtMoney(markOf(t))}</span>}</td>
              <td className={pnl >= 0 ? "pos" : "neg"} style={{ fontWeight: 600 }}>{fmtSigned(pnl)}</td>
              <td className={pct >= 0 ? "pos" : "neg"}>{fmtPct(pct)}</td>
              <td style={{ color: r == null ? "#566079" : r >= 0 ? "#4ADE9E" : "#FF6B7A" }}>{r == null ? "—" : `${r > 0 ? "+" : ""}${r.toFixed(1)}R`}</td>
              <td style={{ color: "#8893AC" }}>{hd == null ? "—" : hd}</td>
              <td><Rate n={t.rating} /></td>
              <td style={{ whiteSpace: "nowrap" }}><button className="iconbtn" onClick={() => onEdit(t)} aria-label="Edit"><Pencil /></button><button className="iconbtn del" onClick={() => onDelete(t.id)} aria-label="Delete"><Trash2 /></button></td>
            </tr>); })}
          {!rows.length && <tr><td colSpan={12} style={{ textAlign: "center", color: "#566079", padding: 30 }}>No trades match.</td></tr>}
        </tbody>
      </table></div></div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ANALYTICS                                                          */
/* ------------------------------------------------------------------ */

function Analytics({ M }) {
  const closed = M.closed;
  const bySymbol = useMemo(() => { const m = {}; closed.forEach((t) => { m[t.symbol] = (m[t.symbol] || 0) + realizedPnl(t); }); return Object.entries(m).map(([name, pnl]) => ({ name, pnl })).sort((a, b) => b.pnl - a.pnl); }, [closed]);
  const byStrat = useMemo(() => { const m = {}; closed.forEach((t) => { (m[t.strategy] = m[t.strategy] || { pnl: 0 }); m[t.strategy].pnl += realizedPnl(t); }); return Object.entries(m).map(([name, v]) => ({ name, pnl: v.pnl })).sort((a, b) => b.pnl - a.pnl); }, [closed]);
  const byDow = useMemo(() => { const m = Array(7).fill(0); closed.forEach((t) => { if (t.exitDate) m[new Date(t.exitDate).getDay()] += realizedPnl(t); }); return DOW.map((d, i) => ({ name: d, pnl: m[i] })).filter((_, i) => i >= 1 && i <= 5); }, [closed]);
  const scatter = useMemo(() => closed.filter((t) => holdDays(t) != null).map((t) => ({ x: holdDays(t), y: tradeReturnPct(t), sym: t.symbol })), [closed]);
  if (!closed.length) return <div className="panel"><p className="note">Close some trades to unlock analytics.</p></div>;
  const Bars = ({ data, title }) => (
    <div className="panel"><div className="ptitle"><BarChart3 />{title}</div><div style={{ height: 220 }}>
      <ResponsiveContainer><BarChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#1a2236" vertical={false} />
        <XAxis dataKey="name" tick={{ fill: "#566079", fontSize: 10.5, fontFamily: "var(--mono)" }} axisLine={false} tickLine={false} interval={0} angle={data.length > 6 ? -25 : 0} textAnchor={data.length > 6 ? "end" : "middle"} height={data.length > 6 ? 50 : 24} />
        <YAxis tick={{ fill: "#566079", fontSize: 10, fontFamily: "var(--mono)" }} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => fmtK(v)} />
        <Tooltip content={<ChartTip money />} cursor={{ fill: "rgba(255,255,255,.03)" }} />
        <ReferenceLine y={0} stroke="#2C3650" />
        <Bar dataKey="pnl" name="P&L" radius={[4, 4, 0, 0]}>{data.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? "#4ADE9E" : "#FF6B7A"} />)}</Bar>
      </BarChart></ResponsiveContainer></div></div>
  );
  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="grid g4">
        <Stat lab="Avg win" val={fmtSigned(M.avgWin)} cls="pos" /><Stat lab="Avg loss" val={fmtSigned(-M.avgLoss)} cls="neg" />
        <Stat lab="Win/Loss ratio" val={M.avgLoss ? (M.avgWin / M.avgLoss).toFixed(2) : "∞"} meta="avg win ÷ avg loss" />
        <Stat lab="Closed trades" val={closed.length} meta={`${M.wins.length}W / ${M.losses.length}L`} />
      </div>
      <div className="grid g2"><Bars data={bySymbol} title="P&L by symbol" /><Bars data={byStrat} title="P&L by strategy" /></div>
      <div className="grid g2"><Bars data={byDow} title="P&L by day of week" />
        <div className="panel"><div className="ptitle"><Target />Hold time vs return</div><div style={{ height: 220 }}>
          <ResponsiveContainer><ScatterChart margin={{ top: 6, right: 10, left: 0, bottom: 4 }}>
            <CartesianGrid stroke="#1a2236" />
            <XAxis type="number" dataKey="x" tick={{ fill: "#566079", fontSize: 10, fontFamily: "var(--mono)" }} axisLine={false} tickLine={false} label={{ value: "hold days", fill: "#566079", fontSize: 10, position: "insideBottom", offset: -2 }} />
            <YAxis type="number" dataKey="y" tick={{ fill: "#566079", fontSize: 10, fontFamily: "var(--mono)" }} axisLine={false} tickLine={false} width={42} tickFormatter={(v) => `${v.toFixed(0)}%`} />
            <Tooltip cursor={{ strokeDasharray: "3 3", stroke: "#2C3650" }} content={({ active, payload }) => { if (!active || !payload?.length) return null; const d = payload[0].payload; return <div style={{ background: "#0C111E", border: "1px solid #2C3650", borderRadius: 8, padding: 8, fontFamily: "var(--mono)", fontSize: 12 }}><b>{d.sym}</b> · {d.x}d · <span style={{ color: d.y >= 0 ? "#4ADE9E" : "#FF6B7A" }}>{fmtPct(d.y)}</span></div>; }} />
            <ReferenceLine y={0} stroke="#2C3650" />
            <Scatter data={scatter}>{scatter.map((d, i) => <Cell key={i} fill={d.y >= 0 ? "#4ADE9E" : "#FF6B7A"} />)}</Scatter>
          </ScatterChart></ResponsiveContainer></div></div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  MARGIN — status, scenario simulator, protection ideas             */
/* ------------------------------------------------------------------ */

function Margin({ trades, settings, setSettings, setTab }) {
  const [shock, setShock] = useState(-20);
  const mg = useMemo(() => computeMargin(trades, settings), [trades, settings]);
  const cs = useMemo(() => callShock(trades, settings), [trades, settings]);
  const sc = useMemo(() => scenarioAt(trades, settings, shock / 100), [trades, settings, shock]);
  const curve = useMemo(() => { const a = []; for (let s = -60; s <= 20; s += 2) { const r = scenarioAt(trades, settings, s / 100); a.push({ shock: s, cushion: Math.round(r.cushion) }); } return a; }, [trades, settings]);

  if (!mg.open.length) return <div className="panel"><p className="note">No open positions to analyze. The margin engine reads your live book.</p></div>;

  const inCall = mg.cushion < 0;
  const utilPct = mg.util === Infinity ? 100 : Math.min(100, mg.util * 100);
  const status = inCall ? { tone: "bad", c: "#FF6B7A", Ico: ShieldAlert, t: "Maintenance call", d: `Equity is below your maintenance requirement by ${fmtMoney(-mg.cushion, 0)}. Deposit or liquidate to cure.` }
    : !mg.levered ? { tone: "good", c: "#4ADE9E", Ico: ShieldCheck, t: "No leverage in use", d: "Positions are fully funded — a maintenance call isn't possible at current sizing. Scenarios still show drawdown impact." }
    : utilPct > 55 || (cs != null && cs > -0.15) ? { tone: "warn", c: "#E5B94E", Ico: Shield, t: "Elevated margin use", d: `A ${cs == null ? "—" : Math.abs(cs * 100).toFixed(0)}% market drop would trigger a call. Keep a cushion.` }
    : { tone: "good", c: "#4ADE9E", Ico: ShieldCheck, t: "Healthy cushion", d: `You can absorb roughly a ${cs == null ? "—" : Math.abs(cs * 100).toFixed(0)}% market drop before a maintenance call.` };

  const scStatus = sc.cushion < 0 ? "neg" : "pos";

  // protection ideas
  const ideas = [];
  const open = mg.open; const total = open.reduce((s, t) => s + marketValue(t), 0) || 1;
  const top = [...open].sort((a, b) => marketValue(b) - marketValue(a))[0];
  const topW = top ? (marketValue(top) / total) * 100 : 0;
  if (cs != null) ideas.push([cs > -0.15 ? "bad" : "warn", "Know your call distance", `Your account triggers a maintenance call at about a ${Math.abs(cs * 100).toFixed(1)}% adverse move. That's your real risk budget — size new trades against it, not against cash.`]);
  if (mg.debit > 0.5) ideas.push(["warn", "Pay down the margin loan", `You're carrying a ${fmtMoney(mg.debit, 0)} debit. Interest compounds daily and the loan amplifies both directions. Trimming the most extended position is the fastest de-risk.`]);
  if (topW > 35) ideas.push(["warn", "Concentration is your blind spot", `${top.symbol} is ${topW.toFixed(0)}% of your book. A single-name gap there moves the whole account. A protective put or a partial trim caps that tail.`]);
  if (utilPct > 45) ideas.push(["warn", "Keep maintenance use under ~40%", `You're using ${utilPct.toFixed(0)}% of equity as maintenance margin. Brokers can raise requirements without notice — staying under 40% leaves room for that and for volatility spikes.`]);
  ideas.push(["good", "Hold dry powder", "Cash is an option that never expires. A buffer of un-deployed equity means a drawdown is an opportunity to add, not a forced sale at the lows."]);
  ideas.push(["good", "Collar your largest longs", "Selling a covered call to finance a protective put (a collar) caps downside cheaply — well suited to your covered-call workflow and removes most margin-call risk on that name."]);
  ideas.push(["good", "Honor hard stops", "Most calls come from one position run too long. A pre-set stop converts an open-ended risk into a known, small loss before maintenance is ever threatened."]);
  ideas.push(["warn", "De-lever before binary events", "Earnings, FDA, macro prints — cut size or hedge ahead of known gap risk. Leverage into a coin-flip is how cushions vanish overnight."]);
  const ICON = { good: ShieldCheck, warn: Shield, bad: ShieldAlert };

  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="sec-head"><h2>Margin & risk</h2>
        <Toggle on={settings.marginEnabled} label="Margin account" onChange={(v) => setSettings((s) => ({ ...s, marginEnabled: v }))} />
      </div>

      <div className="statusbar" style={{ borderColor: status.c, background: `${status.c}14` }}>
        <status.Ico color={status.c} />
        <div><div className="st" style={{ color: status.c }}>{status.t}</div><div className="sd">{status.d}</div></div>
      </div>

      <div className="grid g4">
        <Stat lab="Account equity" val={fmtMoney(mg.equity, 0)} meta="net liquidation" />
        <Stat lab="Margin loan" val={fmtMoney(mg.debit, 0)} meta="cash debit" cls={mg.debit > 0 ? "neg" : ""} />
        <Stat lab="Maintenance req" val={fmtMoney(mg.maint, 0)} meta="must stay below equity" />
        <Stat lab="Excess liquidity" val={fmtMoney(mg.cushion, 0)} meta="equity − maintenance" cls={mg.cushion >= 0 ? "pos" : "neg"} />
      </div>

      <div className="panel">
        <div className="ptitle"><Gauge />Margin utilization</div>
        <div className="gauge"><i style={{ width: `${utilPct}%`, background: utilPct > 70 ? "var(--coral)" : utilPct > 45 ? "var(--gold)" : "var(--mint)" }} /></div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontFamily: "var(--mono)", fontSize: 11.5, color: "#8893AC" }}>
          <span>{utilPct.toFixed(0)}% of equity committed</span>
          <span>Long {fmtMoney(mg.LMV, 0)} · Short {fmtMoney(mg.SMV, 0)}</span>
        </div>
      </div>

      <div className="panel lg">
        <div className="ptitle"><TrendingDown />Margin-call scenario</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: 30, color: shock < 0 ? "var(--coral)" : "var(--mint)" }}>{shock > 0 ? "+" : ""}{shock}%</div>
          <div style={{ color: "#8893AC", fontSize: 13 }}>market move applied to your equity positions</div>
        </div>
        <input type="range" min={-60} max={20} step={1} value={shock} onChange={(e) => setShock(Number(e.target.value))} style={{ width: "100%", marginTop: 10, accentColor: "#E5B94E" }} />
        <div className="grid g4" style={{ marginTop: 18 }}>
          <Stat lab="Equity then" val={fmtMoney(sc.equity, 0)} cls={sc.equity >= mg.equity ? "pos" : "neg"} />
          <Stat lab="Maintenance" val={fmtMoney(sc.maint, 0)} />
          <Stat lab="Cushion" val={fmtMoney(sc.cushion, 0)} cls={scStatus} />
          <Stat lab={sc.cushion < 0 ? "Deposit to cure" : "Headroom"} val={fmtMoney(Math.abs(sc.cushion), 0)} cls={sc.cushion < 0 ? "neg" : "pos"} />
        </div>
        <div style={{ height: 200, marginTop: 16 }}>
          <ResponsiveContainer><LineChart data={curve} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid stroke="#1a2236" vertical={false} />
            <XAxis dataKey="shock" tick={{ fill: "#566079", fontSize: 10, fontFamily: "var(--mono)" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
            <YAxis tick={{ fill: "#566079", fontSize: 10, fontFamily: "var(--mono)" }} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => fmtK(v)} />
            <Tooltip content={({ active, payload, label }) => { if (!active || !payload?.length) return null; return <div style={{ background: "#0C111E", border: "1px solid #2C3650", borderRadius: 8, padding: 8, fontFamily: "var(--mono)", fontSize: 12 }}>{label}% move · cushion {fmtMoney(payload[0].value, 0)}</div>; }} />
            <ReferenceLine y={0} stroke="#FF6B7A" strokeDasharray="4 4" label={{ value: "call line", fill: "#FF6B7A", fontSize: 10, position: "insideTopLeft" }} />
            {cs != null && <ReferenceLine x={Math.round(cs * 100)} stroke="#E5B94E" strokeDasharray="3 3" />}
            <ReferenceLine x={shock} stroke="#6AA9FF" />
            <Line type="monotone" dataKey="cushion" name="cushion" stroke="#4ADE9E" strokeWidth={2.5} dot={false} />
          </LineChart></ResponsiveContainer>
        </div>
        <p className="note" style={{ marginTop: 8 }}>The green line is your excess liquidity at each market move; where it crosses the red line, a maintenance call begins{cs != null ? ` — about ${Math.abs(cs * 100).toFixed(0)}% down (gold marker)` : ""}. Options are held at current mark (Greeks aren't modeled), so equity-driven risk is what's shown.</p>
      </div>

      <div>
        <div className="ptitle"><Shield />Protect against a call</div>
        <div className="grid g2">
          {ideas.map(([tone, title, body], i) => { const Ico = ICON[tone]; return (
            <div key={i} className={`ins ${tone}`}><div className="ih"><Ico />{title}</div><p>{body}</p></div>); })}
        </div>
      </div>

      <p className="note">This is an educational approximation of broker margin math (Reg-T-style maintenance on a simplified ledger), not your broker's exact figures. Tune the maintenance rates in Settings. Not financial advice.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  INSIGHTS                                                           */
/* ------------------------------------------------------------------ */

function Insights({ M }) {
  const closed = M.closed;
  const insights = useMemo(() => {
    const out = []; if (closed.length < 3) return out;
    if (M.profitFactor !== Infinity) {
      if (M.profitFactor >= 1.75) out.push(["good", "Solid profit factor", `You earn $${M.profitFactor.toFixed(2)} for every $1 lost — a durable edge.`, "Protect it: keep position sizing consistent and avoid style drift."]);
      else if (M.profitFactor >= 1) out.push(["warn", "Thin profit factor", `At ${M.profitFactor.toFixed(2)} you're net positive but the margin is slim.`, "Cut your worst setup or tighten losers to lift this above 1.5."]);
      else out.push(["bad", "Losing more than you win", `Profit factor is ${M.profitFactor.toFixed(2)} — gross losses exceed gross wins.`, "Pause size; find the bleeding strategy/symbol below and stop trading it."]);
    }
    if (M.avgLoss > 0) { const wl = M.avgWin / M.avgLoss;
      if (M.winRate < 45 && wl < 1.5) out.push(["bad", "Low win rate without payoff", `You win ${M.winRate.toFixed(0)}% and winners are only ${wl.toFixed(1)}× losers — that grinds the account down.`, "Let winners run further, or be far more selective on entries."]);
      else if (M.winRate >= 55 && wl >= 1) out.push(["good", "Favorable win/payoff mix", `${M.winRate.toFixed(0)}% win rate with winners ${wl.toFixed(1)}× losers.`, "Scale size gradually while this holds."]);
    }
    const wHold = M.wins.map(holdDays).filter((x) => x != null), lHold = M.losses.map(holdDays).filter((x) => x != null);
    if (wHold.length && lHold.length) { const aw = wHold.reduce((a, b) => a + b, 0) / wHold.length, al = lHold.reduce((a, b) => a + b, 0) / lHold.length;
      if (al > aw * 1.3) out.push(["bad", "You hold losers longer than winners", `Losers sit ${al.toFixed(1)} days vs ${aw.toFixed(1)} for winners — the classic disposition effect.`, "Set a hard time-and-price stop and exit losers at least as fast as winners."]);
      else if (aw > al * 1.2) out.push(["good", "You cut losers fast", `Losers held ${al.toFixed(1)} days vs ${aw.toFixed(1)} for winners.`, "Rare discipline — keep journaling exits to reinforce it."]);
    }
    const sm = {}; closed.forEach((t) => { (sm[t.strategy] = sm[t.strategy] || { pnl: 0, n: 0, w: 0 }); const p = realizedPnl(t); sm[t.strategy].pnl += p; sm[t.strategy].n++; if (p > 0) sm[t.strategy].w++; });
    const strats = Object.entries(sm).filter(([, v]) => v.n >= 2);
    if (strats.length >= 2) { strats.sort((a, b) => b[1].pnl / b[1].n - a[1].pnl / a[1].n); const [bN, bV] = strats[0], [wN, wV] = strats[strats.length - 1];
      out.push(["good", `"${bN}" is your edge`, `Averages ${fmtSigned(bV.pnl / bV.n)} per trade (${bV.w}/${bV.n} winners).`, `Give ${bN} setups more attention and size.`]);
      if (wV.pnl < 0) out.push(["warn", `"${wN}" is dragging you down`, `Averages ${fmtSigned(wV.pnl / wV.n)} across ${wV.n} trades.`, `Paper-trade ${wN} until it proves an edge, or drop it.`]);
    }
    const longs = closed.filter((t) => t.direction === "long"), shorts = closed.filter((t) => t.direction === "short");
    if (longs.length >= 2 && shorts.length >= 2) { const lp = longs.reduce((s, t) => s + realizedPnl(t), 0) / longs.length, sp = shorts.reduce((s, t) => s + realizedPnl(t), 0) / shorts.length;
      if (Math.abs(lp - sp) > Math.max(20, Math.abs(M.expectancy))) { const lb = lp > sp; out.push(["warn", `Your ${lb ? "short" : "long"} side is weaker`, `Longs average ${fmtSigned(lp)} vs ${fmtSigned(sp)} for shorts.`, `Lean into ${lb ? "long" : "short"} setups; size down the weaker side.`]); }
    }
    const cm = {}; closed.forEach((t) => { cm[t.symbol] = (cm[t.symbol] || 0) + realizedPnl(t); });
    const syms = Object.entries(cm).sort((a, b) => a[1] - b[1]);
    if (syms.length >= 3 && syms[0][1] < 0) out.push(["bad", `${syms[0][0]} keeps beating you`, `Your worst symbol at ${fmtSigned(syms[0][1])} cumulative.`, `Add ${syms[0][0]} to a "do not trade" list for a month and watch your P&L.`]);
    const dm = Array(7).fill(0).map(() => ({ pnl: 0, n: 0 })); closed.forEach((t) => { if (t.exitDate) { const d = new Date(t.exitDate).getDay(); dm[d].pnl += realizedPnl(t); dm[d].n++; } });
    const days = dm.map((v, i) => ({ d: DOW[i], ...v })).filter((x) => x.n >= 2);
    if (days.length >= 3) { days.sort((a, b) => a.pnl / a.n - b.pnl / b.n); const w = days[0]; if (w.pnl < 0) out.push(["warn", `${w.d} is your weak day`, `Trades closed on ${w.d} average ${fmtSigned(w.pnl / w.n)}.`, `Trade lighter on ${w.d}s, or review what's different about those entries.`]); }
    const graded = closed.filter((t) => t.rating); if (graded.length >= 4) { const low = graded.filter((t) => t.rating <= 2); const lp = low.reduce((s, t) => s + realizedPnl(t), 0);
      if (low.length >= 2) out.push([lp < 0 ? "bad" : "warn", "Your low-grade trades cost you", `1–2★ trades total ${fmtSigned(lp)} across ${low.length} trades — you usually know in the moment.`, "When you'd grade a setup ≤2★ before entering, skip it. Cheapest edge available."]);
    }
    return out;
  }, [closed, M]);
  if (closed.length < 3) return <div className="panel"><p className="note">Log at least 3 closed trades and the journal will surface patterns in your behavior and edge.</p></div>;
  const ICON = { good: CheckCircle2, warn: AlertTriangle, bad: AlertTriangle };
  return (
    <div>
      <div className="sec-head"><h2>Behavioral insights</h2><span className="note">From your {closed.length} closed trades · updates as you log</span></div>
      <div className="grid g2">{insights.map(([tone, title, body, sug], i) => { const Ico = ICON[tone] || Info; return (
        <div key={i} className={`ins ${tone}`}><div className="ih"><Ico />{title}</div><p>{body}</p><div className="sug">→ {sug}</div></div>); })}</div>
      <p className="note" style={{ marginTop: 16 }}>Data-driven observations, not financial advice. The more honestly you log setups, grades and notes, the sharper they get.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SETTINGS                                                           */
/* ------------------------------------------------------------------ */

function SettingsView({ settings, setSettings, trades, setTrades, flash }) {
  const [local, setLocal] = useState(settings); const fileRef = useRef();
  useEffect(() => setLocal(settings), [settings]);
  const save = () => { setSettings({ ...local, startCapital: Number(local.startCapital) || 0, maintLong: Number(local.maintLong) || 0.25, maintShort: Number(local.maintShort) || 0.30, maintShortOpt: Number(local.maintShortOpt) || 1.0 }); flash("Settings saved"); };
  const exportJson = () => { const blob = new Blob([JSON.stringify({ trades, settings }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `rugpull-journal-${todayStr()}.json`; a.click(); URL.revokeObjectURL(url); };
  const importJson = (e) => { const file = e.target.files?.[0]; if (!file) return; const r = new FileReader(); r.onload = () => { try { const d = JSON.parse(r.result); if (Array.isArray(d.trades)) { setTrades(d.trades); if (d.settings) setSettings({ ...defaultSettings, ...d.settings }); flash("Journal imported"); } else flash("Invalid file"); } catch { flash("Could not parse file"); } }; r.readAsText(file); };
  return (
    <div className="grid" style={{ gap: 18, maxWidth: 760 }}>
      <div className="panel lg">
        <div className="ptitle"><SettingsIcon />Account</div>
        <div className="grid g2">
          <div><label>Starting capital (cash deposit)</label><input value={local.startCapital} onChange={(e) => setLocal({ ...local, startCapital: e.target.value })} /></div>
          <div><label>Base currency</label><input value={local.currency} onChange={(e) => setLocal({ ...local, currency: e.target.value })} /></div>
          <div className="span2"><label>Financial Modeling Prep API key</label><input type="password" value={local.apiKey} onChange={(e) => setLocal({ ...local, apiKey: e.target.value })} placeholder="paste FMP key for live prices" /></div>
        </div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 16 }}>
          <Toggle on={local.marginEnabled} label="Margin account" onChange={(v) => setLocal({ ...local, marginEnabled: v })} />
          <Toggle on={local.autoExpire} label="Auto-expire options worthless" onChange={(v) => setLocal({ ...local, autoExpire: v })} />
        </div>
        <div style={{ marginTop: 16 }}><button className="btn gold" onClick={save}>Save settings</button></div>
        <p className="note" style={{ marginTop: 12 }}>Your key lives only in this journal's private storage. If live fetches are blocked, set marks manually — every metric still works.</p>
      </div>

      <div className="panel lg">
        <div className="ptitle"><Coins />Maintenance margin rates</div>
        <div className="grid g3">
          <div><label>Long equity</label><input value={local.maintLong} onChange={(e) => setLocal({ ...local, maintLong: e.target.value })} /></div>
          <div><label>Short equity</label><input value={local.maintShort} onChange={(e) => setLocal({ ...local, maintShort: e.target.value })} /></div>
          <div><label>Short option</label><input value={local.maintShortOpt} onChange={(e) => setLocal({ ...local, maintShortOpt: e.target.value })} /></div>
        </div>
        <p className="note" style={{ marginTop: 12 }}>Fractions, e.g. 0.25 = 25%. Defaults follow typical brokerage maintenance (25% long, 30% short). Long options are treated as fully paid.</p>
      </div>

      <div className="panel lg">
        <div className="ptitle"><Download />Data</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={exportJson}><Download />Export JSON</button>
          <button className="btn" onClick={() => fileRef.current?.click()}><Upload />Import JSON</button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={importJson} />
          <button className="btn danger" onClick={() => { if (confirm("Delete all trades? This cannot be undone.")) { setTrades([]); flash("Journal cleared"); } }}><Trash2 />Clear all trades</button>
        </div>
        <p className="note" style={{ marginTop: 12 }}>Auto-saves and persists across sessions. Export regularly as a backup.</p>
      </div>
    </div>
  );
}
