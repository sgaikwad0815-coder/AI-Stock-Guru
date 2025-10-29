/*
script.js
Client-side AI Stock Guru logic.
- Fetches historical OHLC using Yahoo Finance chart endpoint.
- Computes simple indicators (SMA, RSI, MACD, Bollinger) in JS.
- Ranks universe by expected profit and shows top picks.
- Draws candlestick using lightweight-charts.
Notes: Some endpoints may be subject to CORS depending on hosting. If blocked, demo data is used.
*/
const DEFAULT_TICKERS = [
  'RELIANCE.NS','TCS.NS','INFY.NS','HDFCBANK.NS','HDFC.NS','ICICIBANK.NS','LT.NS','KOTAKBANK.NS',
  'SBIN.NS','AXISBANK.NS','BAJAJFINSV.NS','BHARTIARTL.NS','ITC.NS','HINDUNILVR.NS','MARUTI.NS','TATAMOTORS.NS',
  'ONGC.NS','POWERGRID.NS','NTPC.NS','BPCL.NS','EICHERMOT.NS','ADANIENT.NS','ASIANPAINT.NS','DIVISLAB.NS',
  'SUNPHARMA.NS','DRREDDY.NS','TECHM.NS','WIPRO.NS','JSWSTEEL.NS','TATASTEEL.NS','ULTRACEMCO.NS','HEROMOTOCO.NS',
  'GRASIM.NS','CIPLA.NS','BRITANNIA.NS','TITAN.NS','HCLTECH.NS','COALINDIA.NS','HDFCLIFE.NS','ICICIPRULI.NS'
];

function fmt(n){ return Number(n).toLocaleString('en-IN', {maximumFractionDigits:2}); }

