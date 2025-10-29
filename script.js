/* AI Stock Guru Pro+ Live (client-side only)
 - Fetches Yahoo Finance chart data via AllOrigins proxy to avoid CORS
 - Computes indicators, ranks top picks, shows charts using Lightweight Charts
 - Live auto-refresh cycles for intraday/short/alerts
 - Voice assistant uses SpeechSynthesis API to read top alerts
 - Meant for GitHub Pages static hosting
*/

const ALLORIGINS = 'https://api.allorigins.win/raw?url='; // proxy prefix
const DEFAULT_UNIVERSE = ['RELIANCE.NS','TCS.NS','INFY.NS','HDFCBANK.NS','HDFC.NS','ICICIBANK.NS','LT.NS','KOTAKBANK.NS','SBIN.NS','AXISBANK.NS','BAJAJFINSV.NS','BHARTIARTL.NS'];
const INTRADAY_REFRESH = 60 * 1000; // 60s
const SHORT_REFRESH = 3 * 60 * 1000; // 3min
const ALERTS_REFRESH = 30 * 1000; // 30s
let cachedSeries = {}, latestAlerts = [];

// helper DOM
const el = id => document.getElementById(id);
function setStatus(s){ el('status').innerText = 'Status: ' + s; console.log(s); }
function fmt(n){ return Number(n).toLocaleString('en-IN', {maximumFractionDigits:2}); }

// Fetch OHLC from Yahoo via proxy
async function fetchYahoo(symbol, range='1mo', interval='1d'){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  try{
    const r = await fetch(ALLORIGINS + encodeURIComponent(url));
    if(!r.ok) throw new Error('proxy fail ' + r.status);
    const j = await r.json();
    const res = j.chart && j.chart.result && j.chart.result[0];
    if(!res || !res.timestamp) return null;
    const ts = res.timestamp;
    const q = res.indicators && res.indicators.quote && res.indicators.quote[0];
    if(!q) return null;
    const o=q.open, h=q.high, l=q.low, c=q.close;
    const out = [];
    for(let i=0;i<ts.length;i++){
      if(o[i]==null||h[i]==null||l[i]==null||c[i]==null) continue;
      const d = new Date(ts[i]*1000);
      out.push({time: d.toISOString().slice(0,10), open:o[i], high:h[i], low:l[i], close:c[i]});
    }
    return out;
  }catch(err){
    console.warn('fetchYahoo', symbol, err);
    return null;
  }
}

// indicators
function closes(s){ return s.map(x=>x.close); }
function sma(s, w){ const c=closes(s); const res=[]; for(let i=0;i<c.length;i++){ const slice=c.slice(Math.max(0,i-w+1), i+1); res.push(slice.reduce((a,b)=>a+b,0)/slice.length); } return res; }
function emaArr(s, span){ const c=closes(s); const k=2/(span+1); const out=[]; let prev=null; for(let i=0;i<c.length;i++){ if(prev==null){ prev=c[i]; out.push(prev);} else { prev = c[i]*k + prev*(1-k); out.push(prev); } } return out; }
function rsi(s, p=14){ const c=closes(s); let up=0,down=0; const out=[]; for(let i=0;i<c.length;i++){ if(i==0){ out.push(50); continue;} const d=c[i]-c[i-1]; up=(up*(p-1)+Math.max(0,d))/p; down=(down*(p-1)+Math.max(0,-d))/p; const rs=up/(down||1e-9); out.push(100 - 100/(1+rs)); } return out; }
function macdLines(s){ const fast=emaArr(s,12), slow=emaArr(s,26); const macd = fast.map((v,i)=> v - slow[i]); const signal = (function(){ const k=2/(9+1); let prev=null; const out=[]; for(let i=0;i<macd.length;i++){ if(prev==null){ prev=macd[i]; out.push(prev);} else { prev = macd[i]*k + prev*(1-k); out.push(prev);} } return out; })(); return {macd, signal, hist: macd.map((v,i)=> v - signal[i])}; }
function boll(s, w=20, n=2){ const m=sma(s,w); const c=closes(s); const stds=[]; for(let i=0;i<c.length;i++){ const slice=c.slice(Math.max(0,i-w+1), i+1); const mean=m[i]; const variance = slice.reduce((a,b)=>a+Math.pow(b-mean,2),0)/slice.length; stds.push(Math.sqrt(variance)); } return {lower: m.map((v,i)=> v - n*stds[i]), mid:m, upper: m.map((v,i)=> v + n*stds[i])}; }

