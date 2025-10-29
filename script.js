/* Trading Terminal client logic
 - Progressive universe scanning (sequential with small delay)
 - Uses Yahoo Finance chart endpoint (no API key)
 - Computes indicators in JS and ranks top picks by expected profit
 - Draws candlestick charts with lightweight-charts
 - Built to run on GitHub Pages (static), no backend required
*/

const DEFAULT_TICKERS = [
  'RELIANCE.NS','TCS.NS','INFY.NS','HDFCBANK.NS','HDFC.NS','ICICIBANK.NS','LT.NS','KOTAKBANK.NS',
  'SBIN.NS','AXISBANK.NS','BAJAJFINSV.NS','BHARTIARTL.NS','ITC.NS','HINDUNILVR.NS','MARUTI.NS','TATAMOTORS.NS',
  'ONGC.NS','POWERGRID.NS','NTPC.NS','BPCL.NS','EICHERMOT.NS','ADANIENT.NS','ASIANPAINT.NS'
];

const PER_FETCH_DELAY = 500; // ms delay between fetches to be polite to API
const MAX_PARALLEL = 3;

let cachedSeries = {}, lastResults = [], chartInstance = null;

function log(msg){ const el = document.getElementById('logs'); el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + el.textContent; }

async function fetchYahoo(symbol, period='6mo', interval='1d'){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${period}&interval=${interval}`;
  try{
    const res = await fetch(url);
    if(!res.ok) throw new Error('HTTP '+res.status);
    const j = await res.json();
    if(!j.chart || !j.chart.result) throw new Error('No data');
    const r = j.chart.result[0];
    const ts = r.timestamp || r.indicators.adjclose?.timestamp || [];
    if(!ts || !r.indicators || !r.indicators.quote) throw new Error('Malformed');
    const o = r.indicators.quote[0].open, h = r.indicators.quote[0].high, l = r.indicators.quote[0].low, c = r.indicators.quote[0].close;
    const out = [];
    for(let i=0;i<ts.length;i++){
      if(o[i]==null||h[i]==null||l[i]==null||c[i]==null) continue;
      const d = new Date(ts[i]*1000);
      out.push({t: d.toISOString().slice(0,10), o:o[i], h:h[i], l:l[i], c:c[i]});
    }
    return out;
  } catch(err){
    console.warn('fetchYahoo fail', symbol, err);
    return null;
  }
}

// --- indicators (array of objects with {t,o,h,l,c}) ---
function closes(series){ return series.map(s=>s.c); }
function sma(series, window){ const c = closes(series); const res=[]; for(let i=0;i<c.length;i++){ const slice=c.slice(Math.max(0,i-window+1), i+1); const avg = slice.reduce((a,b)=>a+b,0)/slice.length; res.push(avg);} return res; }
function rsi(series, period=14){ const c = closes(series); let up=0, down=0; const res=[]; for(let i=0;i<c.length;i++){ if(i==0){ res.push(50); continue;} const d = c[i]-c[i-1]; up = (up*(period-1) + Math.max(0,d))/period; down = (down*(period-1) + Math.max(0,-d))/period; const rs = up/(down||1e-9); res.push(100 - 100/(1+rs)); } return res; }
function emaArr(series, span){ const c=closes(series); const k=2/(span+1); const res=[]; let prev=null; for(let i=0;i<c.length;i++){ if(prev===null){ prev=c[i]; res.push(prev);} else { prev = c[i]*k + prev*(1-k); res.push(prev);} } return res; }
function macd(series){ const fast = emaArr(series,12); const slow = emaArr(series,26); const macdLine = fast.map((v,i)=> v - slow[i]); const signal = (function(){ const k=2/(9+1); let prev=null; const out=[]; for(let i=0;i<macdLine.length;i++){ if(prev==null){ prev = macdLine[i]; out.push(prev);} else { prev = macdLine[i]*k + prev*(1-k); out.push(prev);} } return out; })(); const hist = macdLine.map((v,i)=> v - signal[i]); return {macd:macdLine, signal, hist}; }
function boll(series, window=20, n=2){ const s = sma(series,window); const c=closes(series); const stds=[]; for(let i=0;i<c.length;i++){ const slice=c.slice(Math.max(0,i-window+1), i+1); const mean=s[i]; const variance = slice.reduce((a,b)=>a + Math.pow(b-mean,2),0)/slice.length; stds.push(Math.sqrt(variance)); } const lower = s.map((v,i)=> v - n*stds[i]); const upper = s.map((v,i)=> v + n*stds[i]); return {lower, mid:s, upper}; }

// analysis per symbol
function analyzeSeries(series, capital=100000, risk_pct=1, target_pct=12, mode='swing'){
  if(!series || series.length<15) return {error:'insufficient data'};
  const last = series[series.length-1].c;
  const sma20 = sma(series,20).slice(-1)[0];
  const sma50 = sma(series,50).slice(-1)[0];
  const rsi14 = rsi(series,14).slice(-1)[0];
  const mac = macd(series);
  const mac_now = mac.macd.slice(-1)[0], mac_sig = mac.signal.slice(-1)[0];
  const bb = boll(series,20,2);
  const bb_low = bb.lower.slice(-1)[0], bb_up = bb.upper.slice(-1)[0];
  let score=0, reasons=[];
  if(sma50){ if(last > sma50){ score++; reasons.push('Above 50 SMA'); } else { score--; reasons.push('Below 50 SMA'); } }
  if(rsi14){ if(rsi14<30){ score++; reasons.push('RSI oversold'); } else if(rsi14>70){ score--; reasons.push('RSI overbought'); } else reasons.push(`RSI ${rsi14.toFixed(1)}`); }
  if(mac_now && mac_sig){ if(mac_now > mac_sig){ score++; reasons.push('MACD bullish'); } else { score--; reasons.push('MACD bearish'); } }
  if(bb_low && bb_up){ if(last <= bb_low){ score++; reasons.push('Near lower Bollinger'); } else if(last >= bb_up){ score--; reasons.push('Near upper Bollinger'); } else reasons.push('Within Bollinger'); }
  const rec = score>=2? 'BUY': (score<=-2? 'SELL':'HOLD');
  const entry = rec==='BUY'? +(last*0.995).toFixed(2): last;
  const stop = +(last*0.95).toFixed(2);
  const target = +(last*(1 + target_pct/100)).toFixed(2);
  const risk_amount = capital * (risk_pct/100);
  const per_share_risk = Math.max(1e-3, Math.abs(entry - stop));
  const qty = Math.floor(risk_amount / per_share_risk);
  const pos_value = +(qty * entry).toFixed(2);
  const expected_profit_pct = +(((target-entry)/entry)*100).toFixed(2);
  return {symbol: null, last, score, rec, entry, stop, target, qty, pos_value, expected_profit_pct, reasons};
}

// UI helpers
function el(id){ return document.getElementById(id); }
function setUniverseText(arr){ el('universe').value = arr.join(','); }

// main scan routine (progressive)
async function scanUniverse(symbols, options={capital:100000, risk:1, mode:'swing', topN:30}){
  log(`Starting scan of ${symbols.length} symbols (mode=${options.mode})`);
  const results = [];
  for(let i=0;i<symbols.length;i++){
    const sym = symbols[i];
    el('logs').textContent = `Scanning ${sym} (${i+1}/${symbols.length})\\n` + el('logs').textContent;
    const period = options.mode==='intraday'? '7d' : '6mo';
    const interval = options.mode==='intraday'? '5m' : '1d';
    const series = await fetchYahoo(sym, period, interval);
    await new Promise(r=>setTimeout(r, PER_FETCH_DELAY));
    if(!series || series.length<5){ results.push({symbol:sym, error:'no data'}); continue; }
    cachedSeries[sym] = series;
    const analysis = analyzeSeries(series, options.capital, options.risk, 12, options.mode);
    analysis.symbol = sym;
    results.push(analysis);
    // keep leaderboard updated progressively
    results.sort((a,b)=> (b.expected_profit_pct||0) - (a.expected_profit_pct||0));
    renderLeaderboard(results.slice(0, options.topN || 30));
  }
  lastResults = results;
  renderLeaderboard(results.slice(0, options.topN || 30));
  renderAll(results.slice(0,200));
  log('Scan complete');
  return results;
}

function renderLeaderboard(top){
  if(!top || !top.length){ el('leaderboard').innerText = 'No top picks'; return; }
  let html = '<table><thead><tr><th>Sym</th><th>Rec</th><th>Entry</th><th>Target</th><th>Exp%</th></tr></thead><tbody>';
  top.forEach(t=>{
    if(t.error) return;
    html += `<tr onclick="showDetails('${t.symbol}')" style="cursor:pointer"><td>${t.symbol}</td><td>${t.rec}</td><td>₹ ${t.entry.toLocaleString()}</td><td>₹ ${t.target.toLocaleString()}</td><td>${t.expected_profit_pct}%</td></tr>`;
  });
  html += '</tbody></table>';
  el('leaderboard').innerHTML = html;
}

function renderAll(all){
  if(!all || !all.length){ el('allArea').innerText = '—'; return; }
  let html = '<table><thead><tr><th>Sym</th><th>Rec</th><th>Exp%</th></tr></thead><tbody>';
  all.forEach(a=>{
    if(a.error) html += `<tr><td>${a.symbol}</td><td colspan=2 style="color:#f33">${a.error}</td></tr>`;
    else html += `<tr onclick="showDetails('${a.symbol}')"><td>${a.symbol}</td><td>${a.rec}</td><td>${a.expected_profit_pct}%</td></tr>`;
  });
  html += '</tbody></table>';
  el('allArea').innerHTML = html;
}

async function showDetails(symbol){
  const obj = lastResults.find(r=>r.symbol===symbol);
  if(!obj){ alert('No data'); return; }
  el('explain').textContent = `Symbol: ${symbol}\\nRecommendation: ${obj.rec}\\nEntry: ₹ ${obj.entry}\\nTarget: ₹ ${obj.target}\\nStop-loss: ₹ ${obj.stop}\\nQty: ${obj.qty} (~₹ ${obj.pos_value})\\nReasons:\\n- ${obj.reasons.join('\\n- ')}`;
  // draw candlestick
  const series = cachedSeries[symbol];
  if(!series){ alert('No chart data'); return; }
  drawChart(series, symbol);
}

function drawChart(series, title){
  const container = el('chart');
  container.innerHTML = '';
  const chart = LightweightCharts.createChart(container, {width: container.clientWidth, height:420, layout:{background: document.body.classList.contains('light')? '#fff':'#021627', textColor: document.body.classList.contains('light')? '#000':'#fff'}});
  const candle = chart.addCandlestickSeries();
  const data = series.map(p=>({time: p.t, open: p.o, high: p.h, low: p.l, close: p.c}));
  candle.setData(data);
  chart.timeScale().fitContent();
  // store instance so resize works
  chartInstance = chart;
  el('chartTitle').textContent = title;
  el('chartSubtitle').textContent = `Last: ₹ ${series[series.length-1].c.toLocaleString()}`;
}

// utilities
function log(m){ const l = el('logs'); l.textContent = `${new Date().toLocaleTimeString()} - ${m}\\n` + l.textContent; }

// initialize UI
document.getElementById('analyzeBtn').addEventListener('click', ()=> {
  const u = el('universe').value.trim();
  const symbols = u? u.split(',').map(s=>s.trim()).filter(Boolean) : DEFAULT_TICKERS.slice();
  const options = {capital: Number(el('capital').value)||100000, risk: Number(el('risk').value)||1, mode: el('mode').value, topN: Number(el('topN').value)||30};
  scanUniverse(symbols, options);
});
document.getElementById('scanBtn').addEventListener('click', ()=> document.getElementById('analyzeBtn').click());
document.getElementById('addBtn').addEventListener('click', ()=>{
  const s = document.getElementById('search').value.trim();
  if(!s) return alert('Enter symbol');
  const cur = el('universe').value ? el('universe').value.split(',').map(x=>x.trim()) : [];
  if(!cur.includes(s)) cur.unshift(s);
  el('universe').value = cur.join(',');
});
document.getElementById('darkToggle').addEventListener('change', (e)=>{
  if(e.target.checked){ document.documentElement.classList.remove('light'); document.body.classList.remove('light'); document.documentElement.style.setProperty('--bg','#0f1724'); } else { document.documentElement.classList.add('light'); }
});
window.addEventListener('resize', ()=> { if(chartInstance) chartInstance.resize(el('chart').clientWidth, 420); });

/* quick demo helper: auto-fill universe with defaults */
if(!el('universe').value) setTimeout(()=> setUniverseText(DEFAULT_TICKERS), 400);
