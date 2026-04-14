import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import * as d3 from "d3";

// ─── THEME ───
const T = {
  bg: "#0a0e17",
  surface: "#111827",
  surface2: "#1a2235",
  border: "#1e293b",
  text: "#e2e8f0",
  muted: "#64748b",
  accent: "#38bdf8",
  green: "#22c55e",
  red: "#ef4444",
  yellow: "#eab308",
  purple: "#a78bfa",
  orange: "#fb923c",
  gridLine: "#1e293b",
  font: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
  fontSans: "'DM Sans', 'Segoe UI', sans-serif",
};

const parseCSV = (text) => {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(";").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split(";");
    const obj = {};
    headers.forEach((h, i) => (obj[h] = vals[i]?.trim() ?? ""));
    return obj;
  });
};

const parsePriceData = (rows) => {
  const products = {};
  rows.forEach((r) => {
    const ts = parseInt(r.timestamp || r.day * 1e6 + parseInt(r.timestamp || 0));
    const product = r.product;
    if (!product) return;
    if (!products[product]) products[product] = [];

    const bids = [];
    const asks = [];
    for (let i = 1; i <= 3; i++) {
      const bp = parseFloat(r[`bid_price_${i}`]);
      const bv = parseInt(r[`bid_volume_${i}`]);
      const ap = parseFloat(r[`ask_price_${i}`]);
      const av = parseInt(r[`ask_volume_${i}`]);
      if (!isNaN(bp) && !isNaN(bv)) bids.push({ price: bp, volume: bv });
      if (!isNaN(ap) && !isNaN(av)) asks.push({ price: ap, volume: Math.abs(av) });
    }
    const mid = bids.length && asks.length ? (bids[0].price + asks[0].price) / 2 : null;

    let wallBid = null, wallAsk = null;
    if (bids.length) wallBid = bids.reduce((a, b) => (b.volume > a.volume ? b : a)).price;
    if (asks.length) wallAsk = asks.reduce((a, b) => (b.volume > a.volume ? b : a)).price;
    const wallMid = wallBid !== null && wallAsk !== null ? (wallBid + wallAsk) / 2 : mid;

    const mp = parseFloat(r.mid_price);
    products[product].push({
      timestamp: ts,
      bids, asks,
      mid: !isNaN(mp) ? mp : mid,
      wallMid,
      wallBid, wallAsk,
      bestBid: bids[0]?.price,
      bestAsk: asks[0]?.price,
      spread: bids[0] && asks[0] ? asks[0].price - bids[0].price : null,
    });
  });
  return products;
};

const parseTradeData = (rows) => {
  const products = {};
  rows.forEach((r) => {
    const product = r.symbol || r.product;
    if (!product) return;
    if (!products[product]) products[product] = [];
    products[product].push({
      timestamp: parseInt(r.timestamp),
      price: parseFloat(r.price),
      quantity: parseInt(r.quantity),
      buyer: r.buyer,
      seller: r.seller,
    });
  });
  return products;
};