async function fetchOHLCYahoo(symbol, period='6mo', interval='1d') {
  // Yahoo chart endpoint
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${period}&interval=${interval}`;
  try {
    const r = await fetch(url);
    if(!r.ok) throw new Error('Fetch failed ' + r.status);
    const j = await r.json();
    const result = j.chart.result[0];
    const ts = result.timestamp.map(t => new Date(t*1000));
    const o = result.indicators.quote[0].open;
    const h = result.indicators.quote[0].high;
    const l = result.indicators.quote[0].low;
    const c = result.indicators.quote[0].close;
    // return array of objects
    const out = [];
    for(let i=0;i<ts.length;i++){
      if(o[i]==null||h[i]==null||l[i]==null||c[i]==null) continue;
      out.push({t: ts[i].toISOString().slice(0,10), o:o[i], h:h[i], l:l[i], c:c[i]});
    }
    return out;
  } catch(e){
    console.warn('Yahoo fetch failed for', symbol, e);
    return null;
  }
}

// Simple indicator helpers (pure JS arrays)
function sma(arr, window, accessor = x => x) {
  const res = [];
  for(let i=0;i<arr.length;i++){
    const slice = arr.slice(Math.max(0,i-window+1), i+1).map(accessor);
    const sum = slice.reduce((a,b)=>a+(b||0),0);
    res.push(sum / slice.length);
  }
  return res;
}

function rsi(arr, period=14) {
  const closes = arr.map(x=>x.c);
  const deltas = closes.map((v,i)=> i? closes[i]-closes[i-1]:0);
  let gains=0, losses=0;
  const res=[];
  for(let i=0;i<deltas.length;i++){
    const d=deltas[i];
    gains = (gains*(period-1) + Math.max(0,d))/period;
    losses = (losses*(period-1) + Math.max(0,-d))/period;
    const rs = gains/(losses||1e-9);
    res.push(100 - 100/(1+rs));
  }
  return res;
}

function macdLines(arr, fast=12, slow=26, signal=9) {
  const closes = arr.map(x=>x.c);
  function ema(series, span){
    const k=2/(span+1); const res=[]; let prev=null;
    for(let i=0;i<series.length;i++){ const v=series[i]; if(prev==null){ prev=v; res.push(v); } else { prev = v*k + prev*(1-k); res.push(prev); } }
    return res;
  }
  const efast = ema(closes, fast), eslow = ema(closes, slow);
  const macd = efast.map((v,i)=> v - eslow[i]);
  const signalLine = ema(macd, signal);
  const hist = macd.map((v,i)=> v - signalLine[i]);
  return {macd, signalLine, hist};
}

function bollinger(arr, window=20, n=2){ const closes=arr.map(x=>x.c); const m=sma(arr,window,x=>x.c); const stds = []; for(let i=0;i<closes.length;i++){ const slice=closes.slice(Math.max(0,i-window+1),i+1); const mean=m[i]; const variance = slice.reduce((a,b)=>a+Math.pow(b-mean,2),0)/slice.length; stds.push(Math.sqrt(variance)); } const lower = m.map((v,i)=> v - n*stds[i]); const upper = m.map((v,i)=> v + n*stds[i]); return {lower,mid:m,upper}; }

function analyzeSeries(series, capital=100000, risk_pct=1, target_pct=12, mode='swing') {
  if(!series || series.length<10) return null;
  const last = series[series.length-1].c;
  const sma20 = sma(series,20,x=>x.c).slice(-1)[0];
  const sma50 = sma(series,50,x=>x.c).slice(-1)[0];
  const rsi14 = rsi(series,14).slice(-1)[0];
  const macd = macdLines(series);
  const macd_now = macd.macd.slice(-1)[0], macd_sig = macd.signalLine.slice(-1)[0];
  const bb = bollinger(series,20,2);
  const bb_low = bb.lower.slice(-1)[0], bb_up = bb.upper.slice(-1)[0];
  const atr_val = Math.abs(series[series.length-1].h - series[series.length-1].l); // simple proxy

  let score=0; const reasons=[];
  if(sma50){ if(last > sma50){ score++; reasons.push('Price above 50 SMA (uptrend)'); } else { score--; reasons.push('Price below 50 SMA (downtrend)'); } }
  if(rsi14){ if(rsi14<30){ score++; reasons.push('RSI < 30 (oversold)'); } else if(rsi14>70){ score--; reasons.push('RSI > 70 (overbought)'); } else reasons.push(`RSI ${rsi14.toFixed(1)} (neutral)`); }
  if(macd_now && macd_sig){ if(macd_now > macd_sig){ score++; reasons.push('MACD bullish'); } else { score--; reasons.push('MACD bearish'); } }
  if(bb_low && bb_up){ if(last <= bb_low){ score++; reasons.push('Price near lower Bollinger (value)'); } else if(last >= bb_up){ score--; reasons.push('Price near upper Bollinger (extended)'); } else reasons.push('Price within Bollinger bands'); }

  const rec = score>=2? 'BUY': (score<=-2? 'SELL':'HOLD');
  const entry = rec==='BUY'? +(last*0.995).toFixed(2): last;
  const stop = +(last*0.95).toFixed(2);
  const target = +(last*(1+target_pct/100)).toFixed(2);
  const risk_amount = capital * (risk_pct/100);
  const per_share_risk = Math.max(1e-3, Math.abs(entry-stop));
  const qty = Math.floor(risk_amount / per_share_risk);
  const pos_value = +(qty*entry).toFixed(2);
  const expected_profit_pct = +(((target-entry)/entry)*100).toFixed(2);
  return {last, sma20, sma50, rsi14, macd_now, macd_sig, bb_low, bb_up, atr_val, score, rec, entry, stop, target, qty, pos_value, expected_profit_pct, reasons};
}

function renderTop(top) {
  if(!top.length){ document.getElementById('topArea').innerText='No results'; return; }
  let html = '<table><thead><tr><th>Symbol</th><th>Rec</th><th>Entry</th><th>Target</th><th>Exp %</th></tr></thead><tbody>';
  top.forEach(t=>{
    if(t.error) return;
    html += `<tr onclick='showDetails("${t.symbol}")' style="cursor:pointer"><td>${t.symbol}</td><td>${t.rec}</td><td>₹ ${fmt(t.entry)}</td><td>₹ ${fmt(t.target)}</td><td>${t.expected_profit_pct}%</td></tr>`;
  });
  html += '</tbody></table>';
  document.getElementById('topArea').innerHTML = html;
}

function renderAll(all) {
  if(!all.length){ document.getElementById('allArea').innerText='—'; return; }
  let html = '<table><thead><tr><th>Symbol</th><th>Rec</th><th>Exp %</th></tr></thead><tbody>';
  all.forEach(a=>{
    if(a.error) html += `<tr><td>${a.symbol}</td><td colspan=2 style="color:#f33">${a.error}</td></tr>`;
    else html += `<tr onclick='showDetails("${a.symbol}")'><td>${a.symbol}</td><td>${a.rec}</td><td>${a.expected_profit_pct}%</td></tr>`;
  });
  html += '</tbody></table>';
  document.getElementById('allArea').innerHTML = html;
}

let cachedSeries = {}; let lastResults = [];

async function analyzeUniverse() {
  const symsTxt = document.getElementById('symbols').value.trim();
  let symbols = symsTxt ? symsTxt.split(',').map(s=>s.trim()).filter(Boolean) : DEFAULT_TICKERS.slice();
  const capital = Number(document.getElementById('capital').value) || 100000;
  const risk = Number(document.getElementById('risk').value) || 1;
  const mode = document.getElementById('mode').value;
  document.getElementById('topArea').innerText = 'Working — fetching and analyzing (this may take time)...';
  const results = [];
  // iterate sequentially to avoid too many parallel fetches
  for(let i=0;i<symbols.length;i++){
    const sym = symbols[i];
    const period = mode==='intraday' ? '7d' : '6mo';
    const interval = mode==='intraday' ? '5m' : '1d';
    const series = await fetchOHLCYahoo(sym, period, interval) || [];
    if(!series || series.length<5){ results.push({symbol:sym, error:'no data'}); continue; }
    cachedSeries[sym] = series;
    const analysis = analyzeSeries(series, capital, risk, 12, mode);
    if(!analysis){ results.push({symbol:sym, error:'analysis failed'}); continue; }
    analysis.symbol = sym; analysis.rec = analysis.rec || analysis.recommendation || analysis.rec;
    results.push(analysis);
  }
  // rank by expected_profit_pct desc
  results.sort((a,b)=> (b.expected_profit_pct||0) - (a.expected_profit_pct||0));
  lastResults = results;
  renderTop(results.slice(0,50));
  renderAll(results.slice(0,200));
  document.getElementById('topArea').scrollIntoView({behavior:'smooth'});
}

async function showDetails(symbol){
  const obj = lastResults.find(r=>r.symbol===symbol);
  if(!obj){ alert('No details available'); return; }
  document.getElementById('explain').innerText = `Symbol: ${symbol}\nRecommendation: ${obj.rec}\nEntry: ₹ ${fmt(obj.entry)}\nTarget: ₹ ${fmt(obj.target)}\nStop-loss: ₹ ${fmt(obj.stop)}\nQty: ${obj.qty} (~₹ ${fmt(obj.pos_value)})\nConfidence proxy: ${50 + (obj.score||0)*10}%\n\nReasons:\n- ${obj.reasons.join('\n- ')}`;
  // draw candlestick if series exists
  const s = cachedSeries[symbol];
  if(!s){ alert('No chart data'); return; }
  drawCandle(s);
}

function drawCandle(series){
  // transform to lightweight-charts format
  const data = series.map(p=> ({time: p.t, open: p.o, high: p.h, low: p.l, close: p.c}) );
  const chartContainer = document.getElementById('chart');
  chartContainer.innerHTML = '';
  const chart = LightweightCharts.createChart(chartContainer, {width: chartContainer.clientWidth, height: 350, layout:{background:'#fff',textColor:'#000'}});
  const candleSeries = chart.addCandlestickSeries();
  candleSeries.setData(data);
  // fit
  setTimeout(()=> chart.timeScale().fitContent(), 200);
}

document.getElementById('analyzeBtn').addEventListener('click', analyzeUniverse);