// analyze series
function analyzeSeries(series, capital=100000, risk_pct=1, target_pct=12){
  if(!series || series.length<15) return null;
  const last = series[series.length-1].close;
  const sma20 = sma(series,20).slice(-1)[0]; const sma50 = sma(series,50).slice(-1)[0];
  const r = rsi(series,14).slice(-1)[0]; const mac = macdLines(series); const macd_now = mac.macd.slice(-1)[0], mac_sig = mac.signal.slice(-1)[0];
  const bb = boll(series,20,2); const bb_low = bb.lower.slice(-1)[0], bb_up = bb.upper.slice(-1)[0];
  let score=0; const reasons=[];
  if(sma50){ if(last > sma50){ score++; reasons.push('Above 50 SMA'); } else { score--; reasons.push('Below 50 SMA'); } }
  if(r){ if(r<30){ score++; reasons.push('RSI oversold'); } else if(r>70){ score--; reasons.push('RSI overbought'); } else reasons.push('RSI neutral'); }
  if(macd_now && mac_sig){ if(macd_now > mac_sig){ score++; reasons.push('MACD bullish'); } else { score--; reasons.push('MACD bearish'); } }
  if(bb_low && bb_up){ if(last <= bb_low){ score++; reasons.push('Near lower Bollinger'); } else if(last >= bb_up){ score--; reasons.push('Near upper Bollinger'); } else reasons.push('Within Bollinger'); }
  const rec = score>=2? 'BUY' : (score<=-2? 'SELL':'HOLD');
  const entry = rec==='BUY'? +(last*0.995).toFixed(2) : last; const stop = +(last*0.95).toFixed(2); const target = +(last*(1+target_pct/100)).toFixed(2);
  const risk_amount = capital * (risk_pct/100); const per_share_risk = Math.max(1e-3, Math.abs(entry - stop)); const qty = Math.floor(risk_amount / per_share_risk); const pos_value = +(qty*entry).toFixed(2);
  const expected_profit_pct = +(((target-entry)/entry)*100).toFixed(2);
  return {last, rec, entry, stop, target, qty, pos_value, expected_profit_pct, score, reasons, sma20, sma50, r};
}

// ranking and UI rendering
function renderList(containerId, arr){
  const elc = el(containerId);
  if(!arr || !arr.length){ elc.innerHTML = '<div class="muted">No picks</div>'; return; }
  let html = '<table><thead><tr><th>Symbol</th><th>Rec</th><th>Entry</th><th>Target</th><th>Exp%</th></tr></thead><tbody>';
  arr.forEach(a=>{ html += `<tr onclick="plotSymbol('${a.symbol}')" style="cursor:pointer"><td>${a.symbol}</td><td>${a.rec}</td><td>₹ ${fmt(a.entry)}</td><td>₹ ${fmt(a.target)}</td><td>${a.expected_profit_pct}%</td></tr>`; });
  html += '</tbody></table>'; elc.innerHTML = html;
}

// core scan (progressive, limited to avoid throttling)
async function scanUniverse(symbols, mode='intraday'){
  setStatus('Scanning ' + symbols.length + ' symbols (' + mode + ')');
  const results = [];
  for(let i=0;i<symbols.length;i++){
    const sym = symbols[i];
    try{
      const range = mode==='intraday' ? '7d' : '6mo';
      const interval = mode==='intraday' ? '5m' : '1d';
      const series = await fetchYahoo(sym, range, interval);
      await new Promise(r=>setTimeout(r, 350)); // polite delay
      if(!series || series.length<10){ results.push({symbol:sym, error:'no data'}); continue; }
      cachedSeries[sym] = series;
      const analysis = analyzeSeries(series, 100000, 1, 12);
      if(analysis){ analysis.symbol = sym; results.push(analysis); }
    }catch(err){ results.push({symbol:sym, error:err.message}); }
  }
  results.sort((a,b)=> (b.expected_profit_pct||0) - (a.expected_profit_pct||0));
  return results;
}

// top-level orchestration & intervals
let intradayTimer = null, shortTimer = null, alertsTimer = null;