// ─── CHART (canvas for performance) ───
function PriceChart({ data, title, height = 280 }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !data?.length) return;

    const w = container.clientWidth;
    const h = height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const pad = { top: 20, right: 60, bottom: 30, left: 70 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    const xMin = d3.min(data, (d) => d.timestamp);
    const xMax = d3.max(data, (d) => d.timestamp);
    const prices = data.flatMap((d) => [d.mid, d.wallMid, d.bestBid, d.bestAsk].filter((v) => v != null));
    const yMin = d3.min(prices) * 0.9995;
    const yMax = d3.max(prices) * 1.0005;

    const sx = (v) => pad.left + ((v - xMin) / (xMax - xMin || 1)) * cw;
    const sy = (v) => pad.top + ch - ((v - yMin) / (yMax - yMin || 1)) * ch;

    // background
    ctx.fillStyle = T.surface;
    ctx.fillRect(0, 0, w, h);

    // grid
    ctx.strokeStyle = T.gridLine;
    ctx.lineWidth = 0.5;
    const yTicks = d3.ticks(yMin, yMax, 6);
    yTicks.forEach((t) => {
      ctx.beginPath();
      ctx.moveTo(pad.left, sy(t));
      ctx.lineTo(w - pad.right, sy(t));
      ctx.stroke();
    });

    // y-axis labels
    ctx.fillStyle = T.muted;
    ctx.font = `10px ${T.font}`;
    ctx.textAlign = "right";
    yTicks.forEach((t) => ctx.fillText(t.toFixed(1), pad.left - 6, sy(t) + 3));

    // x-axis labels
    ctx.textAlign = "center";
    const xTicks = d3.ticks(xMin, xMax, 6);
    xTicks.forEach((t) => ctx.fillText(Math.round(t), sx(t), h - 6));

    // draw lines
    const drawLine = (key, color, width = 1.5, dash = []) => {
      const pts = data.filter((d) => d[key] != null);
      if (pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      pts.forEach((d, i) => {
        const x = sx(d.timestamp), y = sy(d[key]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // spread fill
    const bidPts = data.filter(d => d.bestBid != null);
    const askPts = data.filter(d => d.bestAsk != null);
    if (bidPts.length > 1 && askPts.length > 1) {
      ctx.fillStyle = "rgba(56,189,248,0.05)";
      ctx.beginPath();
      bidPts.forEach((d, i) => {
        const x = sx(d.timestamp), y = sy(d.bestBid);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      for (let i = askPts.length - 1; i >= 0; i--) {
        ctx.lineTo(sx(askPts[i].timestamp), sy(askPts[i].bestAsk));
      }
      ctx.closePath();
      ctx.fill();
    }

    drawLine("bestBid", T.green + "88", 1);
    drawLine("bestAsk", T.red + "88", 1);
    drawLine("mid", T.accent, 2);
    drawLine("wallMid", T.yellow, 1.5, [4, 2]);

    // legend
    const legends = [
      { label: "Mid", color: T.accent },
      { label: "Wall Mid", color: T.yellow },
      { label: "Best Bid", color: T.green + "88" },
      { label: "Best Ask", color: T.red + "88" },
    ];
    ctx.font = `10px ${T.fontSans}`;
    let lx = pad.left + 8;
    legends.forEach(({ label, color }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lx, pad.top + 8);
      ctx.lineTo(lx + 16, pad.top + 8);
      ctx.stroke();
      ctx.fillStyle = T.text;
      ctx.textAlign = "left";
      ctx.fillText(label, lx + 20, pad.top + 12);
      lx += ctx.measureText(label).width + 36;
    });

    // title
    ctx.font = `bold 12px ${T.fontSans}`;
    ctx.fillStyle = T.text;
    ctx.textAlign = "right";
    ctx.fillText(title, w - pad.right, pad.top + 12);
  }, [data, title, height]);

  return (
    <div ref={containerRef} style={{ width: "100%", borderRadius: 8, overflow: "hidden", border: `1px solid ${T.border}` }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

// ─── ORDER BOOK DEPTH (scatter plot inspired by FrankfurtHedgehogs) ───
function OrderBookScatter({ data, timestamp }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const idx = useMemo(() => {
    if (!data?.length) return -1;
    let best = 0;
    data.forEach((d, i) => { if (Math.abs(d.timestamp - timestamp) < Math.abs(data[best].timestamp - timestamp)) best = i; });
    return best;
  }, [data, timestamp]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || idx < 0) return;

    const w = container.clientWidth;
    const h = 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    ctx.fillStyle = T.surface;
    ctx.fillRect(0, 0, w, h);

    const snap = data[idx];
    const all = [...snap.bids.map((b) => ({ ...b, side: "bid" })), ...snap.asks.map((a) => ({ ...a, side: "ask" }))];
    if (!all.length) return;

    const pad = { top: 20, right: 20, bottom: 30, left: 60 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    const priceMin = d3.min(all, (d) => d.price) - 1;
    const priceMax = d3.max(all, (d) => d.price) + 1;
    const volMax = d3.max(all, (d) => d.volume);

    const sx = (v) => pad.left + ((v - priceMin) / (priceMax - priceMin || 1)) * cw;
    const sy = (v) => pad.top + ch - (v / (volMax || 1)) * ch;
    const sr = (v) => Math.max(4, Math.min(20, (v / (volMax || 1)) * 20));

    // grid
    ctx.strokeStyle = T.gridLine;
    ctx.lineWidth = 0.5;
    d3.ticks(priceMin, priceMax, 8).forEach((t) => {
      ctx.beginPath(); ctx.moveTo(sx(t), pad.top); ctx.lineTo(sx(t), h - pad.bottom); ctx.stroke();
    });

    // dots
    all.forEach((d) => {
      const x = sx(d.price);
      const y = sy(d.volume);
      const r = sr(d.volume);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = d.side === "bid" ? T.green + "bb" : T.red + "bb";
      ctx.fill();
      ctx.strokeStyle = d.side === "bid" ? T.green : T.red;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // wall mid line
    if (snap.wallMid) {
      ctx.strokeStyle = T.yellow;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      const mx = sx(snap.wallMid);
      ctx.beginPath(); ctx.moveTo(mx, pad.top); ctx.lineTo(mx, h - pad.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = T.yellow;
      ctx.font = `9px ${T.font}`;
      ctx.textAlign = "center";
      ctx.fillText(`WM: ${snap.wallMid.toFixed(1)}`, mx, pad.top - 4);
    }

    // labels
    ctx.fillStyle = T.muted;
    ctx.font = `10px ${T.font}`;
    ctx.textAlign = "center";
    d3.ticks(priceMin, priceMax, 8).forEach((t) => ctx.fillText(t.toFixed(0), sx(t), h - 8));
    ctx.textAlign = "right";
    d3.ticks(0, volMax, 4).forEach((t) => ctx.fillText(t.toFixed(0), pad.left - 6, sy(t) + 3));

    ctx.font = `bold 11px ${T.fontSans}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = "left";
    ctx.fillText(`T=${snap.timestamp}`, pad.left + 4, pad.top + 12);
  }, [data, idx, timestamp]);

  return (
    <div ref={containerRef} style={{ width: "100%", borderRadius: 8, overflow: "hidden", border: `1px solid ${T.border}` }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

// ─── STATS PANEL ───
function Stats({ data, product }) {
  if (!data?.length) return null;
  const last = data[data.length - 1];
  const first = data[0];
  const spreads = data.map((d) => d.spread).filter((s) => s != null);
  const avgSpread = spreads.length ? (spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(2) : "N/A";
  const mids = data.map((d) => d.mid).filter((m) => m != null);
  const vol = mids.length > 1 ? d3.deviation(mids)?.toFixed(2) ?? "N/A" : "N/A";
  const priceChange = mids.length > 1 ? ((mids[mids.length - 1] - mids[0]) / mids[0] * 100).toFixed(3) : "0";

  const stats = [
    { label: "Last Mid", value: last.mid?.toFixed(2) ?? "N/A", color: T.accent },
    { label: "Wall Mid", value: last.wallMid?.toFixed(2) ?? "N/A", color: T.yellow },
    { label: "Spread", value: last.spread?.toFixed(2) ?? "N/A", color: T.purple },
    { label: "Avg Spread", value: avgSpread, color: T.purple },
    { label: "Volatility", value: vol, color: T.orange },
    { label: "Change %", value: priceChange + "%", color: parseFloat(priceChange) >= 0 ? T.green : T.red },
    { label: "Ticks", value: data.length.toString(), color: T.muted },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
      {stats.map((s) => (
        <div key={s.label} style={{ background: T.surface2, borderRadius: 6, padding: "10px 12px", border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontSans, textTransform: "uppercase", letterSpacing: 1 }}>{s.label}</div>
          <div style={{ fontSize: 16, color: s.color, fontFamily: T.font, fontWeight: 700, marginTop: 2 }}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── SPREAD CHART ───
function SpreadChart({ data, height = 140 }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !data?.length) return;

    const spreads = data.filter(d => d.spread != null);
    if (spreads.length < 2) return;

    const w = container.clientWidth;
    const h = height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const pad = { top: 16, right: 20, bottom: 24, left: 50 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = T.surface;
    ctx.fillRect(0, 0, w, h);

    const xMin = d3.min(spreads, d => d.timestamp);
    const xMax = d3.max(spreads, d => d.timestamp);
    const yMax = d3.max(spreads, d => d.spread) * 1.1;

    const sx = v => pad.left + ((v - xMin) / (xMax - xMin || 1)) * cw;
    const sy = v => pad.top + ch - (v / (yMax || 1)) * ch;

    // fill
    ctx.fillStyle = T.purple + "15";
    ctx.beginPath();
    ctx.moveTo(sx(spreads[0].timestamp), sy(0));
    spreads.forEach(d => ctx.lineTo(sx(d.timestamp), sy(d.spread)));
    ctx.lineTo(sx(spreads[spreads.length - 1].timestamp), sy(0));
    ctx.closePath();
    ctx.fill();

    // line
    ctx.strokeStyle = T.purple;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    spreads.forEach((d, i) => {
      const x = sx(d.timestamp), y = sy(d.spread);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = T.muted;
    ctx.font = `10px ${T.font}`;
    ctx.textAlign = "right";
    d3.ticks(0, yMax, 4).forEach(t => ctx.fillText(t.toFixed(1), pad.left - 6, sy(t) + 3));

    ctx.font = `bold 11px ${T.fontSans}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = "left";
    ctx.fillText("Spread Over Time", pad.left + 4, pad.top + 8);
  }, [data, height]);

  return (
    <div ref={containerRef} style={{ width: "100%", borderRadius: 8, overflow: "hidden", border: `1px solid ${T.border}` }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

// ─── MAIN APP ───
export default function ProsperityDashboard() {
  const [priceData, setPriceData] = useState(null);
  const [tradeData, setTradeData] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [sliderVal, setSliderVal] = useState(100);
  const [dragOver, setDragOver] = useState(false);

  const products = useMemo(() => (priceData ? Object.keys(priceData).sort() : []), [priceData]);
  const currentData = useMemo(() => (selectedProduct && priceData ? priceData[selectedProduct] : null), [selectedProduct, priceData]);
  const currentTimestamp = useMemo(() => {
    if (!currentData?.length) return 0;
    const idx = Math.round((sliderVal / 100) * (currentData.length - 1));
    return currentData[idx]?.timestamp ?? 0;
  }, [currentData, sliderVal]);

  const handleFile = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const rows = parseCSV(text);
      if (!rows.length) return;
      const headers = Object.keys(rows[0]);
      if (headers.some((h) => h.includes("bid_price"))) {
        const parsed = parsePriceData(rows);
        setPriceData(parsed);
        const keys = Object.keys(parsed);
        if (keys.length && !selectedProduct) setSelectedProduct(keys[0]);
      } else if (headers.includes("buyer") || headers.includes("seller")) {
        setTradeData(parseTradeData(rows));
      } else {
        const parsed = parsePriceData(rows);
        if (Object.keys(parsed).length) {
          setPriceData(parsed);
          const keys = Object.keys(parsed);
          if (keys.length) setSelectedProduct(keys[0]);
        }
      }
    };
    reader.readAsText(file);
  }, [selectedProduct]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    [...e.dataTransfer.files].forEach(handleFile);
  }, [handleFile]);

  const handleFileInput = useCallback((e) => {
    [...e.target.files].forEach(handleFile);
  }, [handleFile]);

  const loadDemo = useCallback(() => {
    const N = 500;
    const genProduct = (name, basePrice, volatility) => {
      const data = [];
      let price = basePrice;
      for (let i = 0; i < N; i++) {
        price += (Math.random() - 0.5) * volatility;
        const spread = 1 + Math.random() * 2;
        const bb = Math.round(price - spread / 2);
        const ba = Math.round(price + spread / 2);
        const wallBid = bb - Math.round(Math.random() * 2);
        const wallAsk = ba + Math.round(Math.random() * 2);
        data.push({
          timestamp: i * 100,
          mid: (bb + ba) / 2,
          bestBid: bb,
          bestAsk: ba,
          wallBid,
          wallAsk,
          wallMid: (wallBid + wallAsk) / 2,
          spread: ba - bb,
          bids: [
            { price: bb, volume: 5 + Math.floor(Math.random() * 10) },
            { price: wallBid, volume: 20 + Math.floor(Math.random() * 30) },
          ],
          asks: [
            { price: ba, volume: 5 + Math.floor(Math.random() * 10) },
            { price: wallAsk, volume: 20 + Math.floor(Math.random() * 30) },
          ],
        });
      }
      return data;
    };
    const demo = {
      STARFRUIT: genProduct("STARFRUIT", 5000, 8),
      AMETHYSTS: genProduct("AMETHYSTS", 10000, 1),
      ORCHIDS: genProduct("ORCHIDS", 1100, 15),
    };
    setPriceData(demo);
    setSelectedProduct("STARFRUIT");
  }, []);

  // ─── RENDER ───
  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: T.fontSans, padding: 0 }}>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${T.border}`, padding: "12px 20px", display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.accent, boxShadow: `0 0 8px ${T.accent}` }} />
          <span style={{ fontFamily: T.font, fontWeight: 700, fontSize: 15, letterSpacing: 1.5 }}>PROSPERITY</span>
          <span style={{ fontFamily: T.font, fontWeight: 300, fontSize: 15, color: T.muted }}>DASHBOARD</span>
        </div>
        <div style={{ flex: 1 }} />
        {products.length > 0 && (
          <div style={{ display: "flex", gap: 4 }}>
            {products.map((p) => (
              <button
                key={p}
                onClick={() => setSelectedProduct(p)}
                style={{
                  background: p === selectedProduct ? T.accent + "22" : "transparent",
                  border: `1px solid ${p === selectedProduct ? T.accent : T.border}`,
                  color: p === selectedProduct ? T.accent : T.muted,
                  padding: "4px 12px",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontFamily: T.font,
                  fontSize: 11,
                  fontWeight: 600,
                  transition: "all 0.15s",
                }}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <label style={{
          background: T.accent + "15",
          border: `1px solid ${T.accent}40`,
          color: T.accent,
          padding: "5px 14px",
          borderRadius: 4,
          cursor: "pointer",
          fontFamily: T.font,
          fontSize: 11,
          fontWeight: 600,
        }}>
          LOAD CSV
          <input type="file" accept=".csv" multiple onChange={handleFileInput} style={{ display: "none" }} />
        </label>
        <button
          onClick={loadDemo}
          style={{
            background: "transparent",
            border: `1px solid ${T.border}`,
            color: T.muted,
            padding: "5px 14px",
            borderRadius: 4,
            cursor: "pointer",
            fontFamily: T.font,
            fontSize: 11,
          }}
        >
          DEMO
        </button>
      </div>

      {/* Drop zone / content */}
      {!priceData ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            margin: 40,
            border: `2px dashed ${dragOver ? T.accent : T.border}`,
            borderRadius: 12,
            padding: "80px 40px",
            textAlign: "center",
            transition: "border-color 0.2s",
            background: dragOver ? T.accent + "08" : "transparent",
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>📊</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Drop your Prosperity CSV files here</div>
          <div style={{ color: T.muted, fontSize: 13, maxWidth: 500, margin: "0 auto", lineHeight: 1.6 }}>
            Load price data CSVs (with columns like <code style={{ fontFamily: T.font, color: T.accent }}>bid_price_1</code>, <code style={{ fontFamily: T.font, color: T.accent }}>ask_price_1</code>, etc.)
            from the Prosperity data downloads or backtester output.
            <br /><br />
            Or click <strong>DEMO</strong> above to explore with sample data.
          </div>
        </div>
      ) : (
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Stats */}
          <Stats data={currentData} product={selectedProduct} />

          {/* Price Chart */}
          <PriceChart data={currentData} title={selectedProduct || ""} height={280} />

          {/* Slider */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: T.font, fontSize: 10, color: T.muted, minWidth: 80 }}>TIMESTAMP</span>
            <input
              type="range"
              min={0}
              max={100}
              value={sliderVal}
              onChange={(e) => setSliderVal(+e.target.value)}
              style={{ flex: 1, accentColor: T.accent }}
            />
            <span style={{ fontFamily: T.font, fontSize: 12, color: T.accent, minWidth: 80, textAlign: "right" }}>{currentTimestamp}</span>
          </div>

          {/* Bottom panels */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, fontFamily: T.font, color: T.muted, marginBottom: 6, letterSpacing: 1 }}>ORDER BOOK DEPTH</div>
              <OrderBookScatter data={currentData} timestamp={currentTimestamp} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontFamily: T.font, color: T.muted, marginBottom: 6, letterSpacing: 1 }}>SPREAD ANALYSIS</div>
              <SpreadChart data={currentData} height={200} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