async function runIntraday(){
  const universe = DEFAULT_UNIVERSE.slice();
  const results = await scanUniverse(universe, 'intraday');
  const top = results.slice(0,10);
  top.forEach(x=>x.symbol && (x.symbol = x.symbol));
  renderList('intradayList', top);
  latestAlerts = generateAlerts(results);
  renderAlerts(latestAlerts);
  if(intradayTimer) clearTimeout(intradayTimer);
  intradayTimer = setTimeout(runIntraday, INTRADAY_REFRESH);
}

async function runShort(){
  const universe = DEFAULT_UNIVERSE.slice();
  const results = await scanUniverse(universe, 'short');
  const top = results.slice(0,10);
  renderList('shortList', top);
  if(shortTimer) clearTimeout(shortTimer);
  shortTimer = setTimeout(runShort, SHORT_REFRESH);
}

// alerts generation (simple)
function generateAlerts(results){
  const alerts = [];
  for(const r of results.slice(0,50)){
    if(r.error) continue;
    if(r.score >= 2) alerts.push({symbol:r.symbol, type:'Bullish', text:`${r.symbol} strong buy (exp ${r.expected_profit_pct}%)`});
    if(r.score <= -2) alerts.push({symbol:r.symbol, type:'Bearish', text:`${r.symbol} sell signal`});
    if(alerts.length>=12) break;
  }
  return alerts;
}

function renderAlerts(alerts){
  const elA = el('alertsList');
  if(!alerts || !alerts.length){ elA.innerHTML = '<div class="muted">No alerts</div>'; return; }
  let html = '<ul>';
  alerts.forEach(a=> html += `<li onclick="plotSymbol('${a.symbol}')"><strong>${a.type}</strong> ${a.text}</li>`);
  html += '</ul>';
  elA.innerHTML = html;
}

// voice assistant
function speakAlerts(){
  if(!latestAlerts || !latestAlerts.length) return;
  const top = latestAlerts.slice(0,3).map(a=> `${a.type} alert for ${a.symbol}: ${a.text}`).join('. ');
  const utter = new SpeechSynthesisUtterance(top);
  utter.rate = 1; utter.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

// chart plotting
let chartInstance = null;
function plotSymbol(sym){
  setStatus('Plotting ' + sym);
  const series = cachedSeries[sym] || cachedSeries[sym + '.NS'];
  if(!series){ el('analysis').innerText = 'No series data for ' + sym; return; }
  const container = el('chart');
  container.innerHTML = '';
  chartInstance = LightweightCharts.createChart(container, {width: container.clientWidth, height:420, layout:{background:'#ffffff', textColor:'#000000'}});
  const cs = chartInstance.addCandlestickSeries();
  const data = series.map(p=> ({time: p.time || p.time || p.t, open: p.open || p.o, high: p.high || p.h, low: p.low || p.l, close: p.close || p.c}));
  cs.setData(data);
  chartInstance.timeScale().fitContent();
  const analysis = analyzeSeries(series);
  if(analysis){
    el('analysis').innerHTML = `<pre>Symbol: ${sym}\nRec: ${analysis.rec}\nEntry: ₹ ${fmt(analysis.entry)}  Target: ₹ ${fmt(analysis.target)}  Stop: ₹ ${fmt(analysis.stop)}\nQty: ${analysis.qty}\nReasons:\n- ${analysis.reasons.join('\n- ')}</pre>`;
  } else {
    el('analysis').innerText = 'Analysis unavailable';
  }
  setStatus('Chart ready');
}

// UI wiring
document.addEventListener('DOMContentLoaded', function(){
  el('goBtn').addEventListener('click', ()=>{
    const tab = el('tabSelect').value;
    if(tab === 'intraday'){ runIntraday(); }
    else if(tab === 'short'){ runShort(); }
    else { runIntraday(); runShort(); }
    setStatus('Scan started');
  });
  el('voiceBtn').addEventListener('click', ()=> speakAlerts());
  el('plotSymbol').addEventListener('click', ()=>{
    const s = el('symbolInput').value.trim();
    if(!s) return alert('Enter symbol');
    plotSymbol(s);
  });
  el('addSymbol').addEventListener('click', ()=>{
    const s = el('symbolInput').value.trim();
    if(!s) return alert('Enter symbol');
    DEFAULT_UNIVERSE.unshift(s);
    el('status').innerText = 'Added ' + s;
  });
  // auto-run
  runIntraday();
  runShort();
  alertsTimer = setInterval(()=> { latestAlerts = latestAlerts.length ? latestAlerts : []; renderAlerts(latestAlerts); }, ALERTS_REFRESH);
});
