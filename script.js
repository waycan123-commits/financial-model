/* BOOT GUARD: prevents the app from breaking if script.js is loaded in <head> or loaded twice */
(function () {
  var hasDom = !!(document.getElementById('portfolio-screen') && document.getElementById('port-new-btn') && document.getElementById('main-nav'));
  var selfSrc = (document.currentScript && document.currentScript.src) || './script.js';

  if (!hasDom) {
    if (!window.__financialModelBootRetryScheduled) {
      window.__financialModelBootRetryScheduled = true;
      document.addEventListener('DOMContentLoaded', function () {
        if (window.__financialModelBooted) return;
        var s = document.createElement('script');
        s.src = selfSrc + (selfSrc.indexOf('?') >= 0 ? '&' : '?') + 'bootretry=' + Date.now();
        document.body.appendChild(s);
      });
    }
    throw new Error('[Financial Model] script.js was loaded before the HTML existed. Boot postponed until DOM is ready.');
  }

  if (window.__financialModelBooted) {
    throw new Error('[Financial Model] duplicate script.js load ignored.');
  }
  window.__financialModelBooted = true;
})();

const SUPABASE_URL = "https://qzqkqxpwkbvxuddlvmku.supabase.co";
// Publishable key (new Supabase format) — works with supabase-js v2.39+
const SUPABASE_KEY = "sb_publishable_ws_tIYvwKm-CngRozIb99A_N3TJuVzD";

let supabaseClient = null;
let _sbReady = false, _sbError = '';
try {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  _sbReady = true;
} catch(e) { _sbError = e.message; console.error('[Supabase] init failed:', e); }

// localStorage fallback keys
const LS_PORTFOLIO = 'fm_portfolio_v2';
function _lsGet()  { try { return JSON.parse(localStorage.getItem(LS_PORTFOLIO)||'[]'); } catch(e){ return []; } }
function _lsSet(a) { try { localStorage.setItem(LS_PORTFOLIO, JSON.stringify(a)); } catch(e){} }
function _lsId()   { return 'local_'+Date.now()+'_'+Math.random().toString(36).slice(2,7); }

function _sbToast(msg, color) {
  let t = document.getElementById('_sb_toast');
  if (!t) { t = document.createElement('div'); t.id = '_sb_toast';
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:8px;font-size:12px;z-index:9999;max-width:460px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.3);transition:opacity .4s;pointer-events:none';
    document.body.appendChild(t); }
  t.style.background = (color||'#BA0517'); t.style.color = '#fff';
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(t._t); t._t = setTimeout(()=>{ t.style.opacity='0'; }, 5000);
}


/* =====================================================================
 FINANCIAL MODEL  -  clean rewrite
 ===================================================================== */
'use strict';

//  CONSTANTS 
const MES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const MEN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const IGV = 0.18;
const COST_CATS = ['Equipment','Payroll','Services','Overhead'];

//  STATE 
let CFG = { fx:3.75, pen:5, con:5, dis:12, months:12, sm:1, sy:2025, fcb:0, fcbCost:0, fub:0, hedg:0, opxbuf:30, finRate:0 };
let revenues = []; // [{id,name,amount,cur,igv,cat,mos}]
let capex = []; // [{id,name,amount,cur,igv,cat,adv,advMo,payCond,mos}]
let opex = []; // same as capex
let adjustments = []; // [{id,name,pct,sign,affectsRevenue,affectsCost,targets:[{type,refId,label}]}]
let customLines = []; // [{id,name,formula,section,sign,color,showInCF}]
// Row ordering  -  each entry: {id, label, type, section, visible}
// 'type': 'builtin' | 'custom' | 'adj'
// Stored per-project. Default order = declaration order in renderPL/CF.
let plRowOrder = []; // ordered list of row IDs for P&L
let cfRowOrder = []; // ordered list of row IDs for CF
let chartView = 'monthly', plView = 'grouped', cfView = 'grouped';
let plYearOpen = {}, cfYearOpen = {}; // which years are expanded in grouped view
let _uid = 1;
const uid = () => _uid++;

//  HELPERS 
const PM = () => CFG.months;
const AMs = () => Array.from({length: PM()}, (_, i) => i + 1);

function mInfo(m) {
 const t = (CFG.sm - 1) + (m - 1);
 const yr = CFG.sy + Math.floor(t / 12);
 const mo = t % 12;
 const label = MEN[mo] + ' ' + String(yr).slice(2);
 return { label, short: MEN[mo], year: yr, mo };
}

function _toNumber(v) {
 if (typeof v === 'number') return isFinite(v) ? v : 0;
 const raw = String(v == null ? '' : v).trim();
 if (!raw) return 0;
 let clean = raw.replace(/[^0-9,.-]/g, '');
 if (clean.includes(',') && clean.includes('.')) {
  // If the last separator is comma, assume decimal comma; otherwise comma is thousands.
  clean = clean.lastIndexOf(',') > clean.lastIndexOf('.')
   ? clean.replace(/\./g, '').replace(',', '.')
   : clean.replace(/,/g, '');
 } else if (clean.includes(',')) {
  const parts = clean.split(',');
  clean = (parts.length === 2 && parts[1].length <= 2)
   ? parts[0].replace(/\./g, '') + '.' + parts[1]
   : clean.replace(/,/g, '');
 }
 const n = parseFloat(clean);
 return isFinite(n) ? n : 0;
}
function _cashIgvMultiplier(item) { return item && item.igv ? (1 + IGV) : 1; }
function _yes(v) {
 const s = String(v == null ? '' : v).trim().toLowerCase();
 return ['yes','y','si','sí','true','1','x','afecto','aplica'].includes(s);
}
function getBase(item) {
 // Amounts are entered/imported WITHOUT IGV, in their original currency.
 // P&L and CF calculations convert to USD using CFG.fx. IGV is never deducted from P&L.
 const a = _toNumber(item.amount);
 return item.cur === 'PEN' ? a / CFG.fx : a;
}

function getDistArr(item) {
 const pm = PM();
 const arr = new Array(pm).fill(0);

 //  Progressive payment mode 
 // Phase 1: monthly_fixed × % advance per month (set in grid)
 // Phase 2: auto-detected  -  once any month hits 100%, all remaining months = monthly_fixed × 100%
 // The "100% hit" month is also paid at 100% (not just from the next month).
 if (item.progMode && item.progMonthly) {
 const monthly = parseFloat(item.progMonthly) || 0;
 if (monthly > 0) {
 let fullStarted = false; // set to true once we see a 100% month
 AMs().forEach(m => {
 if (fullStarted) {
 arr[m - 1] = monthly; // Phase 2: full payment
 } else {
 const pct = evalPct((item.mos || {})[m]) || 0;
 arr[m - 1] = monthly * (pct / 100);
 if (pct >= 99.99) fullStarted = true; // 100% reached  activate Phase 2
 }
 });
 return arr;
 }
 }

 //  Standard mode 
 const base = getBase(item) * (item.negative ? -1 : 1);
 const advP = parseFloat(item.adv) || 0;
 const advM = parseInt(item.advMo) || 1;
 const advAmt = base * (advP / 100);
 const rest = base - advAmt;

 if (advAmt > 0 && advM >= 1 && advM <= pm) arr[advM - 1] += advAmt;
 const allRefItems = [...(typeof revenues!=='undefined'?revenues:[]),...(typeof capex!=='undefined'?capex:[]),...(typeof opex!=='undefined'?opex:[])];
 AMs().forEach(m => {
 const raw = (item.mos || {})[m];
 const ref = evalCellRef(raw, m - 1, allRefItems);
 if (ref.absolute !== null) {
 arr[m - 1] += ref.absolute;
 } else {
 arr[m - 1] += rest * (ref.pct / 100);
 }
 });
 return arr;
}

// Revenue cash-flow: uses collectionMap to determine when each accrual month's revenue is collected.
// collectionMap = { payMonth: [accrualMonth, ...], delay_payMonth: days }
// P&L (accrual) = getDistArr (unchanged). CF = getCFRevArr.
function getCFRevArr(item) {
 const pm = PM();
 const accrual = getDistArr(item); // index 0 = month 1
 const cmap = item.collectionMap || {};

 // Only numeric keys that are valid month numbers
 const payKeys = Object.keys(cmap)
 .filter(k => !k.startsWith('delay_') && /^\d+$/.test(k))
 .map(Number)
 .filter(m => m >= 1 && m <= pm);

 const igvMult = _cashIgvMultiplier(item);

 // If no collection schedule defined, revenue CF = accrual timing; if IGV applies, cash collection includes IGV.
 if (!payKeys.length) return accrual.map(v => v * igvMult);

 const arr = new Array(pm).fill(0);
 const mapped = new Set();

 payKeys.forEach(payMo => {
 const raw = cmap[payMo];
 const accrualMos = Array.isArray(raw) ? raw.map(Number).filter(n => !isNaN(n)) : [];
 const delayDays = parseFloat(cmap['delay_' + payMo]) || 0;
 const delayMos = Math.round(delayDays / 30);
 const cashMo = Math.min(payMo - 1 + delayMos, pm - 1); // 0-indexed

 accrualMos.forEach(am => {
 if (am >= 1 && am <= pm) {
 arr[cashMo] += accrual[am - 1] * igvMult;
 mapped.add(am);
 }
 });
 });

 // Accrual months not assigned to any payment  collect on own accrual month
 accrual.forEach((v, i) => {
 if (!mapped.has(i + 1)) arr[i] += v * igvMult;
 });

 return arr;
}

// Cash-flow distribution: shifts each month by payment condition days.

// 30 days = +1 month, 60 = +2, etc. Overflow stays in last month.
function getCFDistArr(item) {
 const pm = PM();
 const accrual = getDistArr(item);
 const igvMult = _cashIgvMultiplier(item);
 const cmap = item.collectionMap || {};

 // If collectionMap defined (same structure as revenues)  -  use it
 const payKeys = Object.keys(cmap)
 .filter(k => !k.startsWith('delay_') && /^\d+$/.test(k))
 .map(Number)
 .filter(m => m >= 1 && m <= pm);

 if (payKeys.length) {
 // Use collection schedule  -  same logic as getCFRevArr
 const arr = new Array(pm).fill(0);
 let unallocated = 0;
 const allocatedAccrual = new Set();
 payKeys.forEach(payMo => {
 const accrualMos = Array.isArray(cmap[payMo]) ? cmap[payMo] : [];
 const delay = Math.round((parseFloat(cmap['delay_' + payMo]) || 0) / 30);
 let paySum = 0;
 accrualMos.forEach(am => { if (am >= 1 && am <= pm) { paySum += accrual[am-1] || 0; allocatedAccrual.add(am); } });
 const target = Math.min(payMo - 1 + delay, pm - 1);
 arr[target] += paySum * igvMult;
 });
 // Unallocated months fall back to payCond shift
 const shift = Math.round((parseFloat(item.payCond) || 0) / 30);
 AMs().forEach(m => {
 if (!allocatedAccrual.has(m)) {
 const target = Math.min(m - 1 + shift, pm - 1);
 arr[target] += (accrual[m-1] || 0) * igvMult;
 }
 });
 return arr;
 }

 // No collection schedule  -  fall back to payment terms shift
 const days = parseFloat(item.payCond) || 0;
 if (days <= 0) return accrual.map(v => v * igvMult);
 const shift = Math.round(days / 30);
 const arr = new Array(pm).fill(0);
 accrual.forEach((v, i) => { arr[Math.min(i + shift, pm-1)] += v * igvMult; });
 return arr;
}

function Z() { return new Array(PM()).fill(0); }
function rSum(a) { return a.reduce((s, v) => s + v, 0); }
function addArr(a, b) { return a.map((v, i) => v + b[i]); }

function fmt(v, blankZero) {
 const n = Number(v);
 if (v === undefined || v === null || !isFinite(n) || isNaN(n)) return '0.00';
 if (Math.abs(n) < 0.005) return '0.00';
 const s = Math.abs(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
 return n < 0 ? '(' + s + ')' : s;
}
function fmtK(v) {
 if (!v && v !== 0) return '0';
 const neg = v < 0, abs = Math.abs(v);
 const s = abs >= 1e6 ? (abs/1e6).toFixed(2)+'M' : abs >= 1e3 ? (abs/1e3).toFixed(2)+'K' : abs.toFixed(2);
 return (neg ? '(' : '') + s + (neg ? ')' : '');
}
function esc(s) {
 return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Evaluate a % expression: supports decimals and simple math like "100/3", "50.5", "33.33"
function evalPct(raw) {
 if (raw === '' || raw === null || raw === undefined) return 0;
 const s = String(raw).trim();
 if (s === '') return 0;
 // Only allow numbers, spaces, +, -, *, /, (, ), .
 if (!/^[0-9+\-*/.() ]+$/.test(s)) return parseFloat(s) || 0;
 try { const v = Function('"use strict"; return (' + s + ')')(); return isFinite(v) ? v : 0; }
 catch(e) { return parseFloat(s) || 0; }
}

// Resolve a monthly cell that may reference another item by name
// Syntax: "50% of Internet"  absolute = 50% of that item's amount for this month
// Syntax: "Internet * 0.5"  absolute = 50% of Internet this month
// Plain: "25"  pct = 25%
//  CUSTOM LINE FORMULA EVALUATOR 
// Evaluates a formula string against named compute values
// Supported refs: revenue item names, cost item names, revCat names, costCat names,
// and special vars: totalIncome, totalCogs, grossProfit, ebit, opexBuffer, hedging,
// penArr, finCostArr, profitBeforeOpex, accumCF
function evalCustomFormula(formula, cv, monthIdx) {
 if (!formula || !formula.trim()) return 0;
 const m = monthIdx; // 0-indexed
 let expr = formula.trim();

 // Build variable map  -  name  monthly value at index m
 const vars = {};

 // Special compute vars
 vars['totalIncome'] = cv.totalIncome[m] || 0;
 vars['totalCogs'] = cv.totalCogsAdj[m] || 0;
 vars['grossProfit'] = cv.grossProfit[m] || 0;
 vars['ebit'] = cv.ebit[m] || 0;
 vars['ebitda'] = cv.ebitda[m] || 0;
 vars['opexBuffer'] = cv.opexBuffer[m] || 0;
 vars['hedging'] = cv.hedgingArr[m] || 0;
 vars['penArr'] = cv.penArr[m] || 0;
 vars['finCostArr'] = cv.finCostArr[m] || 0;
 vars['profitBeforeOpex'] = cv.profitBeforeOpex[m] || 0;
 vars['accumCF'] = cv.accumCF[m] || 0;
 vars['totalIncomeCF'] = cv.totalIncomeCF[m] || 0;

 // Revenue categories
 Object.entries(cv.revCats || {}).forEach(([cat, arr]) => {
 vars[cat.replace(/\s+/g,'_')] = arr[m] || 0;
 vars[cat] = arr[m] || 0;
 });

 // Cost categories
 Object.entries(cv.costCat || {}).forEach(([cat, arr]) => {
 vars[cat.replace(/\s+/g,'_')] = arr[m] || 0;
 vars[cat] = arr[m] || 0;
 });

 // Individual revenue items
 (typeof revenues !== 'undefined' ? revenues : []).forEach(it => {
 if (it.name) {
 const v = getDistArr(it)[m] || 0;
 vars[it.name.replace(/\s+/g,'_')] = v;
 vars[it.name] = v;
 }
 });

 // Individual cost items
 [...(typeof capex!=='undefined'?capex:[]), ...(typeof opex!=='undefined'?opex:[])].forEach(it => {
 if (it.name) {
 const v = getDistArr(it)[m] || 0;
 vars[it.name.replace(/\s+/g,'_')] = v;
 vars[it.name] = v;
 }
 });

 // Replace named refs in expr with their numeric values
 // Sort by length desc to avoid partial replacements
 const names = Object.keys(vars).sort((a,b) => b.length - a.length);
 names.forEach(name => {
 const escaped = name.replace(/[.*+?^${}()|[\\]]/g, '\\$&');
 expr = expr.replace(new RegExp('(?<![a-zA-Z0-9_])' + escaped + '(?![a-zA-Z0-9_])', 'g'), String(vars[name]));
 });

 // Evaluate the resulting numeric expression
 try {
 const result = Function('"use strict"; return (' + expr + ')')();
 return isFinite(result) ? result : 0;
 } catch(e) {
 return 0;
 }
}

// Evaluate a custom line formula across all months  returns array
function evalCustomLineArr(line, cv) {
 return AMs().map((_, i) => {
 const raw = evalCustomFormula(line.formula, cv, i);
 return line.sign === 'subtract' ? -Math.abs(raw) : Math.abs(raw);
 });
}

function evalCellRef(raw, monthIdx, refItems) {
 if (!raw) return { pct: 0, absolute: null };
 const s = String(raw).trim();
 if (!s) return { pct: 0, absolute: null };

 // Pattern: "<number>% of <name>" or "<name> * <factor>"
 const m1 = s.match(/^([\d.]+)%\s+of\s+(.+)$/i);
 if (m1) {
 const factor = parseFloat(m1[1]) / 100;
 const name = m1[2].trim();
 const found = refItems.find(it => it.name && it.name.toLowerCase() === name.toLowerCase());
 if (found) return { pct: 0, absolute: getDistArr(found)[monthIdx] * factor };
 }

 const m2 = s.match(/^(.+?)\s*[*x]\s*([\d.]+)$/i);
 if (m2) {
 const name = m2[1].trim();
 const factor = parseFloat(m2[2]);
 const found = refItems.find(it => it.name && it.name.toLowerCase() === name.toLowerCase());
 if (found) return { pct: 0, absolute: getDistArr(found)[monthIdx] * factor };
 }

 // Pattern: "<name> * <factor> + <name2> * <factor2>"
 const m3 = s.match(/^(.+?)\s*[*x]\s*([\d.]+)\s*\+\s*(.+?)\s*[*x]\s*([\d.]+)$/i);
 if (m3) {
 const n1=m3[1].trim(), f1=parseFloat(m3[2]);
 const n2=m3[3].trim(), f2=parseFloat(m3[4]);
 const i1 = refItems.find(it=>it.name&&it.name.toLowerCase()===n1.toLowerCase());
 const i2 = refItems.find(it=>it.name&&it.name.toLowerCase()===n2.toLowerCase());
 if (i1 || i2) {
 const v1 = i1 ? getDistArr(i1)[monthIdx] * f1 : 0;
 const v2 = i2 ? getDistArr(i2)[monthIdx] * f2 : 0;
 return { pct: 0, absolute: v1 + v2 };
 }
 }

 return { pct: evalPct(s), absolute: null };
}

function itemPctTotal(item) {
 if (item.progMode && item.progMonthly) {
 // Progressive mode: only sum Phase 1 months (up to and including the 100% month)
 // Phase 2 months are auto-filled  -  don't count them in the allocation indicator
 let total = 0;
 for (const m of AMs()) {
 const pct = evalPct((item.mos || {})[m]) || 0;
 total += pct;
 if (pct >= 99.99) break; // stop at the 100% trigger month
 }
 return total;
 }
 return AMs().reduce((s, m) => s + (evalPct((item.mos || {})[m]) || 0), 0);
}

//  FORMULA OVERRIDE EVALUATOR 
// Evaluates a user-edited formula for all months, returns array[PM]
// ctx = object with all variables available (merged per-month values)
function evalFormulaOverride(exprRaw, makeCtx) {
 const expr = exprRaw.trim().replace(/^=/, '');
 return AMs().map((month, mi) => {
 try {
 const ctx = makeCtx(month, mi);
 // Replace variable names with values
 let e = expr;
 Object.keys(ctx).sort((a,b)=>b.length-a.length).forEach(k => {
 e = e.replace(new RegExp('(?<![a-zA-Z0-9_])'+k+'(?![a-zA-Z0-9_])','g'), String(ctx[k]));
 });
 // Support Excel IF syntax
 e = e.replace(/\bIF\s*\(/gi, '_XIF_(');
 const v = Function('"use strict";function _XIF_(c,a,b){return c?a:b}return ('+e+')')();
 return isFinite(v) ? v : 0;
 } catch(err) { return 0; }
 });
}

//  COMPUTE 
function compute() {
 const pm = PM();

 //  1. OPEX buffer rate (needed early) 
 const opxBufPct = (CFG.opxbuf ?? 30) / 100;

 //  2. Revenue  -  accrual (P&L) 
 const revCats = {};
 revenues.forEach(r => {
 const cat = (r.cat || 'Revenue').trim() || 'Revenue';
 if (!revCats[cat]) revCats[cat] = Z();
 getDistArr(r).forEach((v, i) => { revCats[cat][i] += v; });
 });
 const baseIncome = Z();
 Object.values(revCats).forEach(a => a.forEach((v, i) => { baseIncome[i] += v; }));
 // Per-item penalties (override global CFG.pen if penEnabled)
 const penArr = Z();
 revenues.forEach(r => {
 const penPct = (r.penEnabled && r.penOverride !== '') ? (parseFloat(r.penOverride)||0) : CFG.pen;
 getDistArr(r).forEach((v, i) => { penArr[i] -= v * (penPct / 100); });
 });
 const totalRevBase = baseIncome.map((v, i) => v + penArr[i]);

 //  3. Revenue  -  CF timing (billing schedule) 
 const revCatsCF = {};
 revenues.forEach(r => {
 const cat = (r.cat || 'Revenue').trim() || 'Revenue';
 if (!revCatsCF[cat]) revCatsCF[cat] = Z();
 getCFRevArr(r).forEach((v, i) => { revCatsCF[cat][i] += v; });
 });
 const baseIncomeCF = Z();
 Object.values(revCatsCF).forEach(a => a.forEach((v, i) => { baseIncomeCF[i] += v; }));
 // Per-item CF penalties
 const penArrCF = Z();
 revenues.forEach(r => {
 const penPct = (r.penEnabled && r.penOverride !== '') ? (parseFloat(r.penOverride)||0) : CFG.pen;
 getCFRevArr(r).forEach((v, i) => { penArrCF[i] -= v * (penPct / 100); });
 });
 const totalRevBaseCF = baseIncomeCF.map((v, i) => v + penArrCF[i]);
 // Net CF revenue base used for formulas that should stay ex-IGV, like OPEX Buffer.
 const totalRevBaseCFNet = Z();
 revenues.forEach(r => {
  const penPct = (r.penEnabled && r.penOverride !== '') ? (parseFloat(r.penOverride)||0) : CFG.pen;
  getCFRevArr(r).forEach((v, i) => {
   const netV = r.igv ? v / (1 + IGV) : v;
   totalRevBaseCFNet[i] += netV - (netV * penPct / 100);
  });
 });

 //  4. Costs  -  accrual (P&L) 
 // Dynamic categories: user-defined free text, not hardcoded COST_CATS
 const costCat = { Contingency: Z(), 'Financial Exp': Z() };
 [...capex, ...opex].forEach(item => {
 const cat = (item.cat || 'Other').trim() || 'Other';
 if (!costCat[cat]) costCat[cat] = Z();
 getDistArr(item).forEach((v, i) => { costCat[cat][i] += v; });
 });
 // baseCogs = sum of all user-defined categories (excludes Contingency, Financial Exp)
 const userCats = Object.keys(costCat).filter(k => k !== 'Contingency' && !k.startsWith('Financial'));
 const baseCogs = Z();
 userCats.forEach(c => costCat[c].forEach((v, i) => { baseCogs[i] += v; }));
 costCat['Contingency'] = (() => {
 const ovr = (typeof formulaOverrides!=='undefined') && formulaOverrides['expr_contingency'];
 if (ovr) return evalFormulaOverride(ovr, (month, mi) => ({
 baseCogs_m: baseCogs[mi]||0, totalCogs: baseCogs[mi]||0,
 conPct: CFG.con/100, con: CFG.con
 }));
 return baseCogs.map(v => v * (CFG.con / 100));
 })();

 //  5. Financial expenses (need baseIncome total) 
 let finExpCB = Z(); // will be updated after totalIncome known
 const fubTotal = rSum(baseIncome) * (CFG.fub / 100);
 const finExpUB = new Array(pm).fill(pm > 0 ? fubTotal / pm : 0);
 costCat['Financial Exp CB'] = finExpCB;
 costCat['Financial Exp UB'] = finExpUB;
 costCat['Financial Exp'] = Z();

 //  6. Costs  -  CF timing 
 const costCatCF = { Contingency: Z(), 'Financial Exp': Z() };
 [...capex, ...opex].forEach(item => {
 const cat = (item.cat || 'Other').trim() || 'Other';
 if (!costCatCF[cat]) costCatCF[cat] = Z();
 getCFDistArr(item).forEach((v, i) => { costCatCF[cat][i] += v; });
 });
 const baseCogsOnCF = Z();
 userCats.forEach(c => (costCatCF[c]||Z()).forEach((v, i) => { baseCogsOnCF[i] += v; }));
 costCatCF['Contingency'] = baseCogsOnCF.map(v => v * (CFG.con / 100));
 costCatCF['Financial Exp CB'] = finExpCB;
 costCatCF['Financial Exp UB'] = finExpUB;
 costCatCF['Financial Exp'] = Z();

 //  7. Adjustments 
 // Compute two versions: accrual (P&L) and CF-timed
 // For each target, src = monthly accrual array; srcCF = CF-shifted array
 const adjCalc = [];
 adjustments.forEach(adj => {
 const pct = (parseFloat(adj.pct) || 0) / 100;
 const base = Z();
 const baseCF = Z();

 if (adj.distMode === 'manual' && adj.mos && Object.keys(adj.mos).length > 0) {
 // Manual distribution: total = sum(targets) * pct, distributed by user-defined %
 let totalBase = 0;
 (adj.targets || []).forEach(t => {
 let src = null;
 if (t.type === 'revenue') { const it = revenues.find(r => r.id === t.refId); if (it) src = getDistArr(it); }
 else if (t.type === 'capex') { const it = capex.find(r => r.id === t.refId); if (it) src = getDistArr(it); }
 else if (t.type === 'opex') { const it = opex.find(r => r.id === t.refId); if (it) src = getDistArr(it); }
 else if (t.type === 'revcat') { src = revCats[t.refId] || null; }
 else if (t.type === 'costcat') { src = costCat[t.refId] || null; }
 if (src) totalBase += rSum(src.map(Math.abs));
 });
 const totalAdj = totalBase * pct;
 AMs().forEach(m => {
 const mPct = evalPct(adj.mos[m]) || 0;
 base[m-1] = totalAdj * mPct / 100;
 baseCF[m-1] = totalAdj * mPct / 100;
 });
 } else {
 // Auto: follow target timing
 (adj.targets || []).forEach(t => {
 let src = null, srcCF = null;
 if (t.type === 'revenue') { const it = revenues.find(r => r.id === t.refId); if (it) { src = getDistArr(it); srcCF = getCFRevArr(it); } }
 else if (t.type === 'capex') { const it = capex.find(r => r.id === t.refId); if (it) { src = getDistArr(it); srcCF = getCFDistArr(it); } }
 else if (t.type === 'opex') { const it = opex.find(r => r.id === t.refId); if (it) { src = getDistArr(it); srcCF = getCFDistArr(it); } }
 else if (t.type === 'revcat') { src = revCats[t.refId] || null; srcCF = revCatsCF[t.refId] || null; }
 else if (t.type === 'costcat') { src = costCat[t.refId] || null; srcCF = costCatCF[t.refId] || null; }
 if (src) src.forEach((v, i) => { base[i] += Math.abs(v); });
 if (srcCF) srcCF.forEach((v, i) => { baseCF[i] += Math.abs(v); });
 else if (src) src.forEach((v, i) => { baseCF[i] += Math.abs(v); });
 });
 }
 adjCalc.push({ adj, arr: base.map(v => v * pct), arrCF: baseCF.map(v => v * pct) });
 });
 const adjIncomeRows = adjCalc.filter(ac => ac.adj.side === 'revenue');
 const adjCostRows = adjCalc.filter(ac => ac.adj.side === 'cost');

 // Accrual deltas (P&L)
 const adjIncDelta = Z(); adjIncomeRows.forEach(ac => { const s = ac.adj.sign==='add'?1:-1; ac.arr.forEach((v,i)=>{ adjIncDelta[i] +=s*v; }); });
 const adjCostDelta = Z(); adjCostRows.forEach(ac => { const s = ac.adj.sign==='add'?1:-1; ac.arr.forEach((v,i)=>{ adjCostDelta[i] +=s*v; }); });

 // CF-timed deltas (Cash Flow)
 const adjIncDeltaCF = Z(); adjIncomeRows.forEach(ac => { const s = ac.adj.sign==='add'?1:-1; ac.arrCF.forEach((v,i)=>{ adjIncDeltaCF[i] +=s*v; }); });
 const adjCostDeltaCF = Z(); adjCostRows.forEach(ac => { const s = ac.adj.sign==='add'?1:-1; ac.arrCF.forEach((v,i)=>{ adjCostDeltaCF[i] +=s*v; }); });

 //  8. P&L totals 
 const totalIncome = totalRevBase.map((v, i) => v + adjIncDelta[i]);
 const opexBuffer = (() => {
 const ovr = (typeof formulaOverrides!=='undefined') && formulaOverrides['expr_opex_buffer'];
 if (ovr) return evalFormulaOverride(ovr, (month, mi) => ({
 totalIncome_m: totalRevBase[mi]||0, totalIncome: totalRevBase[mi]||0,
 opxBufPct, opxbuf: CFG.opxbuf||30
 })).map(v => Math.abs(v));
 return totalRevBase.map(v => Math.abs(v) * opxBufPct);
 })();

 // Compliance Bond monthly
 const finExpCBFixed = rSum(baseIncome) * (CFG.fcbCost / 100) * (1 + IGV) * (CFG.fcb / 100);
 finExpCB = new Array(pm).fill(finExpCBFixed);
 costCat['Financial Exp CB'] = finExpCB;
 costCatCF['Financial Exp CB'] = finExpCB;

 // COGS = all cost cats (includes capex, opex, contingency, fin exp) + adj
 const totalCogs = Z();
 Object.values(costCat).forEach(a => a.forEach((v, i) => { totalCogs[i] += v; }));
 const totalCogsAdj = totalCogs.map((v, i) => v + adjCostDelta[i]);

 // Gross Profit = Total Income  Total COGS
 const grossProfit = totalIncome.map((v, i) => v - totalCogsAdj[i]);

 // Bond fees (out-of-pocket)
 const bondFees = finExpCB.map((v, i) => v + finExpUB[i]);

 // Hedging: (Revenue_USD × FX  Costs_PEN_inUSD) / months
 // Costs in PEN = items with cur==='PEN' (their base value already converted to USD in getBase)
 // We need them in PEN: item.cur==='PEN'  getBase(it) * FX = original PEN amount
 const revTotalPEN = rSum(baseIncome) * CFG.fx;
 const costTotalPEN = [...capex, ...opex]
 .filter(it => it.cur === 'PEN')
 .reduce((s, it) => s + _toNumber(it.amount), 0);
 const hedgingTotalUSD = pm > 0 ? (revTotalPEN - costTotalPEN) / CFG.fx / pm : 0;
 const hedgingMonthly = Math.max(0, hedgingTotalUSD);
 // Override: if user edited hedging formula, evaluate it per month
 const hedgingArr = (() => {
 const ovr = (typeof formulaOverrides!=='undefined') && formulaOverrides['expr_hedging'];
 if (ovr) return evalFormulaOverride(ovr, (month, mi) => ({
 revTotalPEN, costTotalPEN, hedgingMonthly, fx: CFG.fx, pm,
 totalIncome_m: baseIncome[mi]||0
 }));
 return new Array(pm).fill(hedgingMonthly);
 })();
 // Profit before OPEX = Gross Profit  Bond Fees
 const profitBeforeOpex = grossProfit.map((v, i) => v - bondFees[i]);

 //  9. CF totals 
 const totalIncomeCF = totalRevBaseCF.map((v, i) => v + adjIncDeltaCF[i]);
 const opexBufferCF = (() => {
 const ovr = (typeof formulaOverrides!=='undefined') && formulaOverrides['expr_opex_buffer'];
 if (ovr) return evalFormulaOverride(ovr, (month, mi) => ({
 totalIncome_m: totalRevBaseCFNet[mi]||0, totalIncome: totalRevBaseCFNet[mi]||0,
 opxBufPct, opxbuf: CFG.opxbuf||30
 })).map(v => Math.abs(v));
 return totalRevBaseCFNet.map(v => Math.abs(v) * opxBufPct);
 })();
 const totalCogsCF = Z();
 Object.values(costCatCF).forEach(a => a.forEach((v, i) => { totalCogsCF[i] += v; }));
 const totalCogsCFAdj = totalCogsCF.map((v, i) => v + adjCostDeltaCF[i]);

 // VAT / IGV: amounts are imported net of IGV. If item.igv=true, CF includes IGV cash movement.
 // P&L remains net of IGV; VAT payable is shown separately and deducted in cash flow.
 const vatIn = Z();
 revenues.forEach(r => {
  if (!r.igv) return;
  const gross = getCFRevArr(r);
  gross.forEach((v, i) => { vatIn[i] += v - (v / (1 + IGV)); });
 });
 const vatOut = Z();
 [...capex, ...opex].forEach(it => {
  if (!it.igv) return;
  const gross = getCFDistArr(it);
  gross.forEach((v, i) => { vatOut[i] -= v - (v / (1 + IGV)); });
 });
 const vatAccum = Z();
 const vatToPay = Z();
 let _vatBal = 0;
 AMs().forEach((m, i) => {
  const netVat = (vatIn[i] || 0) + (vatOut[i] || 0);
  _vatBal += netVat;
  vatAccum[i] = _vatBal;
  vatToPay[i] = Math.max(0, netVat);
 });

 //  Financing Cost  -  computed on accumulated CF 
 // finCost[m] = |accumCF[m-1]| × monthly_rate if accumCF[m-1] < 0, else 0
 // accumCF depends on netCF which depends on finCost  solve iteratively (2 passes)
 const finMonthlyRate = (CFG.finRate || 0) / 100;
 const finCostArr = Z(); // will be filled below

 // Pass 1: compute netCF without financing cost to seed accumCF
 const netCFbase = totalIncomeCF.map((v, i) =>
 v - totalCogsCFAdj[i] - opexBufferCF[i] - finExpCB[i] - finExpUB[i] - hedgingArr[i] - vatToPay[i]
 );
 let acBase = 0;
 const accumCFbase = netCFbase.map(v => { acBase += v; return acBase; });

 // Financing cost  -  per-month on previous accumulated CF
 const _finOvr = (typeof formulaOverrides!=='undefined') && formulaOverrides['expr_financing_cost'];
 for (let i = 0; i < pm; i++) {
 const prevAccum = i === 0 ? 0 : accumCFbase[i - 1];
 const defaultVal = prevAccum < 0 ? Math.abs(prevAccum) * finMonthlyRate : 0;
 if (_finOvr) {
 try {
 const result = evalFormulaOverride(_finOvr, (month, mi2) => ({
 prevAccum: mi2===i ? prevAccum : (mi2===0?0:(accumCFbase[mi2-1]||0)),
 accumCF_prev: prevAccum, finMonthlyRate,
 Monthly_Rate: finMonthlyRate, finRate: finMonthlyRate
 }));
 finCostArr[i] = isFinite(result[i]) ? Math.max(0, result[i]) : defaultVal;
 } catch(e) { finCostArr[i] = defaultVal; }
 } else {
 finCostArr[i] = defaultVal;
 }
 }
 // Final netCF includes financing cost
 const netCF = netCFbase.map((v, i) => v - finCostArr[i]);
 let ac = 0;
 const accumCF = netCF.map(v => { ac += v; return ac; });

 // EBIT = Profit before OPEX  OPEX Buffer  Hedging  Financing Cost (P&L accrual)
 const ebit = profitBeforeOpex.map((v, i) => v - opexBuffer[i] - hedgingArr[i] - finCostArr[i]);
 const ebitda = grossProfit.slice(); // EBITDA = GP (before all below-the-line)

 //  10. NPV 
 const mRate = Math.pow(1 + CFG.dis / 100, 1 / 12) - 1;
 const npvCF = netCF.reduce((a, v, i) => a + v / Math.pow(1 + mRate, i + 1), 0);
 const npvInc = totalIncomeCF.reduce((a, v, i) => a + v / Math.pow(1 + mRate, i + 1), 0);

 return {
 revCats, revCatsCF, costCat, costCatCF, userCats,
 penArr, penArrCF, opexBuffer, opexBufferCF, opxBufPct,
 adjCalc, adjIncomeRows, adjCostRows, adjCostDeltaCF, adjIncDeltaCF,
 totalIncome, totalIncomeCF, totalCogsAdj, totalCogsCFAdj,
 grossProfit, profitBeforeOpex, bondFees,
 finExpCB, finExpUB, hedgingArr, finCostArr, customLines,
 ebit, ebitda,
 netCF, accumCF,
 vatIn, vatOut, vatAccum, vatToPay,
 npvCF, npvInc, mRate
 };
}

//  AGGREGATION 
function aggY(arr) {
 const nY = Math.ceil(PM() / 12);
 return Array.from({length: nY}, (_, yi) =>
 AMs().filter(m => m > yi*12 && m <= (yi+1)*12).reduce((s, m) => s + (arr[m-1] || 0), 0)
 );
}
function aggAccY(arr) {
 const nY = Math.ceil(PM() / 12);
 return Array.from({length: nY}, (_, yi) => arr[Math.min((yi+1)*12, PM()) - 1] || 0);
}
function yrLabels() {
 return Array.from({length: Math.ceil(PM()/12)}, (_, i) =>
 'FY ' + (CFG.sy + Math.floor((CFG.sm - 1 + i*12) / 12))
 );
}

//  NAVIGATION 
const TAB_TITLES = {
 dashboard:'Dashboard', settings:'Project Settings', revenues:'Revenue',
 capex:'CAPEX', opex:'OPEX', adjustments:'Custom Adjustments',
 costs:'Cost Summary', pl:'Profit & Loss', cf:'Cash Flow'
};

function setTab(tab) {
 document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
 document.querySelectorAll('.panel').forEach(p => p.classList.toggle('show', p.id === 'panel-' + tab));
 document.getElementById('pg-title').textContent = TAB_TITLES[tab] || tab;
 updateSub();
 renderTab(tab);
}
function updateSub() {
 document.getElementById('pg-sub').textContent =
 `Figures in USD · FX: ${CFG.fx} PEN/USD · ${CFG.months} months · VAT via Adjustments`;
}
document.getElementById('main-nav').addEventListener('click', e => {
 if (e.target.dataset && e.target.dataset.tab) setTab(e.target.dataset.tab);
});
function renderTab(t) {
 if (t === 'dashboard') renderDashboard();
 else if (t === 'settings') renderSettings();
 else if (t === 'revenues') renderList('revenues');
 else if (t === 'capex') renderList('capex');
 else if (t === 'opex') renderList('opex');
 else if (t === 'adjustments') renderAdjustments();
 else if (t === 'costs') renderCostSummary();
 else if (t === 'pl') renderPL();
 else if (t === 'formulas') renderFormulaPanel();
 else if (t === 'cf') renderCF();
}

//  SETTINGS 
function initSettings() {
 const smEl = document.getElementById('s-sm');
 MES.forEach((m, i) => { const o = document.createElement('option'); o.value = i+1; o.textContent = m; smEl.appendChild(o); });
 const syEl = document.getElementById('s-sy');
 for (let y = 2024; y <= 2035; y++) { const o = document.createElement('option'); o.value = y; o.textContent = y; syEl.appendChild(o); }
 // duration is now a plain number input  -  nothing to populate
 ['s-sm','s-sy','s-dur','s-fx','s-pen','s-con','s-opxbuf','s-dis','s-finrate','s-fcb','s-fcb-cost','s-fub','s-hedg'].forEach(id => {
 document.getElementById(id).addEventListener('change', readSettings);
 document.getElementById(id).addEventListener('input', readSettings);
 });
}
function renderSettings() {
 document.getElementById('s-sm').value = CFG.sm;
 document.getElementById('s-sy').value = CFG.sy;
 document.getElementById('s-dur').value = CFG.months;
 document.getElementById('s-fx').value = CFG.fx;
 document.getElementById('s-pen').value = CFG.pen;
 document.getElementById('s-con').value = CFG.con;
 document.getElementById('s-opxbuf').value = CFG.opxbuf ?? 30;
 document.getElementById('s-dis').value = CFG.dis;
 document.getElementById('s-fcb').value = CFG.fcb || '';
 document.getElementById('s-fcb-cost').value = CFG.fcbCost || '';
 document.getElementById('s-fub').value = CFG.fub || '';
 document.getElementById('s-hedg').value = CFG.hedg || '';
 document.getElementById('s-finrate').value = CFG.finRate || '';
 renderSSum();
 _renderSbPanel();
}

async function _testSbConn() {
 if (!_sbReady || !supabaseClient) return { ok: false, error: _sbError || 'Client not initialized' };
 try {
  const { data, error } = await supabaseClient.from(PROJECTS_TABLE).select('id').limit(1);
  if (error) return { ok: false, error: error.message, code: error.code };
  return { ok: true };
 } catch(e) { return { ok: false, error: e.message }; }
}

function _renderSbPanel() {
 const settingsPanel = document.getElementById('panel-settings');
 if (!settingsPanel) return;
 let panel = document.getElementById('_sb_panel');
 if (!panel) {
  panel = document.createElement('div');
  panel.id = '_sb_panel';
  panel.style.cssText = 'margin-top:24px;border:1.5px solid #e2e8f0;border-radius:12px;overflow:hidden;font-family:inherit';
  settingsPanel.appendChild(panel);
 }
 panel.innerHTML = `
  <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:linear-gradient(90deg,#1c2b3a,#2d4a6b);color:#fff">
   <span style="font-size:20px">🗄️</span>
   <div style="flex:1"><div style="font-size:13px;font-weight:700">Supabase Database</div>
    <div style="font-size:10px;opacity:.7">Cloud storage for your projects</div></div>
   <span id="_sb_badge" style="font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;background:#fff8e8;color:#A56105">⏳ Not tested</span>
  </div>
  <div style="padding:16px;background:#fff;display:grid;gap:12px">

   <div style="font-size:11px;background:#f8fafc;border-radius:8px;padding:10px 12px;line-height:1.7">
    <strong>Project URL:</strong> <code style="font-size:10px">${SUPABASE_URL}</code><br>
    <strong>Key:</strong> <code style="font-size:10px">${SUPABASE_KEY.slice(0,30)}…</code>
    <span style="color:#2E844A;font-size:10px"> (publishable key — correct format for Supabase JS v2.39+)</span>
   </div>

   <div style="background:#fff8e8;border-left:3px solid #A56105;padding:10px 12px;border-radius:6px;font-size:11px;line-height:1.7">
    <strong style="color:#A56105">⚠️ Required: Run this SQL once in Supabase Dashboard → SQL Editor</strong><br>
    This makes the table work without login (single-user mode):
    <pre id="_sb_sql" style="background:#1c2b3a;color:#7dd3fc;padding:10px;border-radius:6px;font-size:10px;margin-top:6px;white-space:pre;overflow-x:auto">-- Run in Supabase Dashboard > SQL Editor
-- Step 1: Allow user_id to be empty (no auth needed)
ALTER TABLE projects ALTER COLUMN user_id DROP NOT NULL;

-- Step 2: Disable Row Level Security (single-user mode)
ALTER TABLE projects DISABLE ROW LEVEL SECURITY;

-- Step 3: (optional) Verify
SELECT id, name, updated_at FROM projects LIMIT 5;</pre>
    <button onclick="navigator.clipboard.writeText(document.getElementById('_sb_sql').textContent).then(()=>_sbToast('SQL copiado ✓','#2E844A'))"
     style="font-size:10px;margin-top:6px;padding:4px 12px;border-radius:4px;border:1px solid #A56105;background:#fff;cursor:pointer;color:#A56105">
     📋 Copy SQL
    </button>
   </div>

   <div id="_sb_err_box" style="display:none;background:#fef1f1;border-left:3px solid #BA0517;padding:10px 12px;border-radius:6px;font-size:11px"></div>

   <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <button id="_sb_test_btn" style="padding:7px 16px;border-radius:6px;border:1.5px solid #1c2b3a;background:#1c2b3a;color:#fff;font-size:12px;font-weight:600;cursor:pointer">
     🔌 Test Connection
    </button>
    <button id="_sb_sync_btn" style="padding:7px 16px;border-radius:6px;border:1.5px solid var(--bdr);background:#fff;font-size:12px;cursor:pointer">
     🔄 Sync Projects
    </button>
    <span id="_sb_result" style="font-size:11px;color:var(--sub)"></span>
   </div>

   <details style="font-size:11px">
    <summary style="cursor:pointer;font-weight:600;color:#0176D3">📋 Full table schema (if table doesn't exist yet)</summary>
    <pre style="background:#1c2b3a;color:#7dd3fc;padding:12px;border-radius:8px;font-size:10px;margin-top:8px;overflow-x:auto">CREATE TABLE IF NOT EXISTS projects (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  name text,
  category text,
  description text,
  status text,
  data jsonb,
  snapshot jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE projects DISABLE ROW LEVEL SECURITY;</pre>
   </details>
  </div>`;

 document.getElementById('_sb_test_btn').onclick = async () => {
  const btn = document.getElementById('_sb_test_btn');
  const res = document.getElementById('_sb_result');
  const badge = document.getElementById('_sb_badge');
  const errBox = document.getElementById('_sb_err_box');
  btn.textContent = '⏳ Testing…'; btn.disabled = true;
  const r = await _testSbConn();
  btn.textContent = '🔌 Test Connection'; btn.disabled = false;
  if (r.ok) {
   res.textContent = '✅ Connected!'; res.style.color = '#2E844A';
   badge.textContent = '✅ Connected'; badge.style.background = '#eafaea'; badge.style.color = '#2E844A';
   errBox.style.display = 'none';
  } else {
   const isRLS = r.error && (r.error.includes('row-level') || r.code === '42501' || r.code === 'PGRST301');
   const isNoTbl= r.error && (r.error.includes('does not exist') || r.code === '42P01');
   res.textContent = '❌ Failed'; res.style.color = '#BA0517';
   badge.textContent = '❌ Error'; badge.style.background = '#fef1f1'; badge.style.color = '#BA0517';
   errBox.style.display = 'block';
   errBox.innerHTML = '<strong style="color:#BA0517">Error: ' + (r.error||'unknown') + '</strong><br>'
    + (isRLS ? '→ <strong>Fix: Run the SQL above</strong> to disable RLS.' : '')
    + (isNoTbl ? '→ <strong>Fix: Create the table</strong> using the schema below.' : '')
    + (!isRLS && !isNoTbl ? '→ Check your Project URL and API key.' : '');
  }
 };
 document.getElementById('_sb_sync_btn').onclick = async () => {
  const btn = document.getElementById('_sb_sync_btn');
  btn.textContent = '⏳ Syncing…'; btn.disabled = true;
  await loadPortfolio();
  btn.textContent = '🔄 Sync Projects'; btn.disabled = false;
  _sbToast('✅ Sync done — ' + portfolio.length + ' project(s) loaded', '#2E844A');
 };
}
function readSettings() {
 CFG = {
 sm: parseInt(document.getElementById('s-sm').value),
 sy: parseInt(document.getElementById('s-sy').value),
 months: Math.max(1, parseInt(document.getElementById('s-dur').value) || 12),
 fx: parseFloat(document.getElementById('s-fx').value) || 3.75,
 pen: parseFloat(document.getElementById('s-pen').value) || 0,
 con: parseFloat(document.getElementById('s-con').value) || 0,
 opxbuf: parseFloat(document.getElementById('s-opxbuf').value) ?? 30,
 dis: parseFloat(document.getElementById('s-dis').value) || 12,
 fcb: parseFloat(document.getElementById('s-fcb').value) || 0,
 fcbCost: parseFloat(document.getElementById('s-fcb-cost').value) || 0,
 fub: parseFloat(document.getElementById('s-fub').value) || 0,
 hedg: parseFloat(document.getElementById('s-hedg').value) || 0,
 finRate: parseFloat(document.getElementById('s-finrate').value) || 0,
 };
 renderSSum();
 updateSub();
}
function renderSSum() {
 const end = mInfo(PM());
 const rows = [
 ['Start', MEN[CFG.sm-1] + ' ' + CFG.sy],
 ['End', end.label],
 ['Duration', PM() + ' months'],
 ['FX Rate', '1 USD = ' + CFG.fx + ' PEN'],
 ['IGV', '18%'],
 ['Penalties', CFG.pen + '%'],
 ['Contingency', CFG.con + '%'],
 ['OPEX Buffer', (CFG.opxbuf ?? 30) + '%'],
 ['Discount', CFG.dis + '% p.a.'],
 ['CB %', (CFG.fcbCost||0) + '%'],
 ['CB Cost/Month %', CFG.fcb + '%'],
 ['Fin Exp UB', CFG.fub + '%'],
 ['Hedging', (CFG.hedg||0) + '%'],
 ];
 document.getElementById('s-sum').innerHTML = rows.map(([k,v]) =>
 `<div><div class="sum-k">${k}</div><div class="sum-v">${v}</div></div>`
 ).join('');
}

//  ITEM LIST MANAGEMENT 
function getList(type) {
 return type === 'revenues' ? revenues : type === 'capex' ? capex : opex;
}
function setList(type, list) {
 if (type === 'revenues') revenues = list;
 else if (type === 'capex') capex = list;
 else opex = list;
}

const mkRev = () => ({ id: uid(), name:'', amount:'', cur:'USD', igv:false, cat:'', mos:{}, adv:'', advMo:1, payCond:'', refNote:'', refUrl:'', billingMode:'pattern', billingCuts:[], billingDelay:0, billingFirst:1, billingEvery:1, progMode:false, progMonthly:'', progCatRef:'', penOverride:'', penEnabled:false });
const mkCost = () => ({ id: uid(), name:'', amount:'', cur:'USD', igv:false, cat:'', mos:{}, adv:'', advMo:1, payCond:'', refNote:'', refUrl:'', progMode:false, progMonthly:'', progFixedMonths:'', progFixedStart:'', negative:false, collectionMap:{} });

//  Collapse / Expand all helpers 
function collapseAll(type, collapse) {
 const list = getList(type);
 list.forEach(item => { item._collapsed = collapse; });
 renderList(type);
}

['revenues','capex','opex'].forEach(type => {
 document.getElementById('collapse-all-' + type).addEventListener('click', () => collapseAll(type, true));
 document.getElementById('expand-all-' + type).addEventListener('click', () => collapseAll(type, false));
});

document.getElementById('add-rev') .addEventListener('click', () => { revenues.push(mkRev()); renderList('revenues'); });
document.getElementById('add-capex').addEventListener('click', () => { capex.push(mkCost()); renderList('capex'); });
document.getElementById('add-opex') .addEventListener('click', () => { opex.push(mkCost()); renderList('opex'); });

//  ITEM LIST RENDERER 
function renderList(type) {
 const container = document.getElementById(type + '-list');
 const items = getList(type);
 container.innerHTML = '';
 if (!items.length) {
 container.innerHTML = '<div class="empty-msg">No items yet. Click "+ Add Item" to begin.</div>';
 return;
 }
 items.forEach((item, idx) => {
 try {
 container.appendChild(buildItemCard(item, idx, type));
 } catch(e) {
 console.error('buildItemCard error for item', item.id, e);
 console.error('buildItemCard error:', e.message, e.stack);
 const errDiv = document.createElement('div');
 errDiv.style.cssText = 'padding:14px;background:#fef1ee;border:2px solid #BA0517;border-radius:8px;margin-bottom:10px;word-break:break-all';
 const errLines = (e.stack||e.message||'Unknown error').split('\n').slice(0,6);
 errDiv.innerHTML = '<div style="font-size:12px;font-weight:700;color:#BA0517;margin-bottom:8px"> Error in item: "' + (item.name||'unnamed') + '"</div>'
 + '<div style="font-size:11px;color:#BA0517;margin-bottom:6px">' + e.message + '</div>'
 + '<code style="font-size:9px;color:#888;display:block;white-space:pre-wrap">' + errLines.join('\n') + '</code>'
 + '<div style="margin-top:8px;font-size:10px;color:#888">Open DevTools (F12  Console) for full details. Common fixes: remove and re-add this item.</div>';
 container.appendChild(errDiv);
 }
 });
}

function buildItemCard(item, idx, type) {
 const isCost = (type !== 'revenues');
 const pm = PM();
 const nY = Math.ceil(pm / 12);

 /* ---- wrapper ---- */
 const wrap = document.createElement('div');
 wrap.className = 'card';

 /* ---- header ---- */
 const hdr = document.createElement('div'); hdr.className = 'card-hdr';

 // Left: collapse chevron + title + sub
 const hdrLeft = document.createElement('div');
 hdrLeft.style.cssText = 'display:flex;align-items:center;min-width:0;flex:1';

 const collapseBtn = document.createElement('button');
 collapseBtn.className = 'card-collapse-btn';
 collapseBtn.innerHTML = '&#9660;'; // 
 collapseBtn.title = 'Collapse / Expand';

 const titleEl = document.createElement('span'); titleEl.className = 'card-title';
 const subEl = document.createElement('span'); subEl.className = 'card-sub';
 const summaryEl = document.createElement('span'); summaryEl.className = 'card-summary';

 const refBadge = document.createElement('span'); refBadge.className = 'ref-badge';
 refBadge.innerHTML = ' ref'; refBadge.style.display = 'none';

 hdrLeft.appendChild(collapseBtn);
 hdrLeft.appendChild(titleEl);
 hdrLeft.appendChild(subEl);
 hdrLeft.appendChild(summaryEl);
 hdrLeft.appendChild(refBadge);

 // Right: remove button
 const removeBtn = document.createElement('button');
 removeBtn.className = 'btn-remove';
 removeBtn.textContent = 'Remove';

 hdr.appendChild(hdrLeft);
 hdr.appendChild(removeBtn);

 //  Collapse / Expand logic 
 let isCollapsed = item._collapsed || false;

 function applyCollapse() {
 wrap.classList.toggle('collapsed', isCollapsed);
 summaryEl.style.display = isCollapsed ? 'inline' : 'none';
 }
 applyCollapse();

 function toggleCollapse(e) {
 // Don't collapse when clicking Remove button
 if (e.target === removeBtn || removeBtn.contains(e.target)) return;
 isCollapsed = !isCollapsed;
 item._collapsed = isCollapsed;
 applyCollapse();
 }
 hdr.addEventListener('click', toggleCollapse);

 function updateRefBadge() {
 const hasRef = !!(item.refNote || item.refUrl);
 refBadge.style.display = hasRef ? 'inline-flex' : 'none';
 refBadge.title = [item.refNote, item.refUrl].filter(Boolean).join(' | ');
 }
 updateRefBadge();
 wrap.appendChild(hdr);

 /* ---- body ---- */
 const body = document.createElement('div'); body.className = 'card-body';
 wrap.appendChild(body);

 /* ---- fields grid ---- */
 const grid = document.createElement('div');
 grid.className = 'g-auto';
 grid.style.marginBottom = '14px';
 body.appendChild(grid);

 function addFld(labelText, inputEl) {
 const d = document.createElement('div'); d.className = 'fld';
 const l = document.createElement('label'); l.textContent = labelText;
 d.appendChild(l); d.appendChild(inputEl);
 grid.appendChild(d);
 return inputEl;
 }
 function mkInp(type2, val) {
 const e = document.createElement('input');
 e.type = type2;
 e.value = (val !== undefined && val !== null) ? String(val) : '';
 return e;
 }
 function mkSel(options, val) {
 const e = document.createElement('select');
 options.forEach(o => {
 const op = document.createElement('option');
 op.value = o; op.textContent = o;
 if (o === val) op.selected = true;
 e.appendChild(op);
 });
 return e;
 }

 // Name
 const nameEl = addFld('Name', mkInp('text', item.name));
 // Amount
 const amtEl = addFld('Amount', mkInp('number', item.amount));
 // Currency
 const curEl = addFld('Currency', mkSel(['USD','PEN'], item.cur));
 // Category
 let catEl;
 if (isCost) {
 const catInp = mkInp('text', item.cat || '');
 catInp.placeholder = 'e.g. Instalación Equipos, Mano de Obra&';
 catInp.setAttribute('list', 'cat-suggestions');
 catEl = addFld('Category', catInp);
 } else {
 const e = mkInp('text', item.cat);
 e.placeholder = 'e.g. Components Dahua';
 catEl = addFld('Category Name', e);
 }
 // Cost-only fields
 let payCondEl, advEl, advMoEl;
 if (isCost) {
 payCondEl = addFld('Payment Condition (days)', mkInp('number', item.payCond));
 advEl = addFld('Advance %', mkInp('number', item.adv));
 const advMoSel = document.createElement('select');
 AMs().forEach(m => {
 const o = document.createElement('option');
 o.value = m; o.textContent = mInfo(m).label;
 if (item.advMo === m) o.selected = true;
 advMoSel.appendChild(o);
 });
 advMoEl = addFld('Advance Month', advMoSel);
 }
 // IGV checkbox
 const igvFld = document.createElement('div'); igvFld.className = 'fld';
 const igvLbl = document.createElement('label'); igvLbl.textContent = 'IGV';
 const igvCkL = document.createElement('label'); igvCkL.className = 'chk-label';
 const igvChk = document.createElement('input'); igvChk.type = 'checkbox'; igvChk.checked = !!item.igv;
 igvCkL.appendChild(igvChk); igvCkL.appendChild(document.createTextNode(' Afecto a IGV (monto ingresado sin IGV)'));
 igvFld.appendChild(igvLbl); igvFld.appendChild(igvCkL);
 grid.appendChild(igvFld);

 // Negative amount toggle (costs only)
 if (isCost) {
 const negFld = document.createElement('div'); negFld.className = 'fld';
 const negLbl = document.createElement('label'); negLbl.textContent = 'Sign';
 const negCkL = document.createElement('label'); negCkL.className = 'chk-label';
 negCkL.style.cssText = 'background:#f0f4f8;border:1px solid #888;border-radius:4px;padding:4px 8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px';
 const negChk = document.createElement('input'); negChk.type = 'checkbox'; negChk.checked = !!item.negative;
 negCkL.appendChild(negChk); negCkL.appendChild(document.createTextNode(' Negative (credit/rebate)'));
 negFld.appendChild(negLbl); negFld.appendChild(negCkL);
 grid.appendChild(negFld);
 negChk.addEventListener('change', () => { item.negative = negChk.checked; refresh(); });
 }

 // Per-item penalty override (revenues only)
 if (!isCost) {
 const penFld = document.createElement('div'); penFld.className = 'fld';
 const penLbl = document.createElement('label'); penLbl.textContent = 'Penalty %';
 const penRow = document.createElement('div'); penRow.style.cssText = 'display:flex;align-items:center;gap:6px';
 const penCkL = document.createElement('label'); penCkL.className = 'chk-label'; penCkL.style.cssText = 'font-size:10px;white-space:nowrap';
 const penChk = document.createElement('input'); penChk.type = 'checkbox'; penChk.checked = !!item.penEnabled;
 penCkL.appendChild(penChk); penCkL.appendChild(document.createTextNode(' Override global'));
 const penInp = document.createElement('input'); penInp.type = 'number'; penInp.min = '0'; penInp.max = '100'; penInp.step = '0.1';
 penInp.placeholder = 'e.g. 3'; penInp.value = item.penOverride || '';
 penInp.style.cssText = 'width:70px;' + (item.penEnabled ? '' : 'opacity:.4;pointer-events:none');
 penRow.appendChild(penCkL); penRow.appendChild(penInp);
 penFld.appendChild(penLbl); penFld.appendChild(penRow);
 grid.appendChild(penFld);
 penChk.addEventListener('change', () => {
 item.penEnabled = penChk.checked;
 penInp.style.cssText = 'width:70px;' + (item.penEnabled ? '' : 'opacity:.4;pointer-events:none');
 });
 penInp.addEventListener('input', () => { item.penOverride = penInp.value; });
 }

 /* ---- progressive payment mode (revenue AND costs) ---- */
 {
 const progWrap = document.createElement('div');
 progWrap.style.cssText = 'margin-top:14px;padding:0;border:1px solid #d0e4f7;border-radius:8px;overflow:hidden';

 //  Toggle header 
 const progHdr = document.createElement('div');
 progHdr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f0f6ff;cursor:pointer';
 const progChk = document.createElement('input'); progChk.type='checkbox';
 progChk.checked = !!item.progMode; progChk.id='prog-'+item.id;
 progChk.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:#0176D3;flex-shrink:0';
 const progLblEl = document.createElement('label');
 progLblEl.htmlFor = 'prog-'+item.id;
 progLblEl.style.cssText = 'font-size:12px;font-weight:700;color:#032D60;cursor:pointer;flex:1';
 progLblEl.innerHTML = ' Progressive Payment Mode'
 + '<span style="font-weight:400;color:#888;font-size:10px;margin-left:8px">'
 + (isCost ? 'Pay fixed monthly × % advance  then full fixed for N months'
 : 'Collect fixed monthly × % advance  then full fixed for N months')
 + '</span>';
 progHdr.appendChild(progChk); progHdr.appendChild(progLblEl);
 progHdr.addEventListener('click', e => {
 if (e.target !== progChk) { progChk.checked = !progChk.checked; progChk.dispatchEvent(new Event('change')); }
 });
 progWrap.appendChild(progHdr);

 //  Body (shown when active) 
 const progBody = document.createElement('div');
 progBody.style.cssText = 'padding:14px;display:'+(item.progMode?'block':'none');

 // Info box
 const infoBox = document.createElement('div');
 infoBox.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px';
 infoBox.innerHTML = `
 <div style="background:#e8f4fd;border-radius:6px;padding:10px 12px;border-left:3px solid #0176D3">
 <div style="font-size:10px;font-weight:700;color:#0176D3;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px"> Phase 1  -  Progressive</div>
 <div style="font-size:11px;color:#333;line-height:1.5">Payment = <strong>Fixed Monthly</strong> × <strong>% advance</strong> per month.<br>
 Set % in the distribution grid below.</div>
 </div>
 <div style="background:#e8f7ec;border-radius:6px;padding:10px 12px;border-left:3px solid #2E844A">
 <div style="font-size:10px;font-weight:700;color:#2E844A;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px"> Phase 2  -  Auto Full Payment</div>
 <div style="font-size:11px;color:#333;line-height:1.5">The moment any month hits <strong>100%</strong>, all remaining months automatically pay the <strong>full Fixed Monthly</strong> amount.</div>
 </div>`;
 progBody.appendChild(infoBox);

 // Single field: Fixed Monthly Amount
 const fg = document.createElement('div');
 fg.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:10px;margin-bottom:12px;align-items:end';

 function pFld(lbl, inp) {
 const d = document.createElement('div'); d.className='fld'; d.style.margin='0';
 const l = document.createElement('label'); l.textContent=lbl; l.style.fontSize='10px';
 d.appendChild(l); d.appendChild(inp); return d;
 }

 const mInp = document.createElement('input'); mInp.type='number';
 mInp.placeholder='e.g. 50,000'; mInp.value=item.progMonthly||'';
 mInp.style.cssText='font-weight:700;font-size:14px';

 const autoNote = document.createElement('div');
 autoNote.style.cssText = 'font-size:11px;color:#2E844A;background:#e8f7ec;padding:8px 12px;border-radius:6px;line-height:1.5';
 autoNote.innerHTML = ' <strong>Automatic:</strong> Just set the % advance per month in the distribution grid below. '
 + 'When you put <strong>100</strong> in any month, all subsequent months automatically become full payment.';

 fg.appendChild(pFld('Fixed Monthly Amount ('+(item.cur||'USD')+')', mInp));
 fg.appendChild(autoNote);
 progBody.appendChild(fg);

 // Auto-import row (only for revenue  -  links to cost category)
 if (!isCost) {
 const importRow = document.createElement('div');
 importRow.style.cssText = 'display:flex;gap:8px;align-items:flex-end;margin-bottom:12px';
 const cFld2 = document.createElement('div'); cFld2.className='fld'; cFld2.style.cssText='margin:0;flex:1';
 const cLbl2 = document.createElement('label'); cLbl2.textContent='Auto-import % advance from CAPEX/OPEX category';
 cLbl2.style.fontSize='10px';
 const cInp2 = document.createElement('input'); cInp2.type='text';
 cInp2.placeholder='Type category name, e.g. Instalación Equipos';
 cInp2.value=item.progCatRef||'';
 cInp2.setAttribute('list','cat-suggestions');
 cFld2.appendChild(cLbl2); cFld2.appendChild(cInp2);
 const cBtn2 = document.createElement('button');
 cBtn2.className='btn-tpl'; cBtn2.style.cssText='flex-shrink:0;font-size:11px;padding:6px 12px';
 cBtn2.textContent=' Import %';
 importRow.appendChild(cFld2); importRow.appendChild(cBtn2);
 progBody.appendChild(importRow);
 cInp2.addEventListener('input',()=>{ item.progCatRef=cInp2.value.trim(); });
 cBtn2.addEventListener('click',()=>{
 const refCat=(cInp2.value||'').trim().toLowerCase();
 if(!refCat){showPasteToast('Enter a category name first');return;}
 const catItems=[...capex,...opex].filter(it=>(it.cat||'').trim().toLowerCase()===refCat);
 if(!catItems.length){showPasteToast('No items found with category: '+cInp2.value);return;}
 const catMonthly=new Array(PM()).fill(0);
 const catTotal=catItems.reduce((s,it)=>s+getBase(it),0);
 catItems.forEach(it=>{ getDistArr(it).forEach((v,mi)=>{catMonthly[mi]+=v;}); });
 if(!item.mos) item.mos={};
 AMs().forEach((m,mi)=>{
 const catPct=catTotal>0?(catMonthly[mi]/catTotal*100):0;
 item.mos[m]=catPct>0.001?catPct.toFixed(4):'';
 const inp2=body.querySelector('input[data-m="'+m+'"]');
 if(inp2) inp2.value=item.mos[m];
 });
 updateProgPreview(); safeRefresh();
 cBtn2.textContent=' Done!';
 setTimeout(()=>{cBtn2.textContent=' Import %';},2000);
 });
 }

 // Preview timeline
 const progPreview = document.createElement('div');
 progPreview.className = 'prog-preview';
 progPreview.style.cssText='font-size:10px;color:#555;padding:8px 12px;background:#f8fafc;border-radius:6px;line-height:1.9;border:1px solid #e8e8e8';
 progPreview.textContent='Fill in the fields above to see the payment timeline.';
 progPreview.addEventListener('update', updateProgPreview);
 progBody.appendChild(progPreview);

 progWrap.appendChild(progBody);
 body.appendChild(progWrap);

 //  Preview calculator  -  mirrors getDistArr auto-detect logic 
 function updateProgPreview() {
 if (!item.progMode) return;
 const monthly = parseFloat(item.progMonthly)||0;
 if (!monthly){ progPreview.textContent='Enter a Fixed Monthly Amount to see the timeline.'; return; }

 let fullStarted = false, total = 0;
 const parts = AMs().map(m => {
 let val, phase;
 if (fullStarted) {
 val = monthly; phase = 'full';
 } else {
 const pct = evalPct((item.mos||{})[m])||0;
 val = monthly * pct / 100;
 phase = pct > 0 ? 'prog' : 'none';
 if (pct >= 99.99) fullStarted = true;
 }
 total += val;
 return { m, val, phase, pct: evalPct((item.mos||{})[m])||0 };
 });

 const nProg = parts.filter(p=>p.phase==='prog').length;
 const nFull = parts.filter(p=>p.phase==='full').length;
 const shown = parts.slice(0, Math.min(PM(), 24));

 const rows = shown.map(p => {
 const barW = monthly > 0 ? Math.max(2, Math.round(p.val / monthly * 120)) : 0;
 const c = p.phase==='full' ? '#2E844A' : p.phase==='prog' ? '#0176D3' : '#e0e0e0';
 const tag = p.phase==='full'
 ? '<span style="font-size:8px;background:#e8f7ec;color:#2E844A;padding:1px 5px;border-radius:3px;font-weight:700">FULL</span>'
 : p.phase==='prog'
 ? `<span style="font-size:8px;color:#888">${p.pct.toFixed(0)}%</span>`
 : '<span style="font-size:8px;color:#ccc"> - </span>';
 const amt = p.val > 0
 ? `<span style="font-size:9px;font-weight:700;color:${c}">$${fmt(p.val)}</span>`
 : '';
 return `<div style="display:flex;align-items:center;gap:5px;margin-bottom:3px">
 <div style="width:24px;font-size:9px;color:#999;text-align:right;flex-shrink:0">M${p.m}</div>
 <div style="width:${barW}px;min-width:2px;height:13px;background:${c};border-radius:2px;flex-shrink:0;transition:width .15s"></div>
 ${amt}
 ${tag}
 </div>`;
 }).join('');

 const beMonth = parts.find(p=>p.phase==='full');
 const beNote = beMonth
 ? `&nbsp;·&nbsp; <span style="color:#2E844A">Full payment from M${beMonth.m}</span>`
 : `&nbsp;·&nbsp; <span style="color:#A56105">Set a month to 100% to trigger full payment</span>`;

 progPreview.innerHTML = `<div style="columns:2;column-gap:16px">${rows}</div>`
 + `<div style="margin-top:8px;padding-top:6px;border-top:1px solid #e8e8e8;font-size:11px;font-weight:700;color:#032D60">`
 + `Total: $${fmt(total)}${beNote}`
 + `&nbsp;·&nbsp; ${nProg} progressive + ${nFull} full months</div>`;
 }

 //  Wire events 
 progChk.addEventListener('change', () => {
 item.progMode = progChk.checked;
 progBody.style.display = item.progMode ? 'block' : 'none';
 if (item.progMode && item.progMonthly) {
 item.amount = (parseFloat(item.progMonthly) || 0) * PM();
 amtEl.value = item.amount;
 }
 updateProgPreview();
 refresh();
 });

 mInp.addEventListener('input', () => {
 item.progMonthly = mInp.value;
 if (item.progMode) {
 item.amount = (parseFloat(mInp.value) || 0) * PM();
 amtEl.value = item.amount;
 }
 updateProgPreview();
 refresh();
 });

 // Don't call refresh() during init  -  distLbl/pfill not yet defined
 if (item.progMode && item.progMonthly) updateProgPreview();
 }

 /* ---- safe refresh wrapper  -  guards against calling before distLbl is ready ---- */
 function safeRefresh() {
 try { refresh(); } catch(e) { /* distLbl not yet defined  -  will refresh after full init */ }
 }

 /* ---- payment schedule (revenue, CAPEX & OPEX) ---- */
 {
 // item.collectionMap = { payMonth: [accrualMonth, ...] }
 if (!item.collectionMap) item.collectionMap = {};

 const bsWrap = document.createElement('div'); bsWrap.className = 'bsched-wrap';
 // Add a visible divider between accrual and collection
 const collLbl = document.createElement('div');
 collLbl.style.cssText = 'padding:8px 12px;background:linear-gradient(90deg,#fff4e8,#fafafa);border-left:3px solid #A56105;border-radius:0 6px 6px 0;font-size:11px;font-weight:700;color:#A56105;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px';
 collLbl.textContent = isCost ? ' Payment Schedule  -  when cash is actually paid (Cash Flow)' : ' Collection Schedule  -  when cash is actually received (Cash Flow)';
 bsWrap.appendChild(collLbl);
 // Instruction text
 const instrEl = document.createElement('div');
 instrEl.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:10px;line-height:1.5;padding:0 2px';
 instrEl.innerHTML = isCost ? 'Each row = one <strong>payment event</strong>. Toggle which accrual months are paid in that event. Add delay (days) for late payment.' : 'Each row = one <strong>payment event</strong>. Toggle () which accrual months are paid in that event. Add delay (days) for late collection.';
 bsWrap.appendChild(instrEl);

 //  Interactive grid 
 // Rows = payment months (when cash arrives)
 // Cols = accrual months (M1&PM)
 // Cell = toggle: this accrual month is included in this payment
 // Also: a "payment month" selector per row (which calendar month receives cash)

 const gridWrap = document.createElement('div');
 gridWrap.style.cssText = 'overflow-x:auto;margin-top:4px';

 // Add payment row button
 const addPayBtn = document.createElement('button');
 addPayBtn.className = 'bsched-add-cut';
 addPayBtn.style.marginBottom = '10px';
 addPayBtn.textContent = '+ Add Payment';
 bsWrap.appendChild(addPayBtn);
 bsWrap.appendChild(gridWrap);

 function buildCollectionGrid() {
 gridWrap.innerHTML = '';
 const months = AMs(); // [1..PM]
 const payEntries = Object.entries(item.collectionMap)
 .filter(([k]) => !k.startsWith('delay_')) // exclude delay_X meta-keys
 .map(([k,v]) => [parseInt(k), Array.isArray(v) ? v : []])
 .filter(([k]) => !isNaN(k)) // exclude any other non-numeric keys
 .sort((a,b) => a[0]-b[0]);

 if (!payEntries.length) {
 gridWrap.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0">No payments defined yet. Click "+ Add Payment" to create one.</div>';
 return;
 }

 // Build table
 const tbl = document.createElement('table');
 tbl.style.cssText = 'border-collapse:collapse;font-size:11px;min-width:100%';

 // Header row: "Pay month" label + accrual month headers
 const thead = document.createElement('thead');
 let hRow = '<tr><th style="min-width:120px;padding:4px 8px;background:#f4f6f8;border:1px solid #e0e0e0;white-space:nowrap;font-size:10px">Payment Month</th><th style="padding:4px 6px;background:#f4f6f8;border:1px solid #e0e0e0;font-size:10px;white-space:nowrap">Del (days)</th>';
 months.forEach(m => {
 const mi = mInfo(m);
 hRow += '<th style="min-width:46px;padding:3px 4px;background:#f0f6ff;border:1px solid #e0e0e0;text-align:center;cursor:help" title="Accrual ' + mi.short + ' ' + mi.year + '">'
 + '<div style="font-size:8px;color:#888">' + mi.short + ' ' + String(mi.year).slice(2) + '</div>'
 + '<div style="color:var(--blue);font-weight:700;font-size:9px">(M' + m + ')</div>'
 + '</th>';
 });
 hRow += '<th style="padding:4px 6px;background:#f4f6f8;border:1px solid #e0e0e0;font-size:10px"></th></tr>';
 thead.innerHTML = hRow;
 tbl.appendChild(thead);

 const tbody = document.createElement('tbody');
 payEntries.forEach(([payMo, accrualMos], ri) => {
 const tr = document.createElement('tr');

 // Payment month selector  -  styled select (month picker)
 const tdPay = document.createElement('td');
 tdPay.style.cssText = 'padding:3px 6px;border:1px solid #e0e0e0;white-space:nowrap;background:#fafafa;min-width:130px';
 const mi0 = mInfo(payMo);
 const payBtn = document.createElement('select');
 payBtn.style.cssText = 'font-size:11px;font-weight:600;padding:4px 6px;border:1.5px solid var(--accent);border-radius:5px;background:#fff;color:var(--navy);cursor:pointer;width:130px;outline:none';
 months.forEach(m => {
 const mi_opt = mInfo(m);
 const o = document.createElement('option');
 o.value = m;
 o.textContent = mi_opt.short + ' ' + mi_opt.year + ' (M' + m + ')';
 if (m === payMo) o.selected = true;
 payBtn.appendChild(o);
 });
 payBtn.addEventListener('change', () => {
 const newMo = parseInt(payBtn.value);
 if (newMo === payMo) return;
 const existing = item.collectionMap[newMo] || [];
 item.collectionMap[newMo] = [...new Set([...existing, ...(item.collectionMap[payMo]||[])])];
 delete item.collectionMap[payMo];
 buildCollectionGrid();
 });
 // Row label showing payment month badge
 const payLbl = document.createElement('div');
 payLbl.style.cssText = 'font-size:9px;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.04em';
 payLbl.textContent = 'Pay month';
 const payWrap = document.createElement('div');
 payWrap.appendChild(payLbl); payWrap.appendChild(payBtn);
 tdPay.appendChild(payWrap);
 tr.appendChild(tdPay);

 // Delay input
 const delayKey = 'delay_' + payMo;
 if (!item.collectionMap[delayKey]) item.collectionMap[delayKey] = 0;
 const tdDel = document.createElement('td');
 tdDel.style.cssText = 'padding:3px 6px;border:1px solid #e0e0e0;background:#fff';
 const delInp = document.createElement('input'); delInp.type='number'; delInp.min=0; delInp.step=30;
 delInp.value = item.collectionMap[delayKey] || 0;
 delInp.style.cssText = 'width:54px;font-size:11px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;text-align:center';
 delInp.title = 'Days after cut until cash received';
 delInp.addEventListener('input', () => { item.collectionMap['delay_' + payMo] = parseInt(delInp.value)||0; });
 tdDel.appendChild(delInp);
 tr.appendChild(tdDel);

 // Accrual month toggle cells
 months.forEach(m => {
 const td = document.createElement('td');
 const isSel = (accrualMos || []).includes(m);
 td.style.cssText = 'padding:0;border:1px solid #e0e0e0;text-align:center;width:46px;cursor:pointer;transition:background .1s;'
 + (isSel ? 'background:var(--accent)' : 'background:#fff');
 td.title = 'Click to toggle: Accrual M' + m + ' paid in M' + payMo;

 const dot = document.createElement('div');
 dot.style.cssText = 'height:28px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;'
 + (isSel ? 'color:#fff' : 'color:#ccc');
 dot.textContent = isSel ? '' : '·';

 td.appendChild(dot);
 td.addEventListener('click', () => {
 const arr = item.collectionMap[payMo] || [];
 item.collectionMap[payMo] = arr; // ensure stored
 const idx = arr.indexOf(m);
 if (idx >= 0) arr.splice(idx, 1); else arr.push(m);
 item.collectionMap[payMo] = arr;
 const nowSel = arr.includes(m);
 td.style.background = nowSel ? '#0176D3' : '#fff';
 dot.style.color = nowSel ? '#fff' : '#ccc';
 dot.textContent = nowSel ? '' : '·';
 });
 tr.appendChild(td);
 });

 // Remove row button
 const tdRm = document.createElement('td');
 tdRm.style.cssText = 'padding:3px 6px;border:1px solid #e0e0e0;background:#fff';
 const rmBtn = document.createElement('button');
 rmBtn.textContent = '×'; rmBtn.style.cssText = 'background:none;border:none;color:#999;font-size:14px;cursor:pointer;padding:0';
 rmBtn.addEventListener('click', () => {
 delete item.collectionMap[payMo];
 delete item.collectionMap['delay_' + payMo];
 buildCollectionGrid();
 });
 tdRm.appendChild(rmBtn); tr.appendChild(tdRm);
 tbody.appendChild(tr);
 });
 tbl.appendChild(tbody);
 gridWrap.appendChild(tbl);

 // Summary
 const sumEl = document.createElement('div');
 sumEl.style.cssText = 'font-size:10px;color:var(--muted);margin-top:6px;line-height:1.8';
 const parts = payEntries.map(([pm2, mos]) => {
 const delay = parseInt(item.collectionMap['delay_' + pm2]) || 0;
 const cashM = Math.min(pm2 + Math.round(delay/30), PM());
 const mosList = Array.isArray(mos) ? mos : [];
 return '<strong>M' + pm2 + '</strong>: collects [' + mosList.map(m=>'M'+m).join(', ') + ']' + (delay ? '  cash M'+cashM : '');
 });
 sumEl.innerHTML = ' ' + parts.join(' &nbsp;|&nbsp; ');

 // Show uncovered accrual months
 const allMapped = new Set();
 payEntries.forEach(([pm2, mos]) => (mos||[]).forEach(m => allMapped.add(m)));
 const uncovered = AMs().filter(m => !allMapped.has(m));
 if (uncovered.length) {
 const warnEl = document.createElement('div');
 warnEl.style.cssText = 'margin-top:4px;font-size:10px;color:#A56105;';
 warnEl.innerHTML = ' Accrual months not yet assigned to any payment: '
 + uncovered.map(m => '<strong>M' + m + '</strong>').join(', ')
 + '  -  these will flow as accrual = cash.';
 gridWrap.appendChild(warnEl);
 } else {
 const okEl = document.createElement('div');
 okEl.style.cssText = 'margin-top:4px;font-size:10px;color:#2E844A;font-weight:600';
 okEl.textContent = ' All accrual months are assigned to a payment.';
 gridWrap.appendChild(okEl);
 }
 gridWrap.appendChild(sumEl);
 }

 addPayBtn.addEventListener('click', () => {
 // Find a month not yet used as payment month (exclude delay_ meta-keys)
 const used = new Set(
 Object.keys(item.collectionMap)
 .filter(k => !k.startsWith('delay_') && /^\d+$/.test(k))
 .map(Number)
 );
 const next = AMs().find(m => !used.has(m)) || PM();
 item.collectionMap[next] = [];
 buildCollectionGrid();
 });

 buildCollectionGrid();
 body.appendChild(bsWrap);
 }

 /* ---- reference / source section ---- */
 const refSec = document.createElement('div'); refSec.className = 'ref-section';

 const refNoteLbl = document.createElement('label'); refNoteLbl.textContent = ' Reference / Notes';
 const refNoteInp = document.createElement('input'); refNoteInp.type = 'text';
 refNoteInp.placeholder = 'e.g. Cotización Ferreyros #2024-001, Contrato Marco ABC&';
 refNoteInp.value = item.refNote || '';
 refSec.appendChild(refNoteLbl); refSec.appendChild(refNoteInp);

 const refUrlLbl = document.createElement('label'); refUrlLbl.textContent = ' Backup Link (URL)';
 refUrlLbl.style.marginTop = '8px';
 const refUrlRow = document.createElement('div'); refUrlRow.className = 'ref-url-row';
 const refUrlInp = document.createElement('input'); refUrlInp.type = 'url';
 refUrlInp.placeholder = 'https://drive.google.com/&';
 refUrlInp.value = item.refUrl || '';
 const refOpenBtn = document.createElement('a'); refOpenBtn.className = 'ref-open-btn';
 refOpenBtn.textContent = ' Open'; refOpenBtn.target = '_blank'; refOpenBtn.rel = 'noopener';
 refOpenBtn.href = item.refUrl || '#';
 refOpenBtn.style.display = item.refUrl ? 'inline-flex' : 'none';
 refUrlRow.appendChild(refUrlInp); refUrlRow.appendChild(refOpenBtn);
 refSec.appendChild(refUrlLbl); refSec.appendChild(refUrlRow);
 body.appendChild(refSec);

 /* ---- distribution header ---- */
 // Section label separating accrual grid from collection schedule
 if (!isCost) {
 const accrualLbl = document.createElement('div');
 accrualLbl.style.cssText = 'margin-top:16px;padding:8px 12px;background:linear-gradient(90deg,#e8f4fd,#f8fafc);border-left:3px solid var(--blue);border-radius:0 6px 6px 0;font-size:11px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.06em';
 accrualLbl.textContent = ' Accrual Schedule  -  when revenue is recognized (P&L)';
 body.appendChild(accrualLbl);
 }
 const distHdr = document.createElement('div'); distHdr.className = 'dist-header';
 const distLbl = document.createElement('div'); distLbl.style.cssText = 'font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em';
 const distAmt = document.createElement('div'); distAmt.style.cssText = 'font-size:11px;color:var(--muted)';
 distHdr.appendChild(distLbl); distHdr.appendChild(distAmt);
 body.appendChild(distHdr);

 // Paste hint
 const pasteHint = document.createElement('div');
 pasteHint.style.cssText = 'font-size:10px;color:#888;margin-bottom:6px;display:flex;align-items:center;gap:6px';
 const kb = t => `<span style="background:#e8f4fd;color:#0176D3;padding:1px 6px;border-radius:3px;font-weight:700;font-family:monospace;font-size:10px">${t}</span>`;
 pasteHint.innerHTML = kb('Click+Drag') + ' Select range &nbsp;·&nbsp; '
 + kb('Shift+Click') + ' Extend selection &nbsp;·&nbsp; '
 + kb('Ctrl+V') + ' Paste from Excel &nbsp;·&nbsp; '
 + kb('Del') + ' Clear &nbsp;·&nbsp; '
 + kb('Tab/') + ' Navigate'
 + '<br><span style="font-size:9px;color:#aaa;margin-top:2px;display:block">'
 + ' Formula refs: <code>50% of Internet</code> &nbsp;·&nbsp; <code>Internet * 0.5</code> &nbsp;·&nbsp; <code>Internet * 0.3 + Equipos * 0.2</code></span>';
 body.appendChild(pasteHint);

 const pbar = document.createElement('div'); pbar.className = 'pbar';
 const pfill = document.createElement('div'); pfill.className = 'pfill';
 pbar.appendChild(pfill); body.appendChild(pbar);

 /* ---- month / year grids ---- */
 for (let yi = 0; yi < nY; yi++) {
 const yms = AMs().filter(m => m > yi*12 && m <= (yi+1)*12);
 const { year } = mInfo(yms[0]);

 const yg = document.createElement('div'); yg.style.marginBottom = '12px';
 const yTop = document.createElement('div'); yTop.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
 const badge = document.createElement('span'); badge.className = 'yr-badge'; badge.textContent = year;
 const yPct = document.createElement('span'); yPct.style.cssText = 'font-size:11px;color:var(--muted)'; yPct.dataset.yi = yi;
 yTop.appendChild(badge); yTop.appendChild(yPct); yg.appendChild(yTop);

 const mg = document.createElement('div'); mg.className = 'mo-grid';
 mg.style.gridTemplateColumns = `repeat(${yms.length},1fr)`;
 yms.forEach(m => {
 const cell = document.createElement('div'); cell.className = 'mo-cell';
 const lbl = document.createElement('div'); lbl.className = 'mo-lbl';
 const mi2 = mInfo(m);
 lbl.innerHTML = '<span style="color:var(--muted);font-size:8px;display:block">' + mi2.short + ' ' + String(mi2.year).slice(2) + '</span>'
 + '<span style="color:var(--blue);font-weight:700;font-size:9px">(M'+m+')</span>';
 const moInp = document.createElement('input');
 moInp.type = 'text'; moInp.placeholder = '0';
 moInp.value = (item.mos && item.mos[m]) ? item.mos[m] : '';
 moInp.dataset.m = m;
 const amtEl2 = document.createElement('div'); amtEl2.className = 'mo-amt'; amtEl2.dataset.ma = m;
 cell.appendChild(lbl); cell.appendChild(moInp); cell.appendChild(amtEl2);
 mg.appendChild(cell);
 });
 yg.appendChild(mg);
 body.appendChild(yg);
 }

 /* ---- refresh (no full re-render) ---- */
 function refresh() {
 const base = getBase(item);
 const p = itemPctTotal(item);
 const ok = Math.abs(p - 100) < 0.01;

 let pc, statusMsg, borderColor;
 if (item.progMode && item.progMonthly) {
 // Progressive mode: valid states are 0 - 100% in Phase 1
 if (ok) {
 pc = '#2E844A'; statusMsg = ''; borderColor = '#DDDBDA';
 } else if (p > 0 && p < 100) {
 pc = '#A56105';
 statusMsg = ' <span style="color:#A56105;font-weight:400">(set a month to 100% to activate full payment)</span>';
 borderColor = '#DDDBDA';
 } else {
 pc = '#706E6B'; statusMsg = ''; borderColor = '#DDDBDA';
 }
 distLbl.innerHTML = 'Phase 1 Advance  -  <span style="color:' + pc + '">' + p.toFixed(1).replace(/\.?0+$/, '') + '% progress</span>' + statusMsg;
 } else {
 pc = ok ? '#2E844A' : p > 100 ? '#BA0517' : p > 0 ? '#A56105' : '#706E6B';
 borderColor = p > 100 ? '#BA0517' : '#DDDBDA';
 distLbl.innerHTML = 'Monthly Distribution  -  <span style="color:' + pc + '">' + p.toFixed(4).replace(/\.?0+$/, '') + '% allocated</span>'
 + (p > 0 && !ok && p <= 100 ? ' <span style="color:#A56105;font-weight:400">(must reach 100%)</span>' : '')
 + (p > 100 ? ' <span style="color:#BA0517;font-weight:400">(exceeds 100%  -  error)</span>' : '');
 }
 distAmt.innerHTML = 'Base (USD): <strong>' + fmt(base) + '</strong>';
 pfill.style.width = Math.min(p, 100) + '%';
 pfill.style.background = pc;
 wrap.style.borderColor = borderColor;

 const advPct = parseFloat(item.adv) || 0;
 const rest = base * (1 - advPct / 100);
 AMs().forEach(m => {
 const v = evalPct((item.mos || {})[m]) || 0;
 const el = body.querySelector('[data-ma="' + m + '"]');
 if (el) { const a = v/100*rest; el.textContent = a===0?'':a.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
 });
 for (let yi = 0; yi < nY; yi++) {
 const yms = AMs().filter(m => m > yi*12 && m <= (yi+1)*12);
 const yp = yms.reduce((s, m) => s + (evalPct((item.mos || {})[m]) || 0), 0);
 const sp = body.querySelector('[data-yi="' + yi + '"]');
 if (sp) sp.textContent = yp.toFixed(4).replace(/\.?0+$/, '') + '% this year';
 }
 titleEl.textContent = item.name || ('Item ' + (idx + 1));
 subEl.textContent = item.amount
 ? (item.cur + ' ' + _toNumber(item.amount).toLocaleString() + (item.igv ? ' (afecto IGV)' : ''))
 : '';

 // Update collapsed summary line
 const sumParts = [];
 if (item.amount) sumParts.push(item.cur + ' ' + _toNumber(item.amount).toLocaleString());
 if (item.cat) sumParts.push(item.cat);
 if (isCost && item.payCond) sumParts.push(item.payCond + 'd cond.');
 if (!isCost && item.cat) sumParts.push(item.cat);
 const allocPct = p.toFixed(1);
 sumParts.push(allocPct + '% allocated');
 const allocColor = ok ? '#57D9A3' : p > 0 ? '#FFDE7A' : '#FF9A9A';
 summaryEl.innerHTML = sumParts.slice(0, -1).map(t => `<span style="opacity:.7">${t}</span>`).join(' · ')
 + ` · <span style="color:${allocColor};font-weight:700">${allocPct}% alloc.</span>`;
 }

 /* ---- wire events ---- */
 nameEl.addEventListener('input', () => { item.name = nameEl.value; refresh(); });
 amtEl .addEventListener('input', () => { item.amount = amtEl.value; refresh(); });
 curEl .addEventListener('change',() => { item.cur = curEl.value; refresh(); });

 if (isCost) {
 catEl .addEventListener('input', () => { item.cat = catEl.value; });
 payCondEl.addEventListener('input', () => { item.payCond= payCondEl.value;});
 advEl .addEventListener('input', () => { item.adv = advEl.value; refresh(); });
 advMoEl .addEventListener('change',() => { item.advMo = parseInt(advMoEl.value); refresh(); });
 } else {
 catEl.addEventListener('input', () => { item.cat = catEl.value; });
 }

 igvChk.addEventListener('change', () => { item.igv = igvChk.checked; refresh(); });

 refNoteInp.addEventListener('input', () => { item.refNote = refNoteInp.value; updateRefBadge(); });
 refUrlInp.addEventListener('input', () => {
 item.refUrl = refUrlInp.value;
 refOpenBtn.href = refUrlInp.value || '#';
 refOpenBtn.style.display = refUrlInp.value ? 'inline-flex' : 'none';
 updateRefBadge();
 });

 // 
 // EXCEL-LIKE GRID  -  drag select, paste, keyboard nav
 // 
 const allCells = () => Array.from(body.querySelectorAll('.mo-cell'));
 const allInputs = () => Array.from(body.querySelectorAll('input[data-m]'));

 let anchorCell = null; // where drag/selection started
 let isDragging = false;

 //  Selection helpers 
 function getSelRange() {
 return Array.from(body.querySelectorAll('.mo-cell.sel-range, .mo-cell.sel-anchor'));
 }
 function clearSel() {
 body.querySelectorAll('.mo-cell.sel-range, .mo-cell.sel-anchor')
 .forEach(c => { c.classList.remove('sel-range','sel-anchor'); });
 }
 function applySelRange(from, to) {
 clearSel();
 const cells = allCells();
 const a = cells.indexOf(from);
 const b = cells.indexOf(to);
 if (a < 0 || b < 0) return;
 const lo = Math.min(a, b), hi = Math.max(a, b);
 cells.forEach((c, i) => {
 if (i >= lo && i <= hi) {
 c.classList.add(i === a ? 'sel-anchor' : 'sel-range');
 }
 });
 }

 //  Clean value from Excel paste 
 function cleanPasteVal(raw) {
 return raw.trim()
 .replace(/%/g, '')
 .replace(/\s/g, '')
 .replace(/,(?=\d{1,2}($|\t|\n))/g, '.');
 }

 //  Paste logic 
 function applyPaste(rawText, startCell) {
 const pasteRows = rawText.trim().split(/\r?\n/).map(r => r.split('\t'));
 const flat = pasteRows.flat();
 const pasteCells = allCells();
 const selected = getSelRange();
 if (!item.mos) item.mos = {};

 // If a range is selected and paste has ONE value  fill entire selection
 let targets = [];
 if (selected.length > 1 && flat.length === 1) {
 targets = selected;
 } else if (selected.length > 1 && flat.length === selected.length) {
 // Exact match  fill selection in order
 targets = selected;
 } else {
 // Default: start from anchor/startCell, fill linearly
 const si = pasteCells.indexOf(startCell || anchorCell || pasteCells[0]);
 targets = pasteCells.slice(Math.max(0, si), si + flat.length);
 }

 let count = 0;
 targets.forEach((cell, i) => {
 const inp = cell.querySelector('input[data-m]');
 if (!inp) return;
 const val = flat.length === 1 ? flat[0] : (flat[i] || '');
 const cleaned = cleanPasteVal(val);
 const m = parseInt(inp.dataset.m);
 inp.value = cleaned;
 item.mos[m] = cleaned;
 inp.classList.remove('pasted');
 void inp.offsetWidth;
 inp.classList.add('pasted');
 setTimeout(() => inp.classList.remove('pasted'), 600);
 count++;
 });

 refresh();
 showPasteToast(count + ' cell' + (count !== 1 ? 's' : '') + ' filled');
 return count;
 }

 //  Mouse events: drag to select 
 allCells().forEach(cell => {
 const cellInp = cell.querySelector('input[data-m]');
 if (!cellInp) return;

 // mousedown: start selection
 cell.addEventListener('mousedown', e => {
 if (e.button !== 0) return;
 isDragging = true;

 if (e.shiftKey && anchorCell) {
 // Extend selection
 applySelRange(anchorCell, cell);
 } else {
 // New selection
 clearSel();
 anchorCell = cell;
 cell.classList.add('sel-anchor');
 // Don't focus immediately  -  let mouseup decide if it's a drag or click
 }
 e.preventDefault(); // prevent text selection
 });

 // mouseenter while dragging: extend selection
 cell.addEventListener('mouseenter', e => {
 if (!isDragging || !anchorCell) return;
 applySelRange(anchorCell, cell);
 });

 // Standard input  save + progressive auto-complete if active
 cellInp.addEventListener('input', () => {
 if (!item.mos) item.mos = {};
 const m = parseInt(cellInp.dataset.m);
 item.mos[m] = cellInp.value;

 if (item.progMode) {
 const pct = evalPct(cellInp.value) || 0;
 if (pct >= 99.99) {
 // 100% entered  clear all future month inputs (getDistArr will auto-fill them as full)
 AMs().forEach(fm => {
 if (fm > m) {
 item.mos[fm] = '';
 const finp = body.querySelector('input[data-m="' + fm + '"]');
 if (finp) finp.value = '';
 }
 });
 showPasteToast(' Full payment auto-starts from M' + m + ' onwards');
 }
 // Update progressive preview (defined in outer scope of this card)
 const prevEl = body.querySelector('.prog-preview');
 if (prevEl) prevEl.dispatchEvent(new Event('update'));
 }
 refresh();
 });

 // Focus  mark anchor if no selection
 cellInp.addEventListener('focus', () => {
 const hasRange = body.querySelectorAll('.mo-cell.sel-range, .mo-cell.sel-anchor').length > 1;
 if (!hasRange) {
 clearSel();
 anchorCell = cell;
 cell.classList.add('sel-anchor');
 }
 });

 //  Keyboard navigation 
 cellInp.addEventListener('keydown', e => {
 const inputs = allInputs();
 const cells = allCells();
 const ci = inputs.indexOf(cellInp);
 let next = -1;

 if (e.key === 'Tab') {
 e.preventDefault();
 clearSel(); next = e.shiftKey ? ci - 1 : ci + 1;
 } else if (e.key === 'Enter') {
 e.preventDefault();
 clearSel(); next = e.shiftKey ? ci - 1 : ci + 1;
 } else if (e.key === 'ArrowRight' && cellInp.selectionStart === cellInp.value.length) {
 e.preventDefault(); clearSel(); next = ci + 1;
 } else if (e.key === 'ArrowLeft' && cellInp.selectionStart === 0) {
 e.preventDefault(); clearSel(); next = ci - 1;
 } else if (e.key === 'ArrowDown') {
 e.preventDefault(); clearSel(); next = Math.min(ci + 12, inputs.length - 1);
 } else if (e.key === 'ArrowUp') {
 e.preventDefault(); clearSel(); next = Math.max(ci - 12, 0);
 } else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.value) {
 // Delete selected range
 const kbSel = getSelRange();
 if (kbSel.length > 1) {
 e.preventDefault();
 kbSel.forEach(c => {
 const i2 = c.querySelector('input[data-m]');
 if (!i2) return;
 i2.value = '';
 if (item.mos) item.mos[parseInt(i2.dataset.m)] = '';
 });
 refresh();
 showPasteToast('Cleared ' + kbSel.length + ' cells');
 }
 }

 if (next >= 0 && next < inputs.length) {
 anchorCell = cells[next];
 clearSel();
 cells[next].classList.add('sel-anchor');
 inputs[next].focus();
 inputs[next].select();
 }
 });

 //  Paste 
 cellInp.addEventListener('paste', e => {
 e.preventDefault();
 const raw = (e.clipboardData || window.clipboardData).getData('text');
 if (raw) applyPaste(raw, cell);
 });
 });

 // mouseup anywhere: end drag
 document.addEventListener('mouseup', () => { isDragging = false; }, { passive: true });

 // Click on cell (not drag): focus its input
 body.addEventListener('click', e => {
 const cell = e.target.closest('.mo-cell');
 if (!cell) return;
 const inp2 = cell.querySelector('input[data-m]');
 if (inp2 && document.activeElement !== inp2) {
 inp2.focus();
 inp2.select();
 }
 });

 //  Paste toast notification 
 function showPasteToast(msg) {
 let toast = document.getElementById('paste-toast');
 if (!toast) {
 toast = document.createElement('div');
 toast.id = 'paste-toast';
 toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#032D60;color:#fff;'
 + 'padding:10px 18px;border-radius:6px;font-size:12px;font-weight:600;z-index:9999;'
 + 'pointer-events:none;opacity:0;transition:opacity .2s;box-shadow:0 4px 12px rgba(0,0,0,.25)';
 document.body.appendChild(toast);
 }
 toast.textContent = ' ' + msg;
 toast.style.opacity = '1';
 clearTimeout(toast._t);
 toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 2200);
 }

 removeBtn.addEventListener('click', () => {
 setList(type, getList(type).filter(it => it.id !== item.id));
 renderList(type);
 });

 refresh();
 return wrap;
}

//  ADJUSTMENTS 
const mkCustomLine = () => ({
 id: uid(),
 name: '',
 formula: '', // e.g. "totalIncome * 0.02" or "Internet * 0.5 + Labor * 0.3"
 section: 'after_gross_profit', // where to insert in P&L
 sign: 'subtract', // 'add' | 'subtract'
 color: 'amber',
 showInCF: true,
 note: ''
});

const mkAdj = () => ({
 id: uid(), name: 'New Adjustment', pct: '', sign: 'subtract', side: 'cost', targets: [],
 distMode: 'auto', // 'auto' = follow targets timing | 'manual' = user-defined monthly %
 mos: {} // monthly % for manual distribution
});

//  LOGO UPLOAD (shared across portfolio + project screens) 
(function() {
 // Shared file input
 const inp = document.getElementById('logo-input');

 function applyLogo(dataUrl) {
 // Portfolio logo
 const portImg = document.getElementById('logo-img');
 const portDef = document.getElementById('logo-default');
 if (portImg) { portImg.src = dataUrl; portImg.style.display = 'block'; }
 if (portDef) portDef.style.display = 'none';
 // Project header logo
 const projImg = document.getElementById('proj-logo-img');
 const projDef = document.getElementById('proj-logo-default');
 if (projImg) { projImg.src = dataUrl; projImg.style.display = 'block'; }
 if (projDef) projDef.style.display = 'none';
 localStorage.setItem('fm_logo', dataUrl);
 }

 // Restore saved logo on load
 const saved = localStorage.getItem('fm_logo');
 if (saved) applyLogo(saved);

 // Both logo elements trigger the same file input
 ['logo-wrap','proj-logo-wrap'].forEach(id => {
 const el = document.getElementById(id);
 if (el) el.addEventListener('click', () => inp && inp.click());
 });

 if (inp) inp.addEventListener('change', () => {
 const file = inp.files[0];
 if (!file) return;
 const reader = new FileReader();
 reader.onload = e => applyLogo(e.target.result);
 reader.readAsDataURL(file);
 });
})();

//  FORMULA REFERENCE PANEL 
// Formulas that can be customized  -  stored in localStorage
const FORMULA_DEFAULTS = [
 {
 id: 'hedging',
 section: 'P&L Calculations',
 name: 'Hedging Adjustment',
 badge: 'Monthly Fixed',
 desc: 'Net FX exposure (Revenue in PEN minus PEN costs) converted back to USD, spread evenly across all months.',
 // Excel-style formula  -  variables available each month (m = month index 0-based)
 // Available: revTotalPEN, costTotalPEN, fx, pm, hedgingMonthly
 excelFormula: '=(revTotalPEN - costTotalPEN) / fx / pm',
 note: 'revTotalPEN = total revenue × FX | costTotalPEN = sum of PEN-denominated costs | fx = FX rate | pm = months'
 },
 {
 id: 'financing_cost',
 section: 'P&L Calculations',
 name: 'Financing Cost',
 badge: 'Monthly on neg. CF',
 desc: 'Monthly interest on the negative accumulated cash flow balance from the previous month.',
 // Available per month: prevAccum (accumulated CF of previous month), finMonthlyRate, m (0-based index)
 excelFormula: '=IF(prevAccum < 0, ABS(prevAccum) * finMonthlyRate, 0)',
 note: 'prevAccum = AccumCF[m-1] | finMonthlyRate = Financing Rate / 100 (set in Settings)'
 },
 {
 id: 'contingency',
 section: 'P&L Calculations',
 name: 'Contingency',
 badge: '% of COGS',
 desc: 'Reserve calculated as a percentage of total COGS each month.',
 // Available: baseCogs_m (COGS that month), conPct = CFG.con/100
 excelFormula: '=baseCogs_m * conPct',
 note: 'baseCogs_m = total cost of goods sold that month | conPct = Contingency% / 100'
 },
 {
 id: 'opex_buffer',
 section: 'P&L Calculations',
 name: 'OPEX Buffer',
 badge: '% of Revenue',
 desc: 'Monthly operating expense buffer, calculated as a percentage of net revenue.',
 // Available: totalIncome_m (revenue that month), opxBufPct = CFG.opxbuf/100
 excelFormula: '=ABS(totalIncome_m) * opxBufPct',
 note: 'totalIncome_m = total revenue that month | opxBufPct = OPEX Buffer% / 100'
 },
 {
 id: 'cb_fee',
 section: 'Bond Fees',
 name: 'Compliance Bond Fee',
 badge: 'Fixed Monthly',
 desc: 'Monthly cost of the compliance bond.',
 // Available: totalRevenue (sum all months), fcb = CFG.fcb/100, fcbCost = CFG.fcbCost/100, IGV
 excelFormula: '=totalRevenue * fcb * (1 + IGV) * fcbCost',
 note: 'totalRevenue = sum of all revenue | fcb = CB% / 100 | fcbCost = CB Cost/Month% / 100'
 },
 {
 id: 'ub_fee',
 section: 'Bond Fees',
 name: 'Upfront Bond Fee',
 badge: 'Fixed Monthly',
 desc: 'Monthly cost of the upfront bond spread evenly.',
 // Available: totalRevenue, fub = CFG.fub/100, pm
 excelFormula: '=totalRevenue * fub / pm',
 note: 'totalRevenue = sum of all revenue | fub = UB% / 100 | pm = total months'
 },
];

// Excel-style IF helper used in formula evaluation
function IF(cond, a, b) { return cond ? a : b; }
function ABS(v) { return Math.abs(v); }
function MAX(...args) { return Math.max(...args); }
function MIN(...args) { return Math.min(...args); }
function SUM(...args) { return args.reduce((s,v)=>s+(isNaN(v)?0:v),0); }


// Load any custom overrides from localStorage
let formulaOverrides = {};
try { formulaOverrides = JSON.parse(localStorage.getItem('fm_formula_overrides') || '{}'); } catch(e) {}

function renderFormulaPanel() {
 const container = document.getElementById('formula-list');
 if (!container) return;

 let cv;
 try { cv = compute(); } catch(e) { cv = null; }

 function liveVal(id) {
 if (!cv) return null;
 const f2 = v => isNaN(v)||!isFinite(v) ? '0.00' : '$' + fmt(v);
 switch(id) {
 case 'hedging': return { label:'Monthly', value: f2(cv.hedgingArr[0]||0) };
 case 'financing_cost': return { label:'Total', value: f2(rSum(cv.finCostArr||Z())) };
 case 'contingency': return { label:'Total', value: f2(rSum(cv.costCat['Contingency']||Z())) };
 case 'opex_buffer': return { label:'Total', value: f2(rSum(cv.opexBuffer||Z())) };
 case 'cb_fee': return { label:'Monthly', value: f2((cv.finExpCB||Z())[0]||0) };
 case 'ub_fee': return { label:'Monthly', value: f2((cv.finExpUB||Z())[0]||0) };
 default: return null;
 }
 }

 // Group by section
 const sections = {};
 FORMULA_DEFAULTS.forEach(f => {
 if (!sections[f.section]) sections[f.section] = [];
 sections[f.section].push(f);
 });

 let html = '';
 Object.entries(sections).forEach(([sec, items]) => {
 html += `<div style="margin-bottom:24px">
 <div class="formula-sec-hdr">${sec}</div>
 <div class="formula-panel">`;

 items.forEach(f => {
 const overrideExpr = formulaOverrides['expr_' + f.id] || '';
 const activeExpr = overrideExpr || f.excelFormula;
 const isModified = !!overrideExpr;
 const live = liveVal(f.id);
 const liveHtml = live
 ? `<span style="background:#e8f7ec;border:1px solid #b8e0c8;color:#2d6a4f;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;margin-left:6px">${live.label}: ${live.value}</span>`
 : '';

 html += `<div class="formula-item" id="fitem-${f.id}">
 <div class="formula-name" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
 <span style="font-weight:700;color:var(--navy)">${f.name}</span>
 <span class="formula-badge">${f.badge}</span>
 ${isModified ? '<span style="background:#fef9ee;border:1px solid #f0c060;color:#7a5c2e;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700"> MODIFIED</span>' : ''}
 ${liveHtml}
 </div>
 <div style="font-size:11px;color:var(--sub);margin:4px 0 10px;line-height:1.5">${f.desc}</div>

 <!-- Excel-style formula bar -->
 <div style="border:2px solid ${isModified?'#f0a030':'var(--bdr2)'};border-radius:6px;overflow:hidden;background:#fff">
 <!-- Top bar: label + formula input -->
 <div style="display:flex;align-items:stretch;border-bottom:1px solid var(--bdr)">
 <div style="background:#f0f0ed;padding:6px 10px;font-size:11px;font-weight:700;color:var(--sub);display:flex;align-items:center;border-right:1px solid var(--bdr);white-space:nowrap;min-width:24px">
 x
 </div>
 <input
 id="fbar-${f.id}"
 type="text"
 value="${activeExpr.replace(/"/g,'&quot;')}"
 style="flex:1;border:none;outline:none;padding:7px 10px;font-family:'Courier New',monospace;font-size:12px;background:#fff;color:var(--navy)"
 spellcheck="false"
 placeholder="= formula..."
 onkeydown="if(event.key==='Enter'){_saveFormulaExpr('${f.id}');this.blur();}if(event.key==='Escape'){this.value=${JSON.stringify(activeExpr)};this.blur();}"
 oninput="_livePreviewFormula('${f.id}', this.value)"
 onfocus="this.parentElement.parentElement.style.borderColor='var(--accent)'"
 onblur="this.parentElement.parentElement.style.borderColor='${isModified?'#f0a030':'var(--bdr2)'}'"
 >
 <button onclick="_saveFormulaExpr('${f.id}')"
 style="background:var(--accent);color:#fff;border:none;padding:0 14px;cursor:pointer;font-size:11px;font-weight:700;white-space:nowrap">
  Apply
 </button>
 ${isModified ? `<button onclick="_resetFormulaExpr('${f.id}')"
 style="background:#fff;color:var(--sub);border:none;border-left:1px solid var(--bdr);padding:0 10px;cursor:pointer;font-size:10px;white-space:nowrap">
  Reset
 </button>` : ''}
 </div>
 <!-- Live preview row -->
 <div id="fprev-${f.id}" style="padding:6px 12px;font-size:10px;color:var(--sub);background:#fafaf8;min-height:28px;font-family:'Courier New',monospace">
 ${liveHtml ? 'Current value: ' + live.value : 'Enter a formula above and press Enter or  Apply'}
 </div>
 </div>

 <!-- Variable reference -->
 <details style="margin-top:8px">
 <summary style="font-size:10px;color:var(--accent);cursor:pointer;font-weight:600"> Available variables for this formula</summary>
 <div style="margin-top:6px;padding:10px;background:var(--alt);border-radius:6px;font-size:10px;line-height:2;font-family:'Courier New',monospace;color:var(--navy)">
 ${f.note}
 </div>
 </details>
 </div>`;
 });
 html += '</div></div>';
 });

 // Live parameters card
 if (cv) {
 const mRate = ((Math.pow(1 + CFG.dis/100, 1/12) - 1) * 100).toFixed(4);
 html += `<div style="margin-bottom:24px">
 <div class="formula-sec-hdr">Current Project Parameters</div>
 <div class="formula-panel">
 <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;padding:4px">
 ${[
 ['FX Rate', '1 USD = ' + CFG.fx + ' PEN'],
 ['Project Months', PM() + ' months'],
 ['Discount Rate', CFG.dis + '% p.a.'],
 ['Monthly Rate', mRate + '%'],
 ['Contingency', CFG.con + '%'],
 ['OPEX Buffer', (CFG.opxbuf||30) + '%'],
 ['Financing Rate', (CFG.finRate||0) + '% /mo'],
 ['Total Revenue', '$' + fmt(rSum(cv.totalIncome))],
 ['Total COGS', '$' + fmt(rSum(cv.totalCogsAdj))],
 ['Gross Profit', '$' + fmt(rSum(cv.grossProfit))],
 ['EBIT', '$' + fmt(rSum(cv.ebit))],
 ['NPV', '$' + fmt(cv.npvCF)],
 ].map(([k,v])=>`<div style="background:#f3f3f0;border-radius:5px;padding:8px 10px">
 <div style="font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">${k}</div>
 <div style="font-size:12px;font-weight:700;color:var(--navy)">${v}</div>
 </div>`).join('')}
 </div>
 </div>
 </div>`;
 }

 container.innerHTML = html;
}

function _evalFormulaForId(fid, expr, cv) {
 // Returns an array of monthly values by evaluating expr in the context of each formula
 const pm = PM();
 if (!pm) return null;

 // Prepare shared values
 const revTotalPEN = rSum(cv.totalIncome) * CFG.fx;
 const costTotalPEN = [...capex, ...opex].filter(it=>it.cur==='PEN').reduce((s,it)=>s+_toNumber(it.amount),0);
 const finMonthlyRate = (CFG.finRate||0)/100;
 const totalRevenue = rSum(cv.totalIncome);
 const conPct = (CFG.con||0)/100;
 const opxBufPct = (CFG.opxbuf||30)/100;
 const fcb = (CFG.fcb||0)/100;
 const fub = (CFG.fub||0)/100;
 const fcbCost = (CFG.fcbCost||0)/100;
 const pm_v = pm;
 const fx = CFG.fx;

 // Sanitize expr: remove leading = if present
 const rawExpr = expr.trim().replace(/^=/, '');

 // Evaluate per-month context
 let accumCF = 0;
 return AMs().map((month, mi) => {
 const baseCogs_m = (Object.values(cv.costCat||{}).reduce((s,a)=>s+(a[mi]||0),0));
 const totalIncome_m = cv.totalIncome[mi] || 0;
 const prevAccum = mi === 0 ? 0 : (cv.accumCF[mi-1]||0);

 const ctx = {
 m: mi, month,
 revTotalPEN, costTotalPEN, finMonthlyRate,
 totalRevenue, conPct, opxBufPct,
 fcb, fub, fcbCost, fx, pm: pm_v,
 baseCogs_m, totalIncome_m, prevAccum,
 IGV: 0.18,
 totalIncome: cv.totalIncome[mi]||0,
 totalCogs: (cv.totalCogsAdj||Z())[mi]||0,
 grossProfit: (cv.grossProfit||Z())[mi]||0,
 opexBuffer: (cv.opexBuffer||Z())[mi]||0,
 hedging: (cv.hedgingArr||Z())[mi]||0,
 finCost: (cv.finCostArr||Z())[mi]||0,
 accumCF_m: (cv.accumCF||Z())[mi]||0,
 };

 let exprReplaced = rawExpr;
 Object.keys(ctx).sort((a,b)=>b.length-a.length).forEach(k => {
 exprReplaced = exprReplaced.replace(
 new RegExp('(?<![a-zA-Z0-9_])' + k.replace(/[[\]]/g,'\\$&') + '(?![a-zA-Z0-9_])', 'g'),
 String(ctx[k])
 );
 });
 // Excel-style IF
 exprReplaced = exprReplaced.replace(/IF\s*\(/gi, 'IF(');
 const v = Function('"use strict";var IF='+IF+';var ABS=Math.abs;var MAX=Math.max;var MIN=Math.min;return (' + exprReplaced + ')')();
 return isFinite(v) ? v : 0;
 });
}

function _livePreviewFormula(fid, expr) {
 const prev = document.getElementById('fprev-' + fid);
 if (!prev) return;
 if (!expr.trim()) { prev.textContent = 'Enter a formula above&'; return; }
 try {
 const cv = compute();
 const results = _evalFormulaForId(fid, expr, cv);
 if (!results) { prev.textContent = 'Formula evaluated  -  press  Apply to save'; return; }
 const samples = results.slice(0, Math.min(6, PM()))
 .map((v, i) => `M${i+1}: $${fmt(v)}`)
 .join(' · ');
 const total = rSum(results);
 prev.innerHTML = `<span style="color:var(--teal);font-weight:700">${samples}</span> <span style="color:var(--navy);margin-left:8px">Total: $${fmt(total)}</span>`;
 } catch(e) {
 prev.innerHTML = `<span style="color:var(--red)"> ${e.message}</span>`;
 }
}


//  INLINE FORMULA EDITOR FUNCTIONS 
function _openFormulaEditor(fid) {
 // Close any other open editors first
 document.querySelectorAll('.formula-inline-editor.open').forEach(el => {
 if (el.id !== 'fie-' + fid) el.classList.remove('open');
 });
 const editor = document.getElementById('fie-' + fid);
 const expr = document.getElementById('fexpr-' + fid);
 if (!editor) return;
 editor.classList.toggle('open');
 if (editor.classList.contains('open')) {
 const ta = document.getElementById('fie-ta-' + fid);
 if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
 if (expr) expr.style.display = 'none';
 } else {
 if (expr) expr.style.display = '';
 }
}

function _closeFormulaEditor(fid) {
 const editor = document.getElementById('fie-' + fid);
 const expr = document.getElementById('fexpr-' + fid);
 if (editor) editor.classList.remove('open');
 if (expr) expr.style.display = '';
}

function _saveFormulaExpr(fid) {
 const fbar = document.getElementById('fbar-' + fid);
 const ta = document.getElementById('fie-ta-' + fid);
 const val = (fbar || ta || {value:''}).value.trim();
 if (!val) return;
 formulaOverrides['expr_' + fid] = val;
 localStorage.setItem('fm_formula_overrides', JSON.stringify(formulaOverrides));
 renderFormulaPanel();
 if (typeof renderPL==='function') renderPL();
 if (typeof renderCF==='function') renderCF();
}


function _resetFormulaExpr(fid) {
 if (!confirm('Reset "' + fid + '" to default formula?')) return;
 delete formulaOverrides['expr_' + fid];
 localStorage.setItem('fm_formula_overrides', JSON.stringify(formulaOverrides));
 renderFormulaPanel();
 if (typeof renderPL==='function') renderPL();
 if (typeof renderCF==='function') renderCF();
}


function _saveDesc(fid, text) {
 formulaOverrides['desc_' + fid] = text.trim();
 localStorage.setItem('fm_formula_overrides', JSON.stringify(formulaOverrides));
}

// Keyboard shortcuts inside inline editor
document.addEventListener('keydown', e => {
 const ta = e.target;
 if (!ta.closest || !ta.closest('.formula-inline-editor')) return;
 const editor = ta.closest('.formula-inline-editor');
 const fid = editor.id.replace('fie-', '');
 if (e.key === 'Escape') { e.preventDefault(); _closeFormulaEditor(fid); }
 if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); _saveFormulaExpr(fid); }
});

document.getElementById('add-adj').addEventListener('click', () => {
 adjustments.push(mkAdj());
 renderAdjustments();
});

function getAdjTargets() {
 const list = [];
 // Revenue categories
 const usedCats = [...new Set(revenues.map(r => (r.cat || 'Revenue').trim() || 'Revenue'))];
 usedCats.forEach(c => list.push({ type:'revcat', refId: c, label: 'Rev cat: ' + c }));
 // Revenue items
 revenues.forEach(r => list.push({ type:'revenue', refId: r.id, label: 'Rev: ' + (r.name || '#'+r.id) }));
 // Cost categories
 // Dynamic cost categories from actual items
 const dynCats = [...new Set([...capex,...opex].map(it => (it.cat||'Other').trim()||'Other'))];
 dynCats.forEach(c => list.push({ type:'costcat', refId: c, label: 'Cat: ' + c }));
 // CAPEX items
 capex.forEach(r => list.push({ type:'capex', refId: r.id, label: 'CAPEX: '+(r.name||'#'+r.id) }));
 // OPEX items
 opex.forEach(r => list.push({ type:'opex', refId: r.id, label: 'OPEX: ' +(r.name||'#'+r.id) }));
 return list;
}

function renderAdjustments() {
 const container = document.getElementById('adj-list');
 container.innerHTML = '';

 if (!adjustments.length) {
 container.innerHTML = '<div class="empty-msg">No adjustments yet. Click "+ Add Adjustment" to create one.</div>';
 return;
 }

 adjustments.forEach((adj, idx) => {
 const card = document.createElement('div'); card.className = 'card';

 /* header */
 const hdr = document.createElement('div'); hdr.className = 'card-hdr';
 const ttlEl = document.createElement('span'); ttlEl.className = 'card-title'; ttlEl.textContent = adj.name || ('Adjustment ' + (idx+1));
 const rmBtn = document.createElement('button'); rmBtn.className = 'btn-remove'; rmBtn.textContent = 'Remove';
 rmBtn.addEventListener('click', () => { adjustments = adjustments.filter(a => a.id !== adj.id); renderAdjustments(); });
 hdr.appendChild(ttlEl); hdr.appendChild(rmBtn);
 card.appendChild(hdr);

 /* body */
 const body = document.createElement('div'); body.className = 'card-body';
 card.appendChild(body);

 const grid = document.createElement('div'); grid.className = 'g-auto'; grid.style.marginBottom = '14px';
 body.appendChild(grid);

 function addF(lbl, el) {
 const d = document.createElement('div'); d.className = 'fld';
 const l = document.createElement('label'); l.textContent = lbl;
 d.appendChild(l); d.appendChild(el); grid.appendChild(d); return el;
 }
 function mkI(t, v) { const e = document.createElement('input'); e.type = t; e.value = v != null ? String(v) : ''; return e; }
 function mkS(opts, v) {
 const e = document.createElement('select');
 opts.forEach(([ov, ol]) => { const o = document.createElement('option'); o.value = ov; o.textContent = ol; if (ov === v) o.selected = true; e.appendChild(o); });
 return e;
 }

 const nameEl = addF('Name', mkI('text', adj.name));
 const pctEl = addF('Percentage (%)',mkI('number', adj.pct));
 pctEl.step = '0.1'; pctEl.min = '0';

 const signEl = addF('Effect', mkS([['subtract','Deduct (negative)'],['add','Add (positive)']], adj.sign));
 const sideEl = addF('Applies as', mkS([['cost','Cost (affects COGS)'],['revenue','Revenue (affects Income)']], adj.side));
 const distModeEl = addF('Distribution', mkS([['auto','Auto (follow targets)'],['manual','Manual monthly %']], adj.distMode||'auto'));

 nameEl.addEventListener('input', () => { adj.name = nameEl.value; ttlEl.textContent = adj.name || ('Adjustment ' + (idx+1)); });
 pctEl .addEventListener('input', () => { adj.pct = pctEl.value; });
 signEl.addEventListener('change', () => { adj.sign = signEl.value; });
 sideEl.addEventListener('change', () => { adj.side = sideEl.value; });
 distModeEl.addEventListener('change', () => {
 adj.distMode = distModeEl.value;
 adjMosWrap.style.display = adj.distMode === 'manual' ? 'block' : 'none';
 });

 /* target chips */
 const tLbl = document.createElement('div'); tLbl.className = 'adj-section-lbl';
 tLbl.textContent = 'Targets  -  select items this % will be calculated on';
 body.appendChild(tLbl);

 const chipWrap = document.createElement('div'); chipWrap.className = 'target-chips';
 body.appendChild(chipWrap);

 const allTargets = getAdjTargets();
 if (!allTargets.length) {
 chipWrap.innerHTML = '<span style="font-size:12px;color:var(--muted)">Add Revenue / CAPEX / OPEX items first.</span>';
 } else {
 allTargets.forEach(t => {
 const chip = document.createElement('div'); chip.className = 'chip';
 chip.textContent = t.label;
 const isSel = adj.targets.some(x => x.type === t.type && x.refId === t.refId);
 if (isSel) chip.classList.add('on');
 chip.addEventListener('click', () => {
 const idx2 = adj.targets.findIndex(x => x.type === t.type && x.refId === t.refId);
 if (idx2 >= 0) { adj.targets.splice(idx2, 1); chip.classList.remove('on'); }
 else { adj.targets.push(t); chip.classList.add('on'); }
 });
 chipWrap.appendChild(chip);
 });
 }

 //  Manual distribution grid 
 const adjMosWrap = document.createElement('div');
 adjMosWrap.style.cssText = 'margin-top:12px;display:' + (adj.distMode==='manual' ? 'block' : 'none');

 const adjMosHdr = document.createElement('div');
 adjMosHdr.style.cssText = 'font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center';
 adjMosHdr.innerHTML = 'Monthly Distribution (must sum to 100%) <span id="adj-alloc-'+adj.id+'" style="font-weight:400"></span>';
 adjMosWrap.appendChild(adjMosHdr);

 const adjPbar = document.createElement('div'); adjPbar.className='pbar';
 const adjPfill = document.createElement('div'); adjPfill.className='pfill';
 adjPbar.appendChild(adjPfill); adjMosWrap.appendChild(adjPbar);

 const nYears = Math.ceil(PM()/12);
 for (let yi=0; yi<nYears; yi++) {
 const yms = AMs().filter(m => m > yi*12 && m <= (yi+1)*12);
 const {year} = mInfo(yms[0]);
 const yg = document.createElement('div'); yg.style.marginBottom='10px';
 const yTop = document.createElement('div'); yTop.style.cssText='display:flex;align-items:center;gap:8px;margin-bottom:5px';
 const ybadge = document.createElement('span'); ybadge.className='yr-badge'; ybadge.textContent=year;
 yTop.appendChild(ybadge); yg.appendChild(yTop);
 const mg = document.createElement('div'); mg.className='mo-grid';
 mg.style.gridTemplateColumns='repeat('+yms.length+',1fr)';
 yms.forEach(m => {
 const cell = document.createElement('div'); cell.className='mo-cell';
 const lbl = document.createElement('div'); lbl.className='mo-lbl';
 const mi2 = mInfo(m);
 lbl.innerHTML='<span style="color:var(--muted);font-size:8px;display:block">'+mi2.short+' '+String(mi2.year).slice(2)+'</span>'
 +'<span style="color:var(--blue);font-weight:700;font-size:9px">(M'+m+')</span>';
 const moInp2 = document.createElement('input'); moInp2.type='text'; moInp2.placeholder='0';
 moInp2.value = (adj.mos && adj.mos[m]) ? adj.mos[m] : '';
 moInp2.addEventListener('input', () => {
 if (!adj.mos) adj.mos={};
 adj.mos[m]=moInp2.value;
 // Update allocation %
 const total = AMs().reduce((s,mm)=>s+(evalPct((adj.mos||{})[mm])||0),0);
 const ok = Math.abs(total-100)<0.01;
 const pc = ok?'#2E844A':total>100?'#BA0517':total>0?'#A56105':'#706E6B';
 const allocEl = document.getElementById('adj-alloc-'+adj.id);
 if(allocEl) allocEl.innerHTML='<span style="color:'+pc+'">'+total.toFixed(1)+'% allocated</span>';
 adjPfill.style.width=Math.min(total,100)+'%';
 adjPfill.style.background=pc;
 });
 cell.appendChild(lbl); cell.appendChild(moInp2);
 mg.appendChild(cell);
 });
 yg.appendChild(mg);
 adjMosWrap.appendChild(yg);
 }
 body.appendChild(adjMosWrap);

 container.appendChild(card);
 });
}

//  CUSTOM LINES UI 
const CUSTOM_LINE_SECTIONS = [
 { value: 'income_section', label: 'P&L  -  Income (before Total Income)', pl: true, cf: true },
 { value: 'cogs_section', label: 'P&L  -  COGS (before Total COGS)', pl: true, cf: true },
 { value: 'after_gross_profit', label: 'P&L  -  After Gross Profit', pl: true, cf: false },
 { value: 'after_profit_b_opex', label: 'P&L  -  After Profit before OPEX', pl: true, cf: false },
 { value: 'after_ebit', label: 'P&L  -  After EBIT', pl: true, cf: false },
 { value: 'cf_after_inflows', label: 'CF  -  After Total Inflows', pl: false, cf: true },
 { value: 'cf_after_outflows', label: 'CF  -  After Total Outflows', pl: false, cf: true },
];

function renderCustomLines() {
 const panel = document.getElementById('panel-adjustments');
 let wrap = document.getElementById('custom-lines-wrap');
 if (!wrap) {
 wrap = document.createElement('div');
 wrap.id = 'custom-lines-wrap';
 wrap.style.cssText = 'margin-top:32px;border-top:2px solid var(--bdr);padding-top:24px';
 panel.appendChild(wrap);
 }
 const cv = compute();

 wrap.innerHTML = `
 <div class="items-hdr" style="margin-bottom:16px">
 <div>
 <div class="items-title" style="margin-bottom:4px">Custom Calculated Lines</div>
 <div style="font-size:11px;color:var(--sub)">
 Lines appear directly in P&L and/or Cash Flow tables. Click <strong>+ Add line</strong> buttons in the tables, or add here.
 </div>
 </div>
 <button class="btn btn-primary" id="add-custom-line-btn">+ Add Line</button>
 </div>
 <div id="custom-lines-list"></div>`;

 document.getElementById('add-custom-line-btn').addEventListener('click', () => {
 openCLModal('after_gross_profit');
 });

 const list = document.getElementById('custom-lines-list');
 if (!customLines.length) {
 list.innerHTML = `<div class="empty-msg" style="padding:24px;text-align:center">
 No custom lines yet.<br>
 <span style="font-size:11px;color:var(--sub)">Click <strong>+ Add line</strong> in the P&L/CF table at any section break, or use the button above.</span>
 </div>`;
 return;
 }

 customLines.forEach((line, idx) => {
 let previewArr = Z();
 try { previewArr = evalCustomLineArr(line, cv); } catch(e) {}
 const total = rSum(previewArr);
 const hasF = !!line.formula.trim();
 const secLbl = CUSTOM_LINE_SECTIONS.find(s => s.value === line.section)?.label || line.section;

 const card = document.createElement('div');
 card.className = 'card';
 card.style.marginBottom = '8px';
 card.innerHTML = `
 <div class="card-hdr" style="cursor:default;justify-content:space-between">
 <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
 <span style="font-size:11px;font-weight:700;color:#fff">${line.name||'Unnamed'}</span>
 <span style="font-size:10px;opacity:.6;color:#fff;white-space:nowrap">${secLbl}</span>
 ${hasF ? `<span style="font-size:10px;background:rgba(255,255,255,.18);padding:1px 8px;border-radius:8px;color:#fff;white-space:nowrap">
 ${line.sign==='subtract'?'':'+'}$${fmt(Math.abs(total))} total
 </span>` : '<span style="font-size:10px;color:#ffcc70;opacity:.8"> No formula</span>'}
 </div>
 <div style="display:flex;gap:6px">
 <button class="btn-tpl" data-mv="-1" data-idx="${idx}" style="font-size:11px;padding:2px 8px;background:rgba(255,255,255,.1);color:#fff;border-color:rgba(255,255,255,.2)"></button>
 <button class="btn-tpl" data-mv="1" data-idx="${idx}" style="font-size:11px;padding:2px 8px;background:rgba(255,255,255,.1);color:#fff;border-color:rgba(255,255,255,.2)"></button>
 <button class="btn-remove" data-rm="${idx}">Remove</button>
 </div>
 </div>
 <div class="card-body" style="padding:14px">
 <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:12px">
 <div class="fld" style="margin:0;grid-column:1/3">
 <label>Name</label>
 <input class="cl-name" value="${line.name}" placeholder="e.g. Management Fee">
 </div>
 <div class="fld" style="margin:0">
 <label>Position</label>
 <select class="cl-section">
 ${CUSTOM_LINE_SECTIONS.map(s=>`<option value="${s.value}" ${s.value===line.section?'selected':''}>${s.label}</option>`).join('')}
 </select>
 </div>
 <div class="fld" style="margin:0">
 <label>Sign</label>
 <select class="cl-sign">
 <option value="subtract" ${line.sign==='subtract'?'selected':''}> Deduct</option>
 <option value="add" ${line.sign==='add'?'selected':''}>+ Add</option>
 </select>
 </div>
 </div>

 <div class="fld" style="margin:0 0 10px">
 <label>Formula
 <span style="font-weight:400;color:var(--sub);font-size:10px;margin-left:6px">
 Use: totalIncome · totalCogs · grossProfit · ebit · opexBuffer · hedging · finCostArr · accumCF · [item/category names]
 </span>
 </label>
 <input class="cl-formula" value="${line.formula.replace(/"/g,'&quot;')}"
 placeholder="e.g. totalIncome * 0.02 or Internet * 0.5 + Labor * 0.3">
 </div>

 <div style="display:flex;gap:10px;align-items:center;margin-bottom:${hasF?'10':'0'}px;flex-wrap:wrap">
 <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">
 <input type="checkbox" class="cl-showcf" ${line.showInCF?'checked':''}
 style="width:14px;height:14px;accent-color:var(--accent)">
 Show in Cash Flow
 </label>
 <div class="fld" style="margin:0;flex:1;min-width:160px">
 <input class="cl-note" value="${(line.note||'').replace(/"/g,'&quot;')}" placeholder="Optional note...">
 </div>
 </div>

 ${hasF ? `<div style="background:var(--blue-bg);border-radius:6px;padding:8px 12px;font-size:10px">
 <strong>Preview:</strong>
 ${AMs().slice(0,Math.min(8,PM())).map((m,i)=>{
 const v=previewArr[i]||0;
 return `<span style="margin-right:10px"><em style="color:var(--muted)">M${m}</em>
 <strong style="color:${v<0?'var(--red)':'var(--green)'}">$${fmt(Math.abs(v))}</strong></span>`;
 }).join('')}
 ${PM()>8?'<em style="color:var(--muted)">&</em>':''}
 <span style="margin-left:8px;color:var(--sub)">Total: <strong>$${fmt(Math.abs(total))}</strong></span>
 </div>` : ''}
 </div>`;

 // Wire events
 const wire = (sel, ev, fn) => card.querySelector(sel).addEventListener(ev, fn);
 wire('.cl-name', 'input', e => { line.name = e.target.value; renderPL(); renderCF(); renderCustomLines(); });
 wire('.cl-section', 'change', e => { line.section = e.target.value; renderPL(); renderCF(); });
 wire('.cl-sign', 'change', e => { line.sign = e.target.value; renderPL(); renderCF(); renderCustomLines(); });
 wire('.cl-showcf', 'change', e => { line.showInCF = e.target.checked; renderCF(); });
 wire('.cl-note', 'input', e => { line.note = e.target.value; });
 wire('.cl-formula', 'input', e => {
 line.formula = e.target.value;
 // Keep typing fluid: do not re-render this panel on every keypress.
 // Tables are refreshed on blur/change so the input never loses focus.
 if (typeof _ensureFormulaDatalist === 'function') _ensureFormulaDatalist();
 });
 wire('.cl-formula', 'change', () => { renderPL(); renderCF(); renderCustomLines(); });
 wire('.cl-formula', 'blur', () => { renderPL(); renderCF(); renderCustomLines(); });
 card.querySelector('[data-rm]').addEventListener('click', () => {
 customLines.splice(idx, 1); renderPL(); renderCF(); renderCustomLines();
 });
 card.querySelectorAll('[data-mv]').forEach(btn => {
 btn.addEventListener('click', () => {
 const i = parseInt(btn.dataset.idx);
 const d = parseInt(btn.dataset.mv);
 const j = i + d;
 if (j < 0 || j >= customLines.length) return;
 [customLines[i], customLines[j]] = [customLines[j], customLines[i]];
 renderPL(); renderCF(); renderCustomLines();
 });
 });
 list.appendChild(card);
 });
}

//  TABLE BUILDERS 
function buildToggle(cur, onChange) {
 const w = document.createElement('div'); w.className = 'vtog';
 const opts = PM() <= 12
 ? [['monthly','Monthly'],['annual','Annual']]
 : [['monthly','Monthly'],['grouped','By Year '],['annual','Annual']];
 opts.forEach(([v, lbl]) => {
 const b = document.createElement('button');
 b.textContent = lbl;
 if (v === cur) b.classList.add('active');
 b.addEventListener('click', () => onChange(v));
 w.appendChild(b);
 });
 return w;
}

//  GROUPED VIEW: year-collapsible table 
// yearOpen: {yi: bool}  -  which years show months (vs just annual total)
function buildGroupedTable(rows, yearOpen, onToggle) {
 // rows = [{label, arr, opts}]  -  same shape as dataRow calls
 const nY = Math.ceil(PM() / 12);
 const years = Array.from({length: nY}, (_, yi) => {
 const yms = AMs().filter(m => m > yi*12 && m <= (yi+1)*12);
 return { yi, year: mInfo(yms[0]).year, yms };
 });

 // Build column list: for each year, if open  months + year total; if closed  just year total
 const allCols = []; // [{label, type:'month'|'year', yi, m?}]
 years.forEach(({yi, year, yms}) => {
 const open = yearOpen[yi] !== false; // default open for first year, others closed
 if (open) {
 yms.forEach(m => allCols.push({label: mInfo(m).short+' '+String(mInfo(m).year).slice(2), sub:'(M'+m+')', type:'month', yi, m}));
 }
 allCols.push({label: String(year), sub: open ? ' collapse' : ' expand', type:'year', yi, open});
 });
 allCols.push({label:'Total', sub:'', type:'total'});

 // Build <thead>
 let head = '<thead><tr>'
 + '<th style="min-width:220px;text-align:left;position:sticky;left:0;z-index:3;background:var(--navy)">Category</th>';
 allCols.forEach(col => {
 const isYear = col.type === 'year';
 const isMo = col.type === 'month';
 const isTot = col.type === 'total';
 const bg = isYear ? '#1a4a80' : isTot ? '#0a2a50' : 'var(--navy)';
 const cursor = isYear ? 'cursor:pointer' : '';
 const onClick = isYear ? ` data-yr-toggle="${col.yi}"` : '';
 head += `<th style="min-width:${isTot?90:isYear?80:78}px;background:${bg};${cursor}"${onClick}>
 <div style="font-size:10px">${col.label}</div>
 <div style="font-size:8px;opacity:.7;margin-top:1px;font-weight:400">${col.sub}</div>
 </th>`;
 });
 head += '<tbody style="display:none"></tbody></tr></thead>'; // dummy to close tr
 head = head.replace('<tbody style="display:none"></tbody></tr></thead>', '</tr></thead>');

 // Build <tbody>
 let body = '<tbody>';
 rows.forEach(({label, arr, opts}) => {
 opts = opts || {};
 const d = arr;
 const tot = rSum(arr);
 const cc = opts.color || '';
 const bold = opts.bold;
 body += '<tr class="' + (bold ? 'bold-row' : '') + '">'
 + '<td class="lbl' + (opts.ind?' ind':'') + (bold?' bold':'') + '" style="position:sticky;left:0;z-index:1;background:' + (bold?'var(--alt)':'var(--surface)') + '">' + label + '</td>';

 allCols.forEach(col => {
 let v = 0;
 if (col.type === 'month') {
 v = d[col.m - 1] || 0;
 } else if (col.type === 'year') {
 v = col.yms ? col.yms.reduce((s, m) => s + (d[m-1]||0), 0) : 0;
 } else {
 v = tot;
 }
 const isYr = col.type === 'year';
 const isTot = col.type === 'total';
 const bg = isYr ? 'background:#f0f4f8' : isTot ? 'background:var(--alt)' : '';
 body += `<td class="num${bold?' bold':''}${v<0?' c-red':''}${cc?' c-'+cc:''}" style="${bg}">${fmt(v)}</td>`;
 });
 body += '</tr>';
 });
 body += '</tbody>';

 return head + body;
}

// Get year monthly ranges for grouped view
function getYearRanges() {
 const nY = Math.ceil(PM() / 12);
 return Array.from({length: nY}, (_, yi) => ({
 yi, year: mInfo(AMs().filter(m=>m>yi*12&&m<=(yi+1)*12)[0]).year,
 yms: AMs().filter(m => m > yi*12 && m <= (yi+1)*12)
 }));
}

function tHead(cols, cw, mNums) {
 // mNums: optional array of month numbers for M1/M2 labels
 return '<thead><tr>'
 + '<th style="min-width:220px;text-align:left">Category</th>'
 + cols.map((c, i) => {
 const mLabel = mNums ? '<div style="color:#5ba4f5;font-size:9px;font-weight:700;margin-top:1px">(M' + mNums[i] + ')</div>' : '';
 return '<th style="min-width:' + cw + 'px"><div style="font-size:10px">' + c + '</div>' + mLabel + '</th>';
 }).join('')
 + '<th style="min-width:90px">Total</th>'
 + '</tr></thead>';
}

function secRow(label, color) {
 return '<tr class="sec-row"><td colspan="999" style="background:' + (color||'#032D60') + '">' + label + '</td></tr>';
}

function dataRow(label, arr, view, opts) {
 opts = opts || {};
 const d = opts.acc ? aggAccY(arr) : (view === 'annual' ? aggY(arr) : arr);
 const tot = opts.acc ? arr[arr.length - 1] : rSum(arr);
 const cc = opts.color || '';
 return '<tr class="' + (opts.bold ? 'bold-row' : '') + '">'
 + '<td class="lbl' + (opts.ind ? ' ind' : '') + (opts.bold ? ' bold' : '') + '">' + label + '</td>'
 + d.map(v => '<td class="num' + (opts.bold ? ' bold' : '') + (v < 0 ? ' c-red' : '') + (cc ? ' c-' + cc : '') + '">' + fmt(v) + '</td>').join('')
 + '<td class="num tot' + (opts.bold ? ' bold' : '') + (tot < 0 ? ' c-red' : '') + (cc ? ' c-' + cc : '') + '">' + fmt(tot) + '</td>'
 + '</tr>';
}

function infoRow(label, value, color, colCount) {
 return '<tr><td class="lbl">' + label + '</td>'
 + '<td colspan="' + (colCount + 1) + '" style="padding:5px 10px;font-weight:700;color:' + (color || 'var(--blue)') + '">' + value + '</td></tr>';
}


// 
// ROW ORDERING SYSTEM
// Each table (P&L / CF) is defined as an ordered list of row descriptors.
// Users can drag to reorder. Custom lines appear at their section position.
// 

const PL_DEFAULT_ROWS = [
 // INCOME
 { id:'pl_income_sec', type:'section', label:'INCOME', section:'income' },
 { id:'pl_rev_cats', type:'builtin', label:'Revenue Categories', section:'income', note:'All revenue items grouped by category' },
 { id:'pl_penalties', type:'builtin', label:'Penalties', section:'income' },
 { id:'pl_adj_inc', type:'builtin', label:'Revenue Adjustments', section:'income', note:'From Adjustments tab' },
 { id:'pl_total_income', type:'total', label:'Total Income', section:'income' },
 // COGS
 { id:'pl_cogs_sec', type:'section', label:'COGS', section:'cogs' },
 { id:'pl_cost_cats', type:'builtin', label:'Cost Categories', section:'cogs', note:'CAPEX + OPEX items by category' },
 { id:'pl_contingency', type:'builtin', label:'Contingency', section:'cogs' },
 { id:'pl_adj_cost', type:'builtin', label:'Cost Adjustments', section:'cogs', note:'From Adjustments tab' },
 { id:'pl_total_cogs', type:'total', label:'Total COGS', section:'cogs' },
 // GROSS PROFIT
 { id:'pl_gross_profit', type:'total', label:'Gross Profit', section:'gp', bold:true },
 // BOND FEES
 { id:'pl_bond_sec', type:'section', label:'Bond Fees', section:'bond' },
 { id:'pl_cb_fee', type:'builtin', label:'Compliance Bond Fee', section:'bond' },
 { id:'pl_ub_fee', type:'builtin', label:'Upfront Bond Fee', section:'bond' },
 { id:'pl_profit_bopex', type:'total', label:'Profit before OPEX / Interest', section:'bond' },
 // OPEX
 { id:'pl_opex_sec', type:'section', label:'OPEX & Interest', section:'opex' },
 { id:'pl_opex_buf', type:'builtin', label:'OPEX Buffer', section:'opex', formula:'totalIncome * (CFG.opxbuf/100)', editable:false },
 { id:'pl_hedging', type:'builtin', label:'Hedging Adjustment', section:'opex', formula:'(revTotalPEN - costTotalPEN) / CFG.fx / PM()', editable:false },
 { id:'pl_fin_cost', type:'builtin', label:'Financing Cost', section:'opex', formula:'|accumCF[m-1]| * finRate%', editable:false },
 { id:'pl_ebit', type:'total', label:'EBIT', section:'opex' },
 { id:'pl_ebitda', type:'total', label:'EBITDA', section:'opex' },
];

const CF_DEFAULT_ROWS = [
 { id:'cf_in_sec', type:'section', label:'INFLOWS', section:'inflows' },
 { id:'cf_rev_cats', type:'builtin', label:'Revenue (CF timing)', section:'inflows' },
 { id:'cf_penalties', type:'builtin', label:'Penalties', section:'inflows' },
 { id:'cf_adj_inc', type:'builtin', label:'Revenue Adjustments', section:'inflows' },
 { id:'cf_total_in', type:'total', label:'Total Inflows', section:'inflows' },
 { id:'cf_out_sec', type:'section', label:'OUTFLOWS', section:'outflows' },
 { id:'cf_cost_cats', type:'builtin', label:'Cost Categories', section:'outflows' },
 { id:'cf_contingency', type:'builtin', label:'Contingency', section:'outflows' },
 { id:'cf_adj_cost', type:'builtin', label:'Cost Adjustments', section:'outflows' },
 { id:'cf_opex_buf', type:'builtin', label:'OPEX Buffer', section:'outflows' },
 { id:'cf_cb_fee', type:'builtin', label:'Compliance Bond Fee', section:'outflows' },
 { id:'cf_ub_fee', type:'builtin', label:'Upfront Bond Fee', section:'outflows' },
 { id:'cf_hedging', type:'builtin', label:'Hedging', section:'outflows' },
 { id:'cf_fin_cost', type:'builtin', label:'Financing Cost', section:'outflows' },
 { id:'cf_total_out', type:'total', label:'Total Outflows', section:'outflows' },
 { id:'cf_net_sec', type:'section', label:'NET CASH FLOW', section:'net' },
 { id:'cf_net_cf', type:'total', label:'Net Cash Flow', section:'net' },
 { id:'cf_accum', type:'total', label:'Accumulated CF', section:'net' },
 { id:'cf_npv_sec', type:'section', label:'NPV ANALYSIS', section:'npv' },
 { id:'cf_npv', type:'builtin', label:'NPV / KPIs', section:'npv' },
];

function getRowOrder(which) {
 const defaults = which === 'pl' ? PL_DEFAULT_ROWS : CF_DEFAULT_ROWS;
 const stored = which === 'pl' ? plRowOrder : cfRowOrder;
 if (!stored || !stored.length) return defaults.map(r => r.id);
 // Merge: keep stored order, append any new defaults not yet in stored
 const known = new Set(stored);
 const extra = defaults.map(r => r.id).filter(id => !known.has(id));
 return [...stored, ...extra];
}

function setRowOrder(which, order) {
 if (which === 'pl') plRowOrder = order;
 else cfRowOrder = order;
}

//  REORDER PANEL 
let _reorderWhich = 'pl';
let _dragSrcIdx = null;

function openReorderPanel(which) {
 _reorderWhich = which;
 document.getElementById('reorder-which').value = which;
 document.getElementById('reorder-panel').classList.add('open');
 renderReorderList();
}

function renderReorderList() {
 const which = _reorderWhich;
 const defaults = which === 'pl' ? PL_DEFAULT_ROWS : CF_DEFAULT_ROWS;
 const order = getRowOrder(which);
 const list = document.getElementById('reorder-list');
 list.innerHTML = '';

 // Build ordered rows = builtin rows in order + custom lines interspersed
 const orderedBuiltins = order
 .map(id => defaults.find(r => r.id === id))
 .filter(Boolean);

 // Add custom lines
 const allRows = [];
 orderedBuiltins.forEach(row => { allRows.push({...row, _custom: false}); });
 customLines.filter(l => which === 'pl' || l.showInCF).forEach(l => {
 allRows.push({ id: 'cl_' + l.id, type:'custom', label: l.name||'Custom', section: l.section, _line: l, _custom: true });
 });

 allRows.forEach((row, idx) => {
 const item = document.createElement('div');
 item.className = 'reorder-item';
 item.draggable = true;
 item.dataset.idx = idx;
 item.dataset.id = row.id;

 const typeColor = row.type === 'section' ? '#e8f0fe' : row.type === 'total' ? '#f0f8f0' : row._custom ? '#fef9ee' : '#f8f8f8';
 const typeText = row.type === 'section' ? '§ section' : row.type === 'total' ? ' total' : row._custom ? ' custom' : '· row';

 item.innerHTML = `
 <span class="reorder-handle"></span>
 <div style="flex:1;min-width:0">
 <div class="reorder-lbl">${row.label}</div>
 ${row.note ? `<div class="reorder-section">${row.note}</div>` : ''}
 </div>
 <span class="reorder-type" style="background:${typeColor}">${typeText}</span>
 ${row._custom ? `<button class="reorder-edit" data-lid="${row._line.id}"> Edit</button>` : ''}`;

 // Drag events
 item.addEventListener('dragstart', e => {
 _dragSrcIdx = idx;
 item.classList.add('dragging');
 e.dataTransfer.effectAllowed = 'move';
 });
 item.addEventListener('dragend', () => item.classList.remove('dragging'));
 item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('drag-over'); });
 item.addEventListener('dragleave',() => item.classList.remove('drag-over'));
 item.addEventListener('drop', e => {
 e.preventDefault();
 item.classList.remove('drag-over');
 if (_dragSrcIdx === null || _dragSrcIdx === idx) return;

 // Reorder: only reorder builtin rows (custom lines positioning is via section)
 const builtinIds = orderedBuiltins.map(r => r.id);
 const srcRow = allRows[_dragSrcIdx];
 const dstRow = allRows[idx];
 if (!srcRow || !dstRow) return;

 if (!srcRow._custom && !dstRow._custom) {
 // Both builtins  -  reorder the builtin list
 const si = builtinIds.indexOf(srcRow.id);
 const di = builtinIds.indexOf(dstRow.id);
 if (si >= 0 && di >= 0) {
 builtinIds.splice(si, 1);
 builtinIds.splice(di, 0, srcRow.id);
 setRowOrder(which, builtinIds);
 }
 } else if (srcRow._custom && dstRow._custom) {
 // Both custom  -  reorder customLines
 const si = customLines.findIndex(l => l.id == srcRow._line.id);
 const di = customLines.findIndex(l => l.id == dstRow._line.id);
 if (si >= 0 && di >= 0) {
 const [moved] = customLines.splice(si, 1);
 customLines.splice(di, 0, moved);
 }
 } else if (srcRow._custom) {
 // Move custom line to section matching destination
 srcRow._line.section = dstRow.section || srcRow._line.section;
 }
 _dragSrcIdx = null;
 renderReorderList();
 if (which === 'pl') renderPL(); else renderCF();
 });

 // Edit button for custom lines
 const editBtn = item.querySelector('.reorder-edit');
 if (editBtn) {
 editBtn.addEventListener('click', () => {
 const line = customLines.find(l => String(l.id) === editBtn.dataset.lid);
 if (line) openEditLineModal(line);
 });
 }

 list.appendChild(item);
 });
}

// Edit formula modal for custom line
// Close / reset
document.getElementById('reorder-close').addEventListener('click', () => {
 document.getElementById('reorder-panel').classList.remove('open');
});
document.getElementById('reorder-which').addEventListener('change', e => {
 _reorderWhich = e.target.value;
 renderReorderList();
});
document.getElementById('reorder-reset').addEventListener('click', () => {
 if (_reorderWhich === 'pl') plRowOrder = [];
 else cfRowOrder = [];
 renderReorderList();
 if (_reorderWhich === 'pl') renderPL(); else renderCF();
});



// 
// CUSTOM LINE MODAL  -  single clean implementation
// 
let _editingLine = null;
let _clModalSection = 'after_gross_profit';

function _clClose() {
 document.getElementById('cl-modal').style.display = 'none';
 _editingLine = null;
}

function _clPreview() {
 const formula = document.getElementById('cl-m-formula').value.trim();
 const prev = document.getElementById('cl-m-preview');
 if (!formula) { prev.textContent = 'Enter a formula to preview&'; prev.style.color = 'var(--sub)'; return; }
 try {
 const cv = compute();
 const fake = { name:'preview', formula, sign:'subtract', showInCF:true, section:'x', id:'tmp', note:'' };
 const arr = evalCustomLineArr(fake, cv);
 const tot = rSum(arr.map(Math.abs));
 const samples = AMs().slice(0, Math.min(6, PM()))
 .map((m, i) => `<span style="margin-right:10px"><em style="color:var(--muted)">M${m}</em> <strong>$${fmt(Math.abs(arr[i]||0))}</strong></span>`)
 .join('');
 prev.innerHTML = samples + ` <span style="margin-left:8px;color:var(--teal);font-weight:700">Total: $${fmt(tot)}</span>`;
 prev.style.color = 'var(--text)';
 } catch(e) {
 prev.innerHTML = `<span style="color:var(--red)"> Formula error: ${e.message}</span>`;
 }
}

function openEditLineModal(line) {
 if (!line) return;
 _editingLine = line;
 _clModalSection = line.section;
 document.getElementById('cl-m-title').textContent = ' Edit Line';
 document.getElementById('cl-m-save').textContent = ' Save Changes';
 document.getElementById('cl-m-delete').style.display = 'inline-flex';
 document.getElementById('cl-m-name').value = line.name || '';
 document.getElementById('cl-m-formula').value = line.formula || '';
 document.getElementById('cl-m-note').value = line.note || '';
 document.getElementById('cl-m-sign').value = line.sign || 'subtract';
 document.getElementById('cl-m-showcf').value = line.showInCF ? '1' : '0';
 _clFillSections(line.section);
 _clPreview();
 document.getElementById('cl-modal').style.display = 'flex';
 setTimeout(() => document.getElementById('cl-m-formula').focus(), 50);
}

function _clFillSections(selected) {
 const sel = document.getElementById('cl-m-section');
 sel.innerHTML = CUSTOM_LINE_SECTIONS
 .map(s => `<option value="${s.value}" ${s.value === selected ? 'selected' : ''}>${s.label}</option>`)
 .join('');
}

// Wire events
document.getElementById('cl-m-formula').addEventListener('input', _clPreview);
document.getElementById('cl-m-section').addEventListener('change', e => { _clModalSection = e.target.value; });
document.getElementById('cl-m-cancel').addEventListener('click', _clClose);
document.getElementById('cl-m-cancel2').addEventListener('click', _clClose);
document.getElementById('cl-modal').addEventListener('click', e => {
 if (e.target === document.getElementById('cl-modal')) _clClose();
});
document.getElementById('cl-m-delete').addEventListener('click', () => {
 if (!_editingLine) return;
 if (!confirm('Delete "' + (_editingLine.name||'this line') + '"?')) return;
 const idx = customLines.findIndex(l => l.id === _editingLine.id);
 if (idx >= 0) customLines.splice(idx, 1);
 _clClose();
 renderPL(); renderCF();
 if (typeof renderCustomLines === 'function') renderCustomLines();
 renderReorderList();
});
document.getElementById('cl-m-save').addEventListener('click', () => {
 const name = document.getElementById('cl-m-name').value.trim();
 const formula = document.getElementById('cl-m-formula').value.trim();
 const section = document.getElementById('cl-m-section').value || _clModalSection;
 if (!name) { document.getElementById('cl-m-name').focus(); return; }
 if (!formula) { document.getElementById('cl-m-formula').focus(); return; }

 if (_editingLine) {
 _editingLine.name = name;
 _editingLine.formula = formula;
 _editingLine.section = section;
 _editingLine.sign = document.getElementById('cl-m-sign').value;
 _editingLine.showInCF = document.getElementById('cl-m-showcf').value === '1';
 _editingLine.note = document.getElementById('cl-m-note').value.trim();
 } else {
 const line = mkCustomLine();
 line.name = name;
 line.formula = formula;
 line.section = section;
 line.sign = document.getElementById('cl-m-sign').value;
 line.showInCF= document.getElementById('cl-m-showcf').value === '1';
 line.note = document.getElementById('cl-m-note').value.trim();
 customLines.push(line);
 }
 _clClose();
 renderPL(); renderCF();
 if (typeof renderCustomLines === 'function') renderCustomLines();
 renderReorderList();
});

//  INLINE ADD LINE ROW 
// Returns an <tr> with a "+ Add calculated line here" button
function addLineRow(section, ncols) {
 const n = ncols || (PM() + 1);
 return `<tr class="add-line-row" data-section="${section}">
 <td colspan="${n + 2}" style="padding:2px 8px;border:none;background:transparent">
 <button class="add-line-btn" data-section="${section}"
 style="font-size:10px;color:var(--accent);background:none;border:1px dashed var(--bdr2);
 border-radius:4px;padding:3px 10px;cursor:pointer;width:100%;text-align:left;
 opacity:.6;transition:opacity .15s"
 onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.6">
 + Add calculated line here
 </button>
 </td></tr>`;
}

//  CUSTOM LINE MODAL 
function openCLModal(section) {
 _editingLine = null;
 _clModalSection = section || 'after_gross_profit';
 document.getElementById('cl-m-title').textContent = '+ Add Calculated Line';
 document.getElementById('cl-m-save').textContent = 'Add Line';
 document.getElementById('cl-m-delete').style.display = 'none';
 document.getElementById('cl-m-name').value = '';
 document.getElementById('cl-m-formula').value = '';
 document.getElementById('cl-m-note').value = '';
 document.getElementById('cl-m-sign').value = 'subtract';
 document.getElementById('cl-m-showcf').value = '1';
 _clFillSections(_clModalSection);
 document.getElementById('cl-m-preview').textContent = 'Enter a formula to preview&';
 document.getElementById('cl-modal').style.display = 'flex';
 setTimeout(() => document.getElementById('cl-m-name').focus(), 50);
}



// Wire add-line-btn clicks (delegated  -  works after table re-render)
document.addEventListener('click', e => {
 const btn = e.target.closest('.add-line-btn');
 if (!btn) return;
 openCLModal(btn.dataset.section);
});

//  CUSTOM LINE INJECTION HELPER 
function customLinesFor(section, cv, mkRowFn) {
 let html = '';
 customLines.filter(l => l.section === section && l.formula.trim()).forEach(line => {
 const arr = evalCustomLineArr(line, cv);
 const editBtn = `<button onclick="openEditLineModal(customLines.find(l=>l.id=='${line.id}'))"
 style="margin-left:8px;font-size:9px;padding:1px 6px;border:1px solid var(--bdr2);border-radius:3px;
 background:var(--alt);color:var(--accent);cursor:pointer;vertical-align:middle"></button>`;
 const label = (line.name || 'Custom') + editBtn
 + (line.note ? ` <span style="font-size:9px;opacity:.6">(${line.note})</span>` : '');
 html += mkRowFn(label, arr, { ind: true, color: line.color || 'amber' });
 });
 return html;
}

//  GROUPED P&L / CF TABLE 
function renderGroupedPLCF(which, cv) {
 const tblId = which === 'pl' ? 'pl-tbl' : 'cf-tbl';
 const yearOpen = which === 'pl' ? plYearOpen : cfYearOpen;
 const years = getYearRanges();

 // Default: first year open, rest closed
 years.forEach(({yi}) => { if (yearOpen[yi] === undefined) yearOpen[yi] = (yi === 0); });

 function aggYear(arr, yms) { return yms.reduce((s,m) => s + (arr[m-1]||0), 0); }

 // Build column definitions
 const cols = [];
 years.forEach(({yi, year, yms}) => {
 const open = !!yearOpen[yi];
 if (open) yms.forEach(m => cols.push({type:'month', yi, m, year, yms}));
 cols.push({type:'year', yi, year, yms, open});
 });
 cols.push({type:'total'});

 // Render a data cell value for a column
 function cellVal(arr, col) {
 if (col.type === 'month') return arr[col.m - 1] || 0;
 if (col.type === 'year') return aggYear(arr, col.yms);
 return rSum(arr);
 }

 // Build thead
 function makeHead() {
 let h = '<thead><tr>'
 + '<th style="min-width:220px;text-align:left;position:sticky;left:0;z-index:3;background:var(--navy)">Category</th>';
 cols.forEach(col => {
 if (col.type === 'month') {
 const mi = mInfo(col.m);
 h += `<th style="min-width:76px;background:var(--navy)">
 <div style="font-size:10px">${mi.short} ${String(mi.year).slice(2)}</div>
 <div style="color:#5ba4f5;font-size:9px;font-weight:700">(M${col.m})</div></th>`;
 } else if (col.type === 'year') {
 h += `<th class="yr-col-hdr" data-yi="${col.yi}" style="min-width:90px;background:#1a4a80;cursor:pointer;user-select:none" title="Click to ${col.open?'collapse':'expand'} months">
 <div style="font-size:11px;font-weight:800">${col.year}</div>
 <div style="font-size:8px;opacity:.75;margin-top:2px">${col.open?' collapse':' expand'}</div></th>`;
 } else {
 h += `<th style="min-width:90px;background:#0a2a50"><div style="font-size:10px">Total</div></th>`;
 }
 });
 h += '</tr></thead>';
 return h;
 }

 // Build a table row
 function mkRow(label, arr, opts) {
 opts = opts || {};
 const bold = opts.bold; const cc = opts.color||''; const ind = opts.ind;
 const tot = rSum(arr);
 const stickyBg = bold ? 'var(--alt)' : 'var(--surface)';
 let r = `<tr class="${bold?'bold-row':''}">
 <td class="lbl${ind?' ind':''}${bold?' bold':''}" style="position:sticky;left:0;z-index:1;background:${stickyBg}">${label}</td>`;
 cols.forEach(col => {
 const v = cellVal(arr, col);
 const isY = col.type==='year', isT=col.type==='total';
 const bg = isY ? 'background:#f0f4f8;' : isT ? 'background:var(--alt);' : '';
 const fw = isY ? 'font-weight:700;' : '';
 r += `<td class="num${bold?' bold':''}${v<0?' c-red':''}${cc?' c-'+cc:''}" style="${bg}${fw}">${fmt(v)}</td>`;
 });
 r += '</tr>';
 return r;
 }

 function mkSec(label, color) {
 return `<tr class="sec-row"><td colspan="999" style="background:${color||'#032D60'}">${label}</td></tr>`;
 }

 //  Build rows 
 let body = '';

 if (which === 'pl') {
 //  INCOME 
 body += mkSec('INCOME', 'var(--th-income)');
 Object.entries(cv.revCats).forEach(([cat, arr]) => body += mkRow(cat, arr, {ind:true}));
 body += mkRow('Penalties', cv.penArr, {ind:true, color:'amber'});
 cv.adjIncomeRows.forEach(ac => {
 body += mkRow((ac.adj.name||'Adj')+' ('+ac.adj.pct+'%)', ac.arr.map(v=>ac.adj.sign==='add'?v:-v), {ind:true,color:'amber'});
 });
 body += customLinesFor('income_section', cv, mkRow);
 body += mkRow('Total Income', cv.totalIncome, {bold:true, color:'teal'});

 //  COGS 
 body += mkSec('COGS', 'var(--th-cogs)');
 cv.userCats.forEach(cat => {
 const catArr = cv.costCat[cat]||Z();
 body += mkRow(cat, catArr.map(v=>-v), {ind:true});
 });
 body += mkRow('Contingency ('+CFG.con+'%)', (cv.costCat['Contingency']||Z()).map(v=>-v), {ind:true});
 cv.adjCostRows.forEach(ac => {
 body += mkRow((ac.adj.name||'Adj')+' ('+ac.adj.pct+'%)', ac.arr.map(v=>-(ac.adj.sign==='add'?v:-v)), {ind:true,color:'amber'});
 });
 body += customLinesFor('cogs_section', cv, mkRow);
 body += mkRow('Total COGS', cv.totalCogsAdj.map(v=>-v), {bold:true});

 //  GROSS PROFIT 
 body += mkRow('Gross Profit', cv.grossProfit, {bold:true, color:'blue'});
 body += customLinesFor('after_gross_profit', cv, mkRow);

 //  BOND FEES 
 body += mkSec('Bond Fees', 'var(--th-bond)');
 body += mkRow('Compliance Bond Fee', cv.finExpCB.map(v=>-v), {ind:true, color:'amber'});
 body += mkRow('Upfront Bond Fee', cv.finExpUB.map(v=>-v), {ind:true, color:'amber'});
 body += mkRow('Profit before OPEX / Interest', cv.profitBeforeOpex, {bold:true, color:'blue'});
 body += customLinesFor('after_profit_b_opex', cv, mkRow);

 //  OPEX / BELOW-THE-LINE 
 body += mkSec('OPEX & Interest', 'var(--th-opex)');
 body += mkRow('OPEX Buffer ('+(CFG.opxbuf??30)+'% of Revenue)', cv.opexBuffer.map(v=>-v), {ind:true, color:'amber'});
 body += mkRow('Hedging Adjustment (monthly)', cv.hedgingArr.map(v=>-v), {ind:true});
 body += mkRow('Financing Cost (on neg. CF)', cv.finCostArr.map(v=>-v), {ind:true, color:'amber'});
 body += customLinesFor('after_ebit', cv, mkRow);
 body += mkRow('EBIT', cv.ebit, {bold:true, color:'blue'});
 body += mkRow('EBITDA', cv.ebitda, {bold:true, color:'teal'});

 } else {
 // CF
 const totalIncomeCF = cv.totalIncomeCF;
 const totInflow = totalIncomeCF.slice();
 const totOutflow = cv.totalCogsCFAdj.map((v,i) => v + cv.opexBufferCF[i] + cv.finExpCB[i] + cv.finExpUB[i] + cv.hedgingArr[i] + cv.finCostArr[i]);
 const netCFcheck = totInflow.map((v,i) => v - totOutflow[i]);
 let a=0; const accumCFcheck = netCFcheck.map(v=>{a+=v;return a;});

 body += mkSec('INFLOWS', 'var(--th-cf-in)');
 Object.entries(cv.revCatsCF).forEach(([cat,arr]) => body += mkRow(cat, arr, {ind:true}));
 body += mkRow('Penalties', cv.penArrCF, {ind:true,color:'amber'});
 body += mkRow('VAT Inflow (IGV)', cv.vatIn, {ind:true,color:'teal'});
 body += mkRow('Total Inflows', totInflow, {bold:true});

 body += mkSec('OUTFLOWS', 'var(--th-cf-out)');
 cv.userCats.forEach(c => body += mkRow(c, cv.costCatCF[c]||Z(), {ind:true}));
 body += mkRow('Contingency', cv.costCatCF['Contingency']||Z(), {ind:true});
 body += mkRow('OPEX Buffer ('+(CFG.opxbuf??30)+'%)', cv.opexBufferCF, {ind:true,color:'amber'});
 body += mkRow('Financial Exp  -  CB', cv.finExpCB, {ind:true,color:'amber'});
 body += mkRow('Financial Exp  -  UB', cv.finExpUB, {ind:true,color:'amber'});
 body += mkRow('Hedging', cv.hedgingArr, {ind:true,color:'purple'});
 body += mkRow('Financing Cost (on neg. CF)', cv.finCostArr, {ind:true,color:'amber'});
 body += mkRow('VAT Outflow', cv.vatOut, {ind:true,color:'red'});
 body += mkRow('VAT NET to SUNAT', vatNet, {ind:true});
 body += mkRow('Total Outflows', totOutflow, {bold:true});

 body += mkSec('NET CASH FLOW', 'var(--th-bond)');
 body += mkRow('NET CF from Operations', netCFcheck, {bold:true,color:'blue'});
 // Accumulated: show running total per year column
 body += mkRow('Accumulated CF', accumCFcheck, {bold:true,color:'purple'});
 }

 const html = makeHead() + '<tbody>' + body + '</tbody>';
 document.getElementById(tblId).innerHTML = html;

 // Wire year-toggle clicks
 document.getElementById(tblId).querySelectorAll('.yr-col-hdr').forEach(th => {
 th.addEventListener('click', () => {
 const yi = parseInt(th.dataset.yi);
 if (which === 'pl') plYearOpen[yi] = !plYearOpen[yi];
 else cfYearOpen[yi] = !cfYearOpen[yi];
 if (which === 'pl') renderPL(); else renderCF();
 });
 });
}

//  COST SUMMARY 
function renderCostSummary() {
 const cv = compute();
 const wrap = document.getElementById('costs-content');
 wrap.innerHTML = '';

 const allItems = [...capex, ...opex];
 // Grand total = COGS + contingency + finExpCB (everything that goes into TOTAL COST)
 const capexRaw = capex.reduce((s, it) => s + getBase(it), 0);
 const opexRaw = opex.reduce((s, it) => s + getBase(it), 0);
 const conTot = rSum(cv.costCat['Contingency']||Z());
 const cbTot = rSum(cv.finExpCB);
 const ubTot = rSum(cv.finExpUB);
 const hedgTot = rSum(cv.hedgingArr);
 const opexBufTot= rSum(cv.opexBuffer);
 const totalCogs = rSum(cv.totalCogsAdj);
 const totalCostAll = totalCogs + opexBufTot + hedgTot + ubTot;

 // grandTot = sum of all items + contingency + cb for % weight denominator
 const grandTot = capexRaw + opexRaw + conTot + cbTot;

 const w = (v) => grandTot > 0 ? (v / grandTot * 100).toFixed(1) + '%' : ' - ';
 const wBar = (v) => {
 if (!grandTot) return '';
 const pct = Math.min(v / grandTot * 100, 100);
 return `<div style="height:4px;background:#e0e8f0;border-radius:2px;margin-top:3px;width:80px">
 <div style="height:4px;background:#0176D3;border-radius:2px;width:${pct}%"></div></div>`;
 };

 const tbl = document.createElement('table');
 tbl.className = 'cs-table';
 tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px';

 tbl.innerHTML = `<thead><tr style="background:#032D60;color:#fff">
 <th style="width:34px;padding:8px 10px;text-align:left">#</th>
 <th style="padding:8px 10px;text-align:left;min-width:200px">DESCRIPTION</th>
 <th style="padding:8px 10px;text-align:center;width:60px">Q</th>
 <th style="padding:8px 10px;text-align:right;min-width:120px">UNIT (USD)</th>
 <th style="padding:8px 10px;text-align:right;min-width:120px">TOTALS (USD)</th>
 <th style="padding:8px 10px;text-align:center;width:90px">% WEIGHT</th>
 <th style="padding:8px 10px;text-align:left;min-width:140px">Reference</th>
 </tr></thead>`;

 const tbody = document.createElement('tbody');

 //  COST section header 
 const costHdr = document.createElement('tr');
 costHdr.style.cssText = 'background:#032D60;color:#fff;font-weight:700';
 const capexTot = capex.reduce((s,it)=>s+getBase(it),0);
 costHdr.innerHTML = `<td colspan="2" style="padding:7px 10px;font-size:11px;letter-spacing:.05em">COST</td>
 <td style="text-align:center;padding:7px 10px">1</td>
 <td class="num" style="padding:7px 10px">$ ${fmt(capexRaw)}</td>
 <td class="num" style="padding:7px 10px">$ ${fmt(capexRaw)}</td>
 <td style="padding:7px 10px;text-align:center;font-size:11px;opacity:.8">${w(capexRaw)}</td>
 <td style="padding:7px 10px"></td>`;
 tbody.appendChild(costHdr);

 // CAPEX items (individual)
 let idx = 1;
 capex.forEach(it => {
 const base = getBase(it);
 const pct = grandTot > 0 ? (base/grandTot*100).toFixed(1)+'%' : '';
 const isQuoted = it.refNote || it.refUrl;
 const refTxt = it.refNote ? it.refNote : (it.refUrl ? '' : '');
 const tr = document.createElement('tr');
 tr.style.cssText = 'border-bottom:1px solid #f0eeec';
 tr.innerHTML = `
 <td style="padding:6px 10px;color:#aaa;font-size:11px">${idx}</td>
 <td style="padding:6px 10px;font-weight:500">
 ${isQuoted ? '<span style="background:#FFDE7A;color:#444;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:6px">Quoted</span>' : ''}
 ${it.name||'Unnamed'}
 </td>
 <td style="text-align:center;padding:6px 10px;color:#666">1</td>
 <td class="num" style="padding:6px 10px">$ ${fmt(base)}</td>
 <td class="num" style="padding:6px 10px;font-weight:600">$ ${fmt(base)}</td>
 <td style="padding:6px 10px;text-align:center">
 <div style="font-size:11px;font-weight:700;color:#0176D3">${w(base)}</div>
 ${wBar(base)}
 </td>
 <td style="padding:6px 10px;font-size:11px;color:#888">${refTxt}</td>`;
 tbody.appendChild(tr);
 idx++;
 });

 // Contingency row (% based)
 if (CFG.con > 0) {
 const conTr = document.createElement('tr');
 conTr.style.cssText = 'border-bottom:1px solid #f0eeec;color:#444';
 conTr.innerHTML = `<td style="padding:6px 10px;color:#aaa;font-size:11px">${idx}</td>
 <td style="padding:6px 10px">Contingency</td>
 <td style="text-align:center;padding:6px 10px;color:#A56105;font-weight:700">${CFG.con}%</td>
 <td class="num" style="padding:6px 10px"></td>
 <td class="num" style="padding:6px 10px;font-weight:600">$ ${fmt(conTot)}</td>
 <td style="padding:6px 10px;text-align:center">
 <div style="font-size:11px;font-weight:700;color:#A56105">${w(conTot)}</div>
 ${wBar(conTot)}
 </td>
 <td style="padding:6px 10px"></td>`;
 tbody.appendChild(conTr);
 idx++;
 }

 // Support / Compliance Bond row
 if (cbTot > 0) {
 const cbTr = document.createElement('tr');
 cbTr.style.cssText = 'border-bottom:1px solid #f0eeec;color:#444';
 cbTr.innerHTML = `<td style="padding:6px 10px;color:#aaa;font-size:11px">${idx}</td>
 <td style="padding:6px 10px">Support & monitoring CIPRL (Compliance Bond)</td>
 <td style="text-align:center;padding:6px 10px;color:#A56105;font-weight:700">${CFG.fcbCost}%</td>
 <td class="num" style="padding:6px 10px"></td>
 <td class="num" style="padding:6px 10px;font-weight:600">$ ${fmt(cbTot)}</td>
 <td style="padding:6px 10px;text-align:center">
 <div style="font-size:11px;font-weight:700;color:#A56105">${w(cbTot)}</div>
 ${wBar(cbTot)}
 </td>
 <td style="padding:6px 10px"></td>`;
 tbody.appendChild(cbTr);
 idx++;
 }

 // TOTAL COGS row
 const totCogsRow = document.createElement('tr');
 totCogsRow.style.cssText = 'background:#e8edf2;font-weight:700;border-top:2px solid #032D60';
 totCogsRow.innerHTML = `<td colspan="2" style="padding:7px 10px;text-align:right;font-size:12px">TOTAL COGS</td>
 <td style="padding:7px 10px;text-align:center">1</td>
 <td class="num" style="padding:7px 10px"></td>
 <td class="num" style="padding:7px 10px">$ ${fmt(totalCogs)}</td>
 <td style="padding:7px 10px;text-align:center;font-size:11px;font-weight:700">100%</td>
 <td></td>`;
 tbody.appendChild(totCogsRow);

 // OPEX Buffer row
 const opexRow = document.createElement('tr');
 opexRow.style.cssText = 'background:#fff7e8;font-weight:600;color:#A56105';
 opexRow.innerHTML = `<td style="padding:7px 10px;color:#A56105;font-size:11px">HQ</td>
 <td style="padding:7px 10px">OPEX Buffer</td>
 <td style="text-align:center;padding:7px 10px;font-weight:700">${CFG.opxbuf??30}%</td>
 <td class="num" style="padding:7px 10px"></td>
 <td class="num" style="padding:7px 10px">$ ${fmt(opexBufTot)}</td>
 <td style="padding:7px 10px;text-align:center">
 <div style="font-size:11px;font-weight:700;color:#A56105">${grandTot > 0 ? (opexBufTot/(totalCostAll||1)*100).toFixed(1)+'%' : ' - '}</div>
 </td>
 <td style="padding:7px 10px"></td>`;
 tbody.appendChild(opexRow);

 // TOTAL OPERATING COST
 const totOpRow = document.createElement('tr');
 totOpRow.style.cssText = 'background:#e8edf2;font-weight:700;border-top:2px solid #032D60';
 totOpRow.innerHTML = `<td colspan="4" style="padding:7px 10px;text-align:right;font-size:12px">TOTAL OPERATING COST</td>
 <td class="num" style="padding:7px 10px">$ ${fmt(totalCogs + opexBufTot)}</td>
 <td colspan="2"></td>`;
 tbody.appendChild(totOpRow);

 // Hedging row
 if (hedgTot > 0) {
 const hedgRow = document.createElement('tr');
 hedgRow.style.cssText = 'border-bottom:1px solid #f0eeec;color:#5A2D82';
 hedgRow.innerHTML = `<td colspan="2" style="padding:6px 10px;padding-left:20px">Hedging</td>
 <td style="text-align:center;padding:6px 10px;font-weight:700">${CFG.hedg}%</td>
 <td class="num" style="padding:6px 10px"></td>
 <td class="num" style="padding:6px 10px">$ ${fmt(hedgTot)}</td>
 <td style="padding:6px 10px;text-align:center">
 <div style="font-size:11px;font-weight:700;color:#5A2D82">${grandTot > 0 ? (hedgTot/(totalCostAll||1)*100).toFixed(1)+'%' : ' - '}</div>
 </td>
 <td></td>`;
 tbody.appendChild(hedgRow);
 }

 // Upfront Bond
 if (ubTot > 0) {
 const ubRow = document.createElement('tr');
 ubRow.style.cssText = 'border-bottom:1px solid #f0eeec;color:#444';
 ubRow.innerHTML = `<td colspan="2" style="padding:6px 10px;padding-left:20px">Financing cost (Upfront Bond)</td>
 <td style="text-align:center;padding:6px 10px;font-weight:700">${CFG.fub}%</td>
 <td class="num" style="padding:6px 10px"></td>
 <td class="num" style="padding:6px 10px">$ ${fmt(ubTot)}</td>
 <td style="padding:6px 10px;text-align:center">
 <div style="font-size:11px;font-weight:700;color:#444">${grandTot > 0 ? (ubTot/(totalCostAll||1)*100).toFixed(1)+'%' : ' - '}</div>
 </td>
 <td></td>`;
 tbody.appendChild(ubRow);
 }

 // TOTAL COST
 const totCostRow = document.createElement('tr');
 totCostRow.style.cssText = 'background:#032D60;color:#fff;font-weight:700;border-top:2px solid #032D60';
 totCostRow.innerHTML = `<td colspan="4" style="padding:8px 10px;text-align:right;font-size:12px;letter-spacing:.03em">TOTAL COST</td>
 <td class="num" style="padding:8px 10px">$ ${fmt(totalCostAll)}</td>
 <td colspan="2"></td>`;
 tbody.appendChild(totCostRow);

 //  Summary lines (OPEX items breakdown) 
 const opexItems = [...capex,...opex];
 if (opexItems.length) {
 const spacer = document.createElement('tr');
 spacer.innerHTML = '<td colspan="6" style="padding:6px 0;background:#f8fafc"></td>';
 tbody.appendChild(spacer);

 // Group summary by name (matching Image 1 bottom section)
 // Dynamic summary groups: one row per unique category
 const allCatNames = [...new Set([...capex,...opex].map(it => (it.cat||'Other').trim()||'Other'))];
 const summaryGroups = allCatNames.map(cat => ({
 label: cat,
 filter: it => (it.cat||'Other').trim() === cat
 }));
 summaryGroups.forEach(g => {
 const grpItems = allItems.filter(g.filter);
 if (!grpItems.length) return;
 const grpTot = grpItems.reduce((s,it)=>s+getBase(it),0);
 const tr = document.createElement('tr');
 tr.style.cssText = 'border-bottom:1px solid #f0eeec';
 tr.innerHTML = `<td colspan="2" style="padding:5px 10px;font-weight:600;color:#333">${g.label}</td>
 <td style="text-align:center;padding:5px 10px">1</td>
 <td class="num" style="padding:5px 10px">$ ${fmt(grpTot)}</td>
 <td class="num" style="padding:5px 10px;font-weight:600">$ ${fmt(grpTot)}</td>
 <td style="padding:5px 10px;text-align:center">
 <div style="font-size:11px;font-weight:700;color:#0176D3">${w(grpTot)}</div>
 ${wBar(grpTot)}
 </td>
 <td></td>`;
 tbody.appendChild(tr);
 });

 // Penalties summary
 const penTot = rSum(cv.penArr);
 if (penTot) {
 const penTr = document.createElement('tr');
 penTr.style.cssText = 'border-bottom:1px solid #f0eeec;color:#A56105';
 penTr.innerHTML = `<td colspan="2" style="padding:5px 10px;font-weight:600">Penalties</td>
 <td style="text-align:center;padding:5px 10px;font-weight:700">-${CFG.pen}%</td>
 <td class="num" style="padding:5px 10px"></td>
 <td class="num" style="padding:5px 10px;font-weight:600">$ ${fmt(penTot)}</td>
 <td style="padding:5px 10px;text-align:center;font-size:11px;color:#BA0517;font-weight:700">-${CFG.pen}%</td>
 <td></td>`;
 tbody.appendChild(penTr);
 }

 // TOTAL PRICE SF
 const totalIncomeTot = rSum(cv.totalIncome);
 const tpRow = document.createElement('tr');
 tpRow.style.cssText = 'background:#e8f4fd;font-weight:700;border-top:2px solid #0176D3';
 tpRow.innerHTML = `<td colspan="4" style="padding:7px 10px;text-align:right;color:#032D60">TOTAL PRICE SF (Discounting Penalties)</td>
 <td class="num" style="padding:7px 10px;color:#032D60">$ ${fmt(totalIncomeTot)}</td>
 <td colspan="2"></td>`;
 tbody.appendChild(tpRow);

 // TOTAL AMOUNT DEAL
 const tadRow = document.createElement('tr');
 tadRow.style.cssText = 'background:#06A59A;color:#fff;font-weight:700;border-top:2px solid #06A59A';
 tadRow.innerHTML = `<td colspan="4" style="padding:8px 10px;text-align:right;font-size:13px">TOTAL AMOUNT DEAL</td>
 <td class="num" style="padding:8px 10px;font-size:13px">$ ${fmt(totalIncomeTot)}</td>
 <td colspan="2"></td>`;
 tbody.appendChild(tadRow);
 }

 tbl.appendChild(tbody);
 wrap.appendChild(tbl);
}

//  P&L 
function pctBadge(num, den) {
 if (!den || rSum(den.map(Math.abs)) === 0) return '';
 const pct = (rSum(num) / rSum(den.map(Math.abs)) * 100).toFixed(2);
 const color = parseFloat(pct) >= 0 ? '#2E844A' : '#BA0517';
 return '<span style="margin-left:10px;font-size:11px;font-weight:700;color:' + color + '">' + pct + '%</span>';
}

function renderPL() {
 const togWrap = document.getElementById('pl-view-tog');
 togWrap.innerHTML = '';
 const tog = buildToggle(plView, v => { plView = v; renderPL(); });
 if (tog) togWrap.appendChild(tog);

 const cv = compute();
 const view = plView;

 // Grouped view  -  delegate to renderGroupedTable
 if (view === 'grouped') {
 renderGroupedPLCF('pl', cv);
 return;
 }

 const cols = view === 'annual' ? yrLabels() : AMs().map(m => mInfo(m).label);
 const mNums = view === 'annual' ? null : AMs();
 const cw = view === 'annual' ? 110 : 82;

 // Helper: bold summary row with optional % margin badge on label
 function sumRow(label, arr, color, pctArr) {
 const d = view === 'annual' ? aggY(arr) : arr;
 const tot = rSum(arr);
 const badge = pctArr ? pctBadge(arr, pctArr) : '';
 const c = color || '';
 return '<tr class="bold-row">'
 + '<td class="lbl bold" style="' + (c ? 'color:' + c : '') + '">' + label + badge + '</td>'
 + d.map(v => '<td class="num bold' + (v<0?' c-red':'') + (c?' style="color:'+c+'"':'') + '">' + fmt(v) + '</td>').join('')
 + '<td class="num tot bold' + (tot<0?' c-red':'') + (c?' style="color:'+c+'"':'') + '">' + fmt(tot) + '</td>'
 + '</tr>';
 }

 // Helper: item-level expandable COGS row
 function cogsExpandRow(cat, catArr, catItems) {
 const rowId = 'plcat-' + cat.replace(/\s+/g,'_');
 // catArr is the raw sum  -  positive costs, negative credits.
 // For P&L display we negate the category total (costs are shown as negative).
 // But credits (negative items) have already been stored negative  negating makes them positive  shown as a reduction.
 const dispArr = catArr.map(v => -v); // flip sign for display: costnegative, creditpositive
 const d = view === 'annual' ? aggY(dispArr) : dispArr;
 const tot = rSum(dispArr);
 let h = '';
 if (catItems.length > 0) {
 h += '<tr class="pl-expandable" data-expand="' + rowId + '">'
 + '<td class="lbl ind"><span class="pl-expand-arrow"></span>' + cat + '</td>'
 + d.map(v => '<td class="num' + (v<0?' c-red':'') + '">' + fmt(v) + '</td>').join('')
 + '<td class="num tot' + (tot<0?' c-red':'') + '">' + fmt(tot) + '</td>'
 + '</tr>';
 catItems.forEach(it => {
 // Individual item: negate for display (costnegative, credit stays positive)
 const itRaw = getDistArr(it);
 const itArr = itRaw.map(v => -v);
 const itD = view === 'annual' ? aggY(itArr) : itArr;
 const itTot = rSum(itArr);
 const refTip = [it.refNote, it.refUrl ? '' : ''].filter(Boolean).join(' ');
 const isCredit = !!it.negative;
 const creditBadge = isCredit ? ' <span style="font-size:9px;background:#e8f7ec;color:#2E844A;padding:1px 5px;border-radius:3px;font-weight:700;margin-left:4px">CREDIT</span>' : '';
 const name = (it.name||'Unnamed') + creditBadge + (refTip ? ' <span style="font-size:10px;color:var(--blue)" title="' + refTip.replace(/"/g,"'") + '"></span>' : '');
 h += '<tr class="pl-item-row" data-group="' + rowId + '">'
 + '<td class="lbl" style="padding-left:44px;font-size:11px;color:#555">' + name + '</td>'
 + itD.map(v => '<td class="num" style="font-size:11px;' + (v<0?'color:#BA0517':isCredit?'color:#2E844A':'color:#555') + '">' + fmt(v) + '</td>').join('')
 + '<td class="num" style="font-size:11px;' + (itTot<0?'color:#BA0517':isCredit?'color:#2E844A':'color:#555') + '">' + fmt(itTot) + '</td>'
 + '</tr>';
 });
 } else {
 h += dataRow(cat, dispArr, view, {ind:true});
 }
 return h;
 }

 let h = tHead(cols, cw, mNums) + '<tbody>';

 // Build all row segments keyed by ID
 const DR = (arr, opts) => dataRow.bind(null, null, arr, view, opts);

 function plSeg(id) {
 switch(id) {
 case 'pl_income_sec': return secRow('INCOME', 'var(--th-income)');
 case 'pl_rev_cats':
 return Object.entries(cv.revCats).map(([cat, arr]) =>
 dataRow(cat, arr, view, {ind:true})).join('');
 case 'pl_penalties':
 return dataRow('Penalties', cv.penArr, view, {ind:true, color:'amber'});
 case 'pl_adj_inc':
 return cv.adjIncomeRows.map(ac => {
 const s = ac.arr.map(v => ac.adj.sign === 'add' ? v : -v);
 return dataRow((ac.adj.name||'Adj') + ' (' + (ac.adj.pct||0) + '%)', s, view, {ind:true, color:'amber'});
 }).join('');
 case 'pl_total_income':
 return sumRow('Total Income', cv.totalIncome, 'var(--th-income)')
 + addLineRow('income_section', nc)
 + customLinesFor('income_section', cv, (lbl,arr,opts) => dataRow(lbl, arr, view, opts));
 case 'pl_cogs_sec': return secRow('COGS', 'var(--th-cogs)');
 case 'pl_cost_cats':
 return cv.userCats.map(cat => {
 const catArr = cv.costCat[cat] || Z();
 const catItems = [...capex, ...opex].filter(it => (it.cat||'Other').trim() === cat);
 return cogsExpandRow(cat, catArr, catItems);
 }).join('');
 case 'pl_contingency':
 return dataRow('Contingency (' + CFG.con + '%)', (cv.costCat['Contingency']||Z()).map(v=>-v), view, {ind:true});
 case 'pl_adj_cost':
 return cv.adjCostRows.map(ac => {
 const s = ac.arr.map(v => -(ac.adj.sign === 'add' ? v : -v));
 return dataRow((ac.adj.name||'Adj') + ' (' + (ac.adj.pct||0) + '%)', s, view, {ind:true, color:'amber'});
 }).join('');
 case 'pl_total_cogs':
 return sumRow('Total COGS', cv.totalCogsAdj.map(v => -v), 'var(--th-cogs)')
 + addLineRow('cogs_section', nc)
 + customLinesFor('cogs_section', cv, (lbl,arr,opts) => dataRow(lbl, arr, view, opts));
 case 'pl_gross_profit':
 return sumRow('Gross Profit', cv.grossProfit, 'var(--accent)', cv.totalIncome)
 + addLineRow('after_gross_profit', nc)
 + customLinesFor('after_gross_profit', cv, (lbl,arr,opts) => dataRow(lbl, arr, view, opts));
 case 'pl_bond_sec': return secRow('Bond Fees', 'var(--th-bond)');
 case 'pl_cb_fee':
 return dataRow('Compliance Bond Fee', cv.finExpCB.map(v=>-v), view, {ind:true, color:'amber'});
 case 'pl_ub_fee':
 return dataRow('Upfront Bond Fee', cv.finExpUB.map(v=>-v), view, {ind:true, color:'amber'});
 case 'pl_profit_bopex':
 return sumRow('Profit before OPEX / Interest', cv.profitBeforeOpex, 'var(--accent)', cv.totalIncome)
 + addLineRow('after_profit_b_opex', nc)
 + customLinesFor('after_profit_b_opex', cv, (lbl,arr,opts) => dataRow(lbl, arr, view, opts));
 case 'pl_opex_sec': return secRow('OPEX & Interest', 'var(--th-opex)');
 case 'pl_opex_buf':
 return dataRow('OPEX Buffer (' + (CFG.opxbuf??30) + '% of Revenue)', cv.opexBuffer.map(v=>-v), view, {ind:true, color:'amber'});
 case 'pl_hedging':
 return dataRow('Hedging Adjustment (monthly)', cv.hedgingArr.map(v=>-v), view, {ind:true});
 case 'pl_fin_cost':
 return rSum(finCostArr) !== 0 ? dataRow('Financing Cost', finCostArr.map(v=>-v), view, {ind:true, color:'amber'}) : '';
 case 'pl_ebit':
 return addLineRow('after_ebit', nc)
 + customLinesFor('after_ebit', cv, (lbl,arr,opts) => dataRow(lbl, arr, view, opts))
 + sumRow('EBIT', cv.ebit, 'var(--accent)', cv.totalIncome);
 case 'pl_ebitda':
 return sumRow('EBITDA', cv.ebitda, 'var(--teal)', cv.totalIncome);
 default: return '';
 }
 }

 const finCostArr = cv.finCostArr || Z();
 const order = getRowOrder('pl');
 order.forEach(id => { h += plSeg(id); });

 h += '</tbody>';
 document.getElementById('pl-tbl').innerHTML = h;

 // Wire expand/collapse
 document.querySelectorAll('.pl-expandable').forEach(row => {
 row.addEventListener('click', () => {
 const groupId = row.dataset.expand;
 const isOpen = row.classList.toggle('open');
 document.querySelectorAll('.pl-item-row[data-group="' + groupId + '"]').forEach(r => {
 r.style.display = isOpen ? 'table-row' : 'none';
 if (isOpen) r.classList.add('visible'); else r.classList.remove('visible');
 });
 });
 });
}

//  CASH FLOW 
function renderCF() {
 const togWrap = document.getElementById('cf-view-tog');
 togWrap.innerHTML = '';
 const tog = buildToggle(cfView, v => { cfView = v; renderCF(); });
 if (tog) togWrap.appendChild(tog);

 const cv = compute();
 const view = cfView;

 if (view === 'grouped') {
 renderGroupedPLCF('cf', cv);
 return;
 }
 const cols = view === 'annual' ? yrLabels() : AMs().map(m => mInfo(m).label);
 const mNums = view === 'annual' ? null : AMs();
 const cw = view === 'annual' ? 110 : 82;
 const nc = cols.length;

 // Use CF-timed revenue from compute()
 const totalIncomeCF = cv.totalIncomeCF;
 const vatNet = cv.vatIn.map((v, i) => v - cv.vatOut[i]);
 // Total inflows = CF revenue + VAT collected
 const totInflow = totalIncomeCF.slice();
 const finCost = cv.finCostArr || Z();
 const totOutflow = cv.totalCogsCFAdj.map((v, i) =>
 v + cv.opexBufferCF[i] + cv.finExpCB[i] + cv.finExpUB[i] + cv.hedgingArr[i] + finCost[i]
 );
 // NET CF = totInflow - totOutflow (should match cv.netCF + VAT pass-through)
 const netCFcheck = totInflow.map((v, i) => v - totOutflow[i]);

 let h = tHead(cols, cw, mNums) + '<tbody>';

 const cfDataRow = (lbl, arr, opts) => dataRow(lbl, arr, view, opts);

 //  INFLOWS 
 h += secRow('INFLOWS', 'var(--th-cf-in)');
 Object.entries(cv.revCatsCF).forEach(([cat, arr]) => h += cfDataRow(cat, arr, {ind:true}));
 h += cfDataRow('Penalties', cv.penArrCF, {ind:true, color:'amber'});
 cv.adjIncomeRows.forEach(ac => {
 h += cfDataRow((ac.adj.name||'Adj') + ' (' + (ac.adj.pct||0) + '%)', ac.arrCF, {ind:true, color:'amber'});
 });
 customLines.filter(l => l.showInCF && l.section === 'income_section' && l.formula.trim()).forEach(l => {
 h += cfDataRow(l.name||'Custom', evalCustomLineArr(l, cv), {ind:true, color:'amber'});
 });
 customLines.filter(l => l.showInCF && l.section === 'cf_after_inflows' && l.formula.trim()).forEach(l => {
 const arr = evalCustomLineArr(l, cv);
 h += cfDataRow(l.name||'Custom', arr, {ind:true, color:'amber'});
 });
 h += cfDataRow('Total Inflows', totInflow, {bold:true});
 h += addLineRow('cf_after_inflows', nc);

 //  OUTFLOWS 
 h += secRow('OUTFLOWS', 'var(--th-cf-out)');
 cv.userCats.forEach(c => h += cfDataRow(c, cv.costCatCF[c] || Z(), {ind:true}));
 h += cfDataRow('Contingency (' + CFG.con + '%)', cv.costCatCF['Contingency'] || Z(), {ind:true});
 cv.adjCostRows.forEach(ac => {
 h += cfDataRow((ac.adj.name||'Adj') + ' (' + (ac.adj.pct||0) + '%)', ac.arrCF, {ind:true, color:'amber'});
 });
 customLines.filter(l => l.showInCF && l.section === 'cogs_section' && l.formula.trim()).forEach(l => {
 h += cfDataRow(l.name||'Custom', evalCustomLineArr(l, cv), {ind:true, color:'amber'});
 });
 h += cfDataRow('OPEX Buffer (' + (CFG.opxbuf ?? 30) + '%)', cv.opexBufferCF, {ind:true, color:'amber'});
 h += cfDataRow('Compliance Bond Fee', cv.finExpCB, {ind:true, color:'amber'});
 h += cfDataRow('Upfront Bond Fee', cv.finExpUB, {ind:true, color:'amber'});
 h += cfDataRow('Hedging (monthly)', cv.hedgingArr, {ind:true});
 if (rSum(finCost) !== 0) h += cfDataRow('Financing Cost', finCost, {ind:true, color:'amber'});
 customLines.filter(l => l.showInCF && l.section === 'cf_after_outflows' && l.formula.trim()).forEach(l => {
 const arr = evalCustomLineArr(l, cv);
 h += cfDataRow(l.name||'Custom', arr, {ind:true, color:'amber'});
 });
 h += cfDataRow('Total Outflows', totOutflow, {bold:true});
 h += addLineRow('cf_after_outflows', nc);

 //  NET CF 
 h += secRow('NET CASH FLOW', 'var(--th-bond)');
 customLines.filter(l => l.showInCF && ['after_gross_profit','after_profit_b_opex'].includes(l.section) && l.formula.trim()).forEach(l => {
 h += cfDataRow(l.name||'Custom', evalCustomLineArr(l, cv), {ind:true, color:'amber'});
 });
 const accumCFcheck = (() => { let a=0; return netCFcheck.map(v => { a+=v; return a; }); })();
 h += cfDataRow('Net Cash Flow', netCFcheck, {bold:true});
 h += cfDataRow('Accumulated CF', accumCFcheck, {bold:true, acc:true});

 //  NPV 
 h += secRow('NPV ANALYSIS', 'var(--th-bond)');
 h += infoRow('Discount Rate', CFG.dis + '% p.a.  ' + (cv.mRate * 100).toFixed(3) + '% /mo', 'var(--sub)', nc);
 h += infoRow('NPV (Net CF)', 'USD ' + fmt(cv.npvCF), cv.npvCF >= 0 ? 'var(--green)' : 'var(--red)', nc);
 h += infoRow('NPV (Income)', 'USD ' + fmt(cv.npvInc), 'var(--blue)', nc);
 const peakNeg = Math.min(...cv.accumCF, 0);
 const beIdx = cv.accumCF.findIndex(v => v >= 0);
 h += infoRow('Peak Negative CF', 'USD ' + fmt(peakNeg), 'var(--sub)', nc);
 h += infoRow('Break-even Month', beIdx >= 0 ? 'M' + (beIdx+1) + ' (' + mInfo(beIdx+1).label + ')' : 'Not reached', 'var(--sub)', nc);

 h += '</tbody>';
 document.getElementById('cf-tbl').innerHTML = h;
}

//  DASHBOARD 
function renderDashboard() {
 const cv = compute();
 const tR = rSum(cv.totalIncome), tC = rSum(cv.totalCogsAdj);
 const tG = rSum(cv.grossProfit), tN = rSum(cv.netCF);
 const mg = tR ? (tG / tR * 100).toFixed(2) : '0.00';

 document.getElementById('kpi-grid').innerHTML = [
 ['Total Revenue', '$'+fmtK(tR), '#06A59A'],
 ['Total COGS', '$'+fmtK(tC), '#BA0517'],
 ['Gross Profit', '$'+fmtK(tG), '#0176D3'],
 ['GP Margin', mg+'%', '#1B96FF'],
 ['Net Cash Flow', '$'+fmtK(tN), tN >= 0 ? '#2E844A' : '#BA0517'],
 ['EBIT', '$'+fmtK(rSum(cv.ebit)), rSum(cv.ebit) >= 0 ? '#2E844A' : '#BA0517'],
 ['NPV', '$'+fmtK(cv.npvCF), '#5A2D82'],
 ].map(([l, v, c]) =>
 '<div class="kpi">'
 + '<div class="kpi-lbl">' + l + '</div>'
 + '<div class="kpi-val" style="color:' + c + ';text-shadow:0 0 22px ' + c + '66">' + v + '</div></div>'
 ).join('');

 // toggle
 const ctWrap = document.getElementById('chart-view-tog');
 ctWrap.innerHTML = '';
 const tog = buildToggle(chartView, v => { chartView = v; renderDashboard(); });
 if (tog) ctWrap.appendChild(tog);

 const isA = chartView === 'annual';
 const dI = isA ? aggY(cv.totalIncome) : cv.totalIncome;
 const dC = isA ? aggY(cv.totalCogsAdj) : cv.totalCogsAdj;
 const dN = isA ? aggY(cv.netCF) : cv.netCF;
 const dA = isA ? aggAccY(cv.accumCF) : cv.accumCF;
 const dL = isA ? yrLabels() : AMs().map(m => mInfo(m).short);
 const mxI = Math.max(...dI.map(Math.abs), 1);
 const mxN = Math.max(...dN.map(Math.abs), 1);
 const mxA = Math.max(...dA.map(Math.abs), 1);
 const bw = isA ? 18 : 7;

 document.getElementById('rc-chart-title').textContent = 'Revenue vs COGS  -  ' + (isA ? 'Annual' : 'Monthly');

 //  Chart helper: SVG-based bar chart 
 function makeSVGChart(container, series, labels, opts) {
 opts = opts || {};
 const W = container.clientWidth || 600;
 const H = opts.h || 160;
 const PAD = { t:16, r:12, b:32, l:52 };
 const cW = W - PAD.l - PAD.r;
 const cH = H - PAD.t - PAD.b;
 const n = labels.length;
 const barW = Math.max(4, Math.min(24, cW / n / (series.length + 0.5) - 2));
 const grpW = barW * series.length + 4;
 const grpGap= Math.max(2, (cW - grpW * n) / (n + 1));

 // compute y scale
 const allVals = series.flatMap(s => s.data);
 const minV = Math.min(0, ...allVals);
 const maxV = Math.max(0, ...allVals);
 const range = (maxV - minV) || 1;
 const toY = v => PAD.t + cH - ((v - minV) / range) * cH;
 const zeroY = toY(0);

 let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="overflow:visible">`;

 // Grid lines
 const steps = 4;
 for (let s = 0; s <= steps; s++) {
 const v = minV + (range / steps) * s;
 const y = toY(v);
 const lbl = fmtK(v);
 svg += `<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" stroke="#e8e8e8" stroke-width="1"/>`;
 svg += `<text x="${PAD.l - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="#999">${lbl}</text>`;
 }
 // Zero line
 svg += `<line x1="${PAD.l}" y1="${zeroY}" x2="${W - PAD.r}" y2="${zeroY}" stroke="#ccc" stroke-width="1.5"/>`;

 // Bars
 labels.forEach((lbl, i) => {
 const grpX = PAD.l + grpGap + i * (grpW + grpGap);
 series.forEach((ser, si) => {
 const v = ser.data[i] || 0;
 const x = grpX + si * (barW + 1);
 const y1 = Math.min(toY(v), zeroY);
 const y2 = Math.max(toY(v), zeroY);
 const bh = Math.max(1, y2 - y1);
 const col = typeof ser.color === 'function' ? ser.color(v) : ser.color;
 svg += `<rect x="${x}" y="${y1}" width="${barW}" height="${bh}" fill="${col}" opacity="${ser.opacity||1}" rx="1">
 <title>${ser.label}: ${fmt(v)}</title></rect>`;
 // Value label for annual view
 if (isA && Math.abs(v) > 0) {
 svg += `<text x="${x+barW/2}" y="${y1-3}" text-anchor="middle" font-size="8" fill="${col}" font-weight="600">${fmtK(v)}</text>`;
 }
 });
 // X axis label
 const lblX = grpX + grpW / 2;
 svg += `<text x="${lblX}" y="${H - PAD.b + 14}" text-anchor="middle" font-size="${isA?10:8}" fill="#888" ${!isA?'transform="rotate(-35,'+lblX+','+(H-PAD.b+14)+')"':''}>${lbl}</text>`;
 });

 svg += '</svg>';
 container.innerHTML = svg;
 }

 //  Line chart for accumulated CF 
 function makeLineChart(container, lineData, labels, color) {
 const W = container.clientWidth || 600;
 const H = 100;
 const PAD = { t:10, r:12, b:28, l:52 };
 const cW = W - PAD.l - PAD.r;
 const cH = H - PAD.t - PAD.b;
 const n = lineData.length;
 const minV = Math.min(0, ...lineData);
 const maxV = Math.max(0, ...lineData);
 const range = (maxV - minV) || 1;
 const toX = i => PAD.l + (i / (n - 1 || 1)) * cW;
 const toY = v => PAD.t + cH - ((v - minV) / range) * cH;
 const zeroY = toY(0);

 let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="overflow:visible">`;
 svg += `<line x1="${PAD.l}" y1="${zeroY}" x2="${W-PAD.r}" y2="${zeroY}" stroke="#ccc" stroke-width="1"/>`;

 // Fill area
 let polyFill = `${PAD.l},${zeroY} ` + lineData.map((v,i) => `${toX(i)},${toY(v)}`).join(' ') + ` ${toX(n-1)},${zeroY}`;
 svg += `<polygon points="${polyFill}" fill="${color}" opacity="0.15"/>`;

 // Line
 const pts = lineData.map((v,i) => `${toX(i)},${toY(v)}`).join(' ');
 svg += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;

 // Break-even dot
 const beIdx = lineData.findIndex(v => v > 0);
 if (beIdx > 0) {
 svg += `<circle cx="${toX(beIdx)}" cy="${toY(lineData[beIdx])}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5">
 <title>Break-even: ${labels[beIdx]}</title></circle>`;
 svg += `<text x="${toX(beIdx)}" y="${toY(lineData[beIdx])-7}" text-anchor="middle" font-size="9" fill="${color}" font-weight="700">BE</text>`;
 }

 // Labels (sparse)
 const step = Math.max(1, Math.floor(n / 6));
 labels.forEach((lbl, i) => {
 if (i % step === 0 || i === n-1) {
 svg += `<text x="${toX(i)}" y="${H-PAD.b+12}" text-anchor="middle" font-size="8" fill="#aaa">${lbl}</text>`;
 }
 });
 svg += '</svg>';
 container.innerHTML = svg;
 }

 //  Render charts 
 const chartRC = document.getElementById('chart-rc');
 const chartNCF = document.getElementById('chart-ncf');
 const dGP = isA ? aggY(cv.grossProfit) : cv.grossProfit;
 const dEB = isA ? aggY(cv.ebit) : cv.ebit;

 makeSVGChart(chartRC, [
 { label:'Revenue', data:dI, color:'#06A59A' },
 { label:'COGS', data:dC.map(v=>Math.abs(v)), color:'#BA0517', opacity:0.8 },
 { label:'Gross Profit', data:dGP, color: v => v >= 0 ? '#0176D3' : '#A56105', opacity:0.9 },
 ], dL, { h: 170 });

 // For CF chart use line for accumulated + bars for monthly NCF
 makeSVGChart(chartNCF, [
 { label:'Net CF', data:dN, color: v => v >= 0 ? '#0176D3' : '#BA0517' },
 ], dL, { h: 110 });
 // Overlay accumulated CF as line chart below
 const accContainer = document.getElementById('chart-accum');
 if (accContainer) makeLineChart(accContainer, dA, dL, '#5A2D82');
}

//  EXPORT CSV 
document.getElementById('exp-btn').addEventListener('click', () => {
 const cv = compute();
 const cols = AMs().map(m => mInfo(m).label);
 let csv = document.getElementById('proj-name').value + '\n\n';
 csv += 'PROFIT & LOSS (USD)\nCategory,' + cols.join(',') + ',TOTAL\n';
 const plRows = [
 ['Total Income', cv.totalIncome],
 ...Object.entries(cv.revCats).map(([c,a]) => [' '+c, a]),
 [' Penalties', cv.penArr],
 ['Total COGS', cv.totalCogsAdj],
 ...cv.userCats.map(c => [' '+c, cv.costCat[c] || Z()]),
 [' Contingency', cv.costCat['Contingency'] || Z()],
 ['Gross Profit', cv.grossProfit],
 ['EBIT', cv.ebit],
 ['EBITDA', cv.ebitda],
 ];
 plRows.forEach(([l, d]) => { csv += l + ',' + d.map(fmt).join(',') + ',' + fmt(rSum(d)) + '\n'; });

 csv += '\nCASH FLOW (USD)\nCategory,' + cols.join(',') + ',TOTAL\n';
 const cfRows = [
 ['Total Inflows', cv.totalIncomeCF],
 ['Total Outflows', cv.totalCogsCFAdj],
 ['NET CASH FLOW', cv.netCF],
 ['Accumulated CF', cv.accumCF],
 ['VAT to SUNAT', cv.vatToPay],
 ];
 cfRows.forEach(([l, d]) => { csv += l + ',' + d.map(fmt).join(',') + ',' + fmt(rSum(d)) + '\n'; });
 csv += '\nNPV Net CF,' + fmt(cv.npvCF)
 + '\nNPV Income,' + fmt(cv.npvInc)
 + '\nNPV Ratio,' + (cv.npvInc ? (cv.npvCF/cv.npvInc*100).toFixed(1) : 0) + '%\n';

 const a = document.createElement('a');
 a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
 a.download = (document.getElementById('proj-name').value || 'model').replace(/\s+/g,'_') + '.csv';
 a.click();
});


// 
// PORTFOLIO SYSTEM
// 

// Supabase table used for the portfolio.
// Required columns in public.projects:
// id uuid primary key, name text, category text, description text, status text,
// created_at timestamptz, updated_at timestamptz, snapshot jsonb, data jsonb.
const PROJECTS_TABLE = 'projects';
let portfolio = []; // array of saved project snapshots loaded from Supabase
let currentProjectId = null; // null = new unsaved project
let portfolioLoaded = false;

const CLASS_COLORS = {
 'Infrastructure':'#0176D3','Technology':'#5A2D82','Real Estate':'#06A59A',
 'Energy':'#A56105','Mining':'#706E6B','Services':'#2E844A',
 'Industrial':'#BA0517','Other':'#444'
};
const STATUS_COLORS = {
 'Active':'#2E844A','Draft':'#A56105','Completed':'#0176D3','On Hold':'#706E6B'
};

function normalizeProjectFromRow(row) {
 return {
  id: row.id,
  name: row.name || 'Untitled Project',
  classification: row.category || 'Infrastructure',
  description: row.description || '',
  status: row.status || 'Active',
  createdAt: row.created_at || row.createdAt || new Date().toISOString(),
  updatedAt: row.updated_at || row.updatedAt || row.created_at || new Date().toISOString(),
  snapshot: row.snapshot || {},
  data: row.data || null,
 };
}

function projectToSupabaseRow(project) {
 return {
  name: project.name || 'Untitled Project',
  category: project.classification || 'Infrastructure',
  description: project.description || '',
  status: project.status || 'Active',
  updated_at: project.updatedAt || new Date().toISOString(),
  snapshot: project.snapshot || {},
  data: project.data || {},
 };
}

async function loadPortfolio() {
  // 1. Load from localStorage immediately so UI never blocks
  const local = _lsGet();
  portfolio = local;
  portfolioLoaded = true;

  // 2. Try Supabase (no auth required — works if RLS is disabled)
  if (!_sbReady || !supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from(PROJECTS_TABLE)
      .select('id,name,category,description,status,created_at,updated_at,snapshot,data')
      .order('updated_at', { ascending: false, nullsFirst: false });

    if (error) {
      // Show the exact error so user knows what to fix
      const isRLS = error.message && (error.message.includes('row-level security') || error.code === '42501' || error.code === 'PGRST301');
      const isNoTable = error.message && (error.message.includes('does not exist') || error.code === '42P01');
      if (isRLS) {
        _sbToast('⚠️ Supabase: Row Level Security is blocking access. Run the SQL fix in Settings → Supabase.', '#A56105');
      } else if (isNoTable) {
        _sbToast('⚠️ Supabase: Table "projects" not found. Create it from Settings → Supabase.', '#A56105');
      }
      console.warn('[Supabase] loadPortfolio error:', error);
      return; // keep localStorage data
    }

    // Merge remote + local-only items
    const remote = (data || []).map(normalizeProjectFromRow);
    const remoteIds = new Set(remote.map(p => p.id));
    const localOnly = local.filter(p => p.id && String(p.id).startsWith('local_') && !remoteIds.has(p.id));
    portfolio = [...remote, ...localOnly];
    _lsSet(portfolio);
    portfolioLoaded = true;
  } catch(e) {
    console.warn('[Supabase] loadPortfolio exception:', e.message || e);
  }
}

async function saveProjectToSupabase(project) {
  const now = new Date().toISOString();
  if (!project.id) project.id = _lsId();
  project.updatedAt = now;

  // Always save to localStorage first
  const ls = _lsGet();
  const li = ls.findIndex(p => p.id === project.id);
  if (li >= 0) ls[li] = project; else ls.unshift(project);
  _lsSet(ls);

  // Try Supabase
  if (!_sbReady || !supabaseClient) return project;
  try {
    const row = {
      name: project.name || 'Untitled Project',
      category: project.classification || 'Infrastructure',
      description: project.description || '',
      status: project.status || 'Active',
      updated_at: now,
      snapshot: project.snapshot || {},
      data: project.data || {},
      // user_id intentionally omitted — requires ALTER TABLE to allow NULL
    };

    const isLocal = String(project.id).startsWith('local_');
    let result;
    if (!isLocal) {
      result = await supabaseClient.from(PROJECTS_TABLE)
        .update(row).eq('id', project.id)
        .select('id,name,category,description,status,created_at,updated_at,snapshot,data').single();
    } else {
      result = await supabaseClient.from(PROJECTS_TABLE)
        .insert([row])
        .select('id,name,category,description,status,created_at,updated_at,snapshot,data').single();
    }

    if (result.error) {
      const msg = result.error.message || '';
      const isRLS = msg.includes('row-level security') || result.error.code === '42501';
      const isNN  = msg.includes('not-null') || msg.includes('null value') || msg.includes('user_id');
      if (isRLS || isNN) {
        _sbToast('⚠️ Saved locally. Supabase blocked: run SQL fix in Settings → Supabase.', '#A56105');
      } else {
        _sbToast('⚠️ Saved locally. Supabase error: ' + msg.slice(0,80), '#A56105');
      }
      console.warn('[Supabase] save error:', result.error);
      return project;
    }

    // Success — replace local entry with remote UUID
    const remote = normalizeProjectFromRow(result.data);
    const ls2 = _lsGet();
    const li2 = ls2.findIndex(p => p.id === project.id);
    if (li2 >= 0) ls2[li2] = remote; else ls2.unshift(remote);
    _lsSet(ls2);
    return remote;
  } catch(e) {
    console.warn('[Supabase] save exception:', e.message || e);
    return project;
  }
}

async function deleteProjectFromSupabase(id) {
  // Remove from localStorage
  _lsSet(_lsGet().filter(p => p.id !== id));
  // Try Supabase
  if (!_sbReady || !supabaseClient || String(id).startsWith('local_')) return;
  try {
    const { error } = await supabaseClient.from(PROJECTS_TABLE).delete().eq('id', id);
    if (error) console.warn('[Supabase] delete error:', error.message);
  } catch(e) { console.warn('[Supabase] delete exception:', e.message); }
}

async function savePortfolio() {
 // Portfolio persistence is handled per project in saveProjectToSupabase().
 return true;
}

//  SNAPSHOT 
function buildSnapshot() {
 const cv = compute();
 const tR = rSum(cv.totalIncome), tC = rSum(cv.totalCogsAdj);
 const tG = rSum(cv.grossProfit), tN = rSum(cv.netCF);
 const mg = tR ? (tG/tR*100) : 0;
 return {
 revenue: tR,
 cogs: tC,
 gp: tG,
 margin: mg,
 netCF: tN,
 npv: cv.npvCF,
 months: PM(),
 sm: CFG.sm,
 sy: CFG.sy,
 fx: CFG.fx,
 };
}

function projectPayload() {
 return {
 cfg: { ...CFG },
 revenues: JSON.parse(JSON.stringify(revenues)),
 capex: JSON.parse(JSON.stringify(capex)),
 opex: JSON.parse(JSON.stringify(opex)),
 adjustments: JSON.parse(JSON.stringify(adjustments)),
 customLines: JSON.parse(JSON.stringify(customLines)),
 projName: document.getElementById('proj-name').value,
 };
}

function loadProjectPayload(p) {
 // Safe loader: older/test Supabase rows may have empty/null data.
 p = p && typeof p === 'object' ? p : {};
 CFG = { ...{ fx:3.75, pen:5, con:5, dis:12, months:12, sm:1, sy:2025, fcb:0, fcbCost:0, fub:0, hedg:0, opxbuf:30, finRate:0 }, ...(p.cfg || {}) };
 revenues = (p.revenues || []).map(r => ({
  ...mkRev(),
  ...r,
  lagSchedule: r.lagSchedule || [{lag:0, pct:100}],
  cfScheduleMode: r.cfScheduleMode || (r.collectionMap && Object.keys(r.collectionMap).length ? 'map' : 'terms'),
  linkedCostId: r.linkedCostId || null,
  linkedCostType: r.linkedCostType || null,
 }));
 capex = Array.isArray(p.capex) ? p.capex : [];
 opex = Array.isArray(p.opex) ? p.opex : [];
 adjustments = Array.isArray(p.adjustments) ? p.adjustments : [];
 customLines = (p.customLines || []).map(l => ({ ...mkCustomLine(), ...l }));
 const projNameEl = document.getElementById('proj-name');
 if (projNameEl) projNameEl.value = p.projName || p.name || 'Untitled';
 const numericIds = [...revenues,...capex,...opex,...adjustments]
  .map(x => Number(x && x.id))
  .filter(n => Number.isFinite(n));
 _uid = Math.max(_uid, ...numericIds, 0) + 1;
}


//  SCREEN SWITCHING 
function showPortfolio() {
 document.getElementById('portfolio-screen').style.display = '';
 document.getElementById('project-screen').style.display = 'none';
 renderPortfolio();
}
function showProject() {
 document.getElementById('portfolio-screen').style.display = 'none';
 document.getElementById('project-screen').style.display = '';
}

//  SAVE MODAL 
function openSaveModal() {
 const proj = currentProjectId ? portfolio.find(p=>p.id===currentProjectId) : null;
 document.getElementById('save-name').value = document.getElementById('proj-name').value || '';
 document.getElementById('save-class').value = proj ? proj.classification : 'Infrastructure';
 document.getElementById('save-desc').value = proj ? (proj.description||'') : '';
 document.getElementById('save-status').value = proj ? (proj.status||'Active') : 'Active';
 document.getElementById('save-modal-title').textContent = proj ? 'Update Project' : 'Save Project';
 document.getElementById('save-modal').classList.add('show');
}
function closeSaveModal() {
 document.getElementById('save-modal').classList.remove('show');
}
document.getElementById('save-cancel').addEventListener('click', closeSaveModal);
document.getElementById('save-modal').addEventListener('click', e => { if(e.target===e.currentTarget) closeSaveModal(); });

document.getElementById('save-confirm').addEventListener('click', async () => {
 const name = document.getElementById('save-name').value.trim() || 'Untitled Project';
 const cls = document.getElementById('save-class').value || 'Infrastructure';
 const desc = document.getElementById('save-desc').value.trim();
 const status = document.getElementById('save-status').value || 'Active';

 document.getElementById('proj-name').value = name;

 const snap = buildSnapshot();
 const payload = projectPayload();
 const now = new Date().toISOString();
 const btn = document.getElementById('save-proj-btn');
 const orig = btn.textContent;

 try {
  btn.textContent = ' Saving...';
  btn.disabled = true;

  const existing = currentProjectId ? portfolio.find(p => p.id === currentProjectId) : null;
  const project = {
   ...(existing || {}),
   id: currentProjectId || undefined,
   name,
   classification: cls,
   description: desc,
   status,
   createdAt: existing?.createdAt || now,
   updatedAt: now,
   snapshot: snap,
   data: payload,
  };

  const saved = await saveProjectToSupabase(project);
  currentProjectId = saved.id;

  const idx = portfolio.findIndex(p => p.id === saved.id);
  if (idx >= 0) portfolio[idx] = saved;
  else portfolio.unshift(saved);

  closeSaveModal();
  await renderPortfolio();

  btn.textContent = ' Saved';
  btn.style.background = '#236338';
  setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.disabled = false; }, 1800);
 } catch(err) {
  console.error('Error saving project to Supabase:', err);
  btn.textContent = orig;
  btn.disabled = false;
  alert('No se pudo guardar el proyecto online: ' + (err.message || err));
 }
});

document.getElementById('save-proj-btn').addEventListener('click', openSaveModal);

//  AI ANALYSIS 

function buildFinancialSnapshot() {
 const cv = compute();
 const pm = PM();
 const ti = rSum(cv.totalIncome);
 const cogs = rSum(cv.totalCogsAdj);
 const gp = rSum(cv.grossProfit);
 const pb = rSum(cv.profitBeforeOpex);
 const eb = rSum(cv.ebit);
 // Use CF-consistent totals (totalIncomeCF-based)
 const ncf = rSum(cv.netCF);
 // Recompute accumCF from netCF for snapshot (same logic as CF table)
 const _accumSnap = (() => { let a=0; return cv.netCF.map(v => { a+=v; return a; }); })();
 const acf = _accumSnap[_accumSnap.length - 1] || 0;

 // Month of first positive accumulated CF
 const breakEvenMo = _accumSnap.findIndex(v => v > 0) + 1;
 const peakNeg = Math.min(..._accumSnap);
 const minCashNeed = Math.abs(peakNeg);

 // Monthly detail for CF pattern
 const cfMonths = cv.netCF.map((v, i) => ({
 m: i + 1, label: mInfo(i + 1).short + ' ' + mInfo(i + 1).year,
 ncf: v, acf: _accumSnap[i], income: cv.totalIncomeCF[i], cogs: cv.totalCogsAdj[i]
 }));

 return {
 projName: document.getElementById('proj-name').value || 'Project',
 months: pm, fx: CFG.fx, sy: CFG.sy, sm: CFG.sm,
 // P&L
 totalIncome: ti, totalCogs: cogs, grossProfit: gp,
 grossMargin: ti ? (gp / ti * 100) : 0,
 profitBeforeOpex: pb,
 pbMargin: ti ? (pb / ti * 100) : 0,
 ebit: eb, ebitMargin: ti ? (eb / ti * 100) : 0,
 ebitda: rSum(cv.ebitda),
 opexBuffer: rSum(cv.opexBuffer),
 finExpCB: rSum(cv.finExpCB),
 finExpUB: rSum(cv.finExpUB),
 hedging: rSum(cv.hedgingArr),
 penalties: rSum(cv.penArr),
 // CF
 netCF: ncf, accumCF: acf, peakNegCF: peakNeg, minCashNeed,
 breakEvenMo: breakEvenMo > 0 ? breakEvenMo : null,
 npvCF: cv.npvCF, discountRate: CFG.dis,
 // Config
 contingency: CFG.con, opxbuf: CFG.opxbuf,
 hedgPct: CFG.hedg, fub: CFG.fub, fcb: CFG.fcb,
 penPct: CFG.pen,
 // Monthly detail (first 24 months)
 cfMonths: cfMonths.slice(0, 24)
 };
}

function buildAIPrompt(snap) {
 const f2 = v => v.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
 const pct = v => v.toFixed(2) + '%';

 return `You are a senior financial analyst specializing in Peruvian infrastructure and technology projects. Analyze this financial model and provide a structured executive analysis IN SPANISH.

PROJECT: ${snap.projName}
DURATION: ${snap.months} months | FX: S/ ${snap.fx}/USD | Start: ${snap.sm}/${snap.sy}

 P&L SUMMARY (USD) 
Total Income: $ ${f2(snap.totalIncome)}
Total COGS: $ ${f2(snap.totalCogs)}
Gross Profit: $ ${f2(snap.grossProfit)} (${pct(snap.grossMargin)} margin)
Out-of-pocket expenses: includes Compliance Bond ${pct(snap.fcb)}, Upfront Bond ${pct(snap.fub)}, Hedging ${pct(snap.hedgPct)}
Profit before OPEX: $ ${f2(snap.profitBeforeOpex)} (${pct(snap.pbMargin)})
OPEX Buffer (${snap.opxbuf}%): $ ${f2(snap.opexBuffer)}
EBIT: $ ${f2(snap.ebit)} (${pct(snap.ebitMargin)})
EBITDA: $ ${f2(snap.ebitda)}
Contingency (${snap.contingency}%): $ ${f2(snap.totalCogs * snap.contingency / 100)}
Penalties (${snap.penPct}%): $ ${f2(snap.penalties)}
Hedging: $ ${f2(snap.hedging)}

 CASH FLOW SUMMARY 
Total Net CF: $ ${f2(snap.netCF)}
Accumulated CF (end): $ ${f2(snap.accumCF)}
Peak Negative CF: $ ${f2(snap.peakNegCF)}
Min. Cash Needed: $ ${f2(snap.minCashNeed)}
Break-even month: ${snap.breakEvenMo ? 'Month ' + snap.breakEvenMo : 'Not reached'}
NPV (${snap.discountRate}% annual): $ ${f2(snap.npvCF)}

 MONTHLY CF PATTERN (first ${snap.cfMonths.length} months) 
${snap.cfMonths.map(m => `M${m.m} ${m.label}: Income $${f2(m.income)} | Net CF $${f2(m.ncf)} | Accum $${f2(m.acf)}`).join('\n')}

Respond ONLY in valid JSON (no markdown, no backticks) with this exact structure:
{
 "resumenEjecutivo": "3-4 sentence executive summary in Spanish",
 "kpis": [
 {"label": "string", "value": "string", "status": "good|warn|bad|info"}
 ],
 "fortalezas": [{"titulo": "string", "detalle": "string"}],
 "riesgos": [{"titulo": "string", "detalle": "string", "nivel": "alto|medio|bajo"}],
 "interpretacionPL": "paragraph analyzing P&L structure, margins, cost efficiency",
 "interpretacionCF": "paragraph analyzing cash flow pattern, liquidity gaps, break-even",
 "financiamiento": {
 "montoRecomendado": number,
 "descripcion": "string explaining what to finance and why",
 "opciones": [
 {
 "tipo": "string (e.g. Préstamo bancario BBVA/BCP, Financiamiento COFIDE, Factoring, Capital de trabajo)",
 "monto": number,
 "tasaMin": number,
 "tasaMax": number,
 "plazo": "string",
 "descripcion": "string with Peru-specific details and current rates",
 "viabilidad": "alta|media|baja"
 }
 ]
 },
 "recomendaciones": [{"accion": "string", "prioridad": "alta|media|baja", "impacto": "string"}]
}`;
}

function generateLocalAnalysis(snap) {
 const ti = snap.totalIncome;
 const cogs = snap.totalCogs;
 const gp = snap.grossProfit;
 const gm = snap.grossMargin;
 const pb = snap.profitBeforeOpex;
 const pbm = snap.pbMargin;
 const eb = snap.ebit;
 const ebm = snap.ebitMargin;
 const ncf = snap.netCF;
 const peak = snap.peakNegCF;
 const need = snap.minCashNeed;
 const be = snap.breakEvenMo;
 const npv = snap.npvCF;
 const pm = snap.months;
 const f0 = v => Math.abs(v).toLocaleString('en-US',{maximumFractionDigits:0});
 const f2 = v => Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 const pct = v => v.toFixed(1)+'%';

 //  Semáforos 
 const gmStatus = gm >= 25 ? 'good' : gm >= 10 ? 'warn' : 'bad';
 const ebStatus = ebm >= 10 ? 'good' : ebm >= 0 ? 'warn' : 'bad';
 const cfStatus = ncf >= 0 ? 'good' : 'bad';
 const npvStatus = npv >= 0 ? 'good' : 'bad';
 const beStatus = !be ? 'bad' : be <= pm*0.5 ? 'good' : 'warn';

 //  Resumen ejecutivo 
 const toneGP = gm >= 20 ? 'muestra un margen bruto saludable' : gm >= 5 ? 'presenta márgenes ajustados' : 'registra un margen bruto negativo que requiere atención urgente';
 const toneCF = ncf >= 0 ? 'genera flujo de caja positivo al cierre del proyecto' : 'presenta un flujo de caja neto negativo que requiere financiamiento externo';
 const toneNPV = npv >= 0 ? `El VPN positivo de USD ${f0(npv)} confirma la viabilidad económica del proyecto` : `El VPN negativo de USD ${f0(npv)} indica que el proyecto destruye valor a la tasa de descuento actual del ${snap.discountRate}%`;
 const toneBreak = be ? `El punto de equilibrio de caja se alcanza en el mes ${be}` : 'El modelo no alcanza equilibrio de caja en el horizonte proyectado';

 const resumen = `El proyecto "${snap.projName}" tiene un ingreso total de USD ${f0(ti)} en ${pm} meses y ${toneGP} del ${pct(gm)}. El EBIT representa el ${pct(ebm)} de los ingresos y el proyecto ${toneCF}. ${toneBreak}. ${toneNPV}.`;

 //  KPIs 
 const kpis = [
 { label: 'Ingreso Total', value: 'USD ' + f0(ti), status: 'info' },
 { label: 'Margen Bruto', value: pct(gm), status: gmStatus },
 { label: 'Margen EBIT', value: pct(ebm), status: ebStatus },
 { label: 'Flujo Neto', value: (ncf>=0?'':'(')+'USD '+f0(ncf)+(ncf>=0?'':')' ), status: cfStatus },
 { label: 'VPN', value: (npv>=0?'':'(')+'USD '+f0(npv)+(npv>=0?'':')' ), status: npvStatus },
 { label: 'Break-even', value: be ? 'Mes '+be : 'No alcanzado', status: beStatus },
 { label: 'Caja Mín. Necesaria', value: 'USD '+f0(need), status: need > ti*0.3 ? 'bad' : need > ti*0.1 ? 'warn' : 'good' },
 { label: 'Duración', value: pm + ' meses', status: 'info' },
 ];

 //  Interpretación P&L 
 const cogsRatio = ti ? (Math.abs(cogs)/ti*100) : 0;
 const opexRatio = ti ? (snap.opexBuffer/ti*100) : 0;
 let plText = `Los ingresos totales ascienden a USD ${f0(ti)} con un costo de ventas (COGS) de USD ${f0(Math.abs(cogs))} (${pct(cogsRatio)} de los ingresos). `;
 plText += `El margen bruto del ${pct(gm)} `;
 plText += gm >= 30 ? 'es sólido y permite cubrir holgadamente los gastos operativos y financieros.' :
 gm >= 15 ? 'es aceptable pero deja poco margen ante imprevistos.' :
 'es insuficiente para cubrir los gastos operativos sin presionar la liquidez.';
 plText += ` El OPEX buffer del ${snap.opxbuf}% representa USD ${f0(snap.opexBuffer)}, `;
 plText += opexRatio > 35 ? 'un peso operativo elevado que comprime el EBIT significativamente.' :
 'un nivel operativo manejable dentro del estándar del sector.';
 if (snap.hedging > 0) plText += ` El hedging del ${snap.hedgPct}% (USD ${f0(snap.hedging)}) agrega un costo financiero relevante que debe evaluarse contra el riesgo cambiario real.`;
 plText += ` El EBIT de USD ${f0(eb)} (${pct(ebm)}) `;
 plText += ebm >= 15 ? 'indica un proyecto rentable y atractivo para financiadores.' :
 ebm >= 0 ? 'es positivo pero con poca holgura ante variaciones de costo o ingreso.' :
 'es negativo, señal de que los costos estructurales superan la capacidad de generación de valor del proyecto.';

 //  Interpretación CF 
 const negMonths = snap.cfMonths.filter(m => m.ncf < 0).length;
 const posMonths = snap.cfMonths.filter(m => m.ncf > 0).length;
 let cfText = `El cash flow muestra ${negMonths} mes(es) con flujo negativo de los ${snap.cfMonths.length} analizados. `;
 cfText += peak < -1000 ? `El pico de caja negativa acumulada es USD ${f0(need)}, que representa la brecha máxima de liquidez a cubrir. ` : 'El proyecto no presenta brechas de liquidez significativas. ';
 cfText += be ? `El break-even de caja se alcanza en el mes ${be} (${Math.round(be/pm*100)}% del horizonte del proyecto). ` :
 'El proyecto no alcanza un flujo acumulado positivo en el horizonte analizado, lo que requiere revisar el modelo de cobro o reducir costos. ';
 cfText += snap.finExpCB > 0 || snap.finExpUB > 0 ?
 `Los gastos financieros fuera de bolsa (Compliance Bond + Upfront Bond) suman USD ${f0(snap.finExpCB + snap.finExpUB)}, un costo a negociar con el cliente o financiador.` : '';

 //  Fortalezas 
 const fortalezas = [];
 if (gm >= 20) fortalezas.push({ titulo: 'Margen bruto saludable', detalle: `Un margen del ${pct(gm)} sobre ingresos de USD ${f0(ti)} permite absorber imprevistos y costos financieros sin comprometer la viabilidad del proyecto.` });
 if (npv > 0) fortalezas.push({ titulo: 'VPN positivo', detalle: `El Valor Presente Neto de USD ${f0(npv)} a una tasa del ${snap.discountRate}% indica que el proyecto crea valor para el inversionista.` });
 if (be && be <= pm * 0.6) fortalezas.push({ titulo: 'Break-even temprano', detalle: `El equilibrio de caja se alcanza en el mes ${be} de ${pm}, lo que reduce la exposición a riesgo de liquidez.` });
 if (snap.contingency >= 10) fortalezas.push({ titulo: 'Contingencia adecuada', detalle: `La contingencia del ${snap.contingency}% sobre COGS (USD ${f0(Math.abs(cogs)*snap.contingency/100)}) proporciona un colchón real ante variaciones de costo en el mercado peruano.` });
 if (fortalezas.length === 0) fortalezas.push({ titulo: 'Proyecto en evaluación', detalle: 'El modelo está en construcción. Completa los datos de ingresos y costos para obtener un análisis de fortalezas más preciso.' });

 //  Riesgos 
 const riesgos = [];
 if (ebm < 0) riesgos.push({ titulo: 'EBIT negativo', detalle: `El proyecto no genera utilidad operativa. Con un EBIT de USD ${f0(eb)}, cualquier sobrecosto o retraso en cobros agravará la pérdida.`, nivel: 'alto' });
 if (need > ti * 0.25) riesgos.push({ titulo: 'Alta necesidad de caja', detalle: `Se requieren USD ${f0(need)} de financiamiento mínimo, equivalente al ${pct(need/ti*100)} de los ingresos totales. Esto eleva el riesgo de liquidez y el costo financiero.`, nivel: 'alto' });
 if (!be) riesgos.push({ titulo: 'Sin break-even de caja', detalle: 'El flujo acumulado nunca se vuelve positivo en el horizonte proyectado. Revisar el calendario de cobros o reducir costos variables.', nivel: 'alto' });
 if (snap.penPct >= 5) riesgos.push({ titulo: `Penalidades altas (${snap.penPct}%)`, detalle: `Las penalidades reducen los ingresos en USD ${f0(Math.abs(snap.penalties))}. Cualquier incumplimiento de hitos puede amplificar este impacto.`, nivel: 'medio' });
 if (gm < 15 && gm >= 0) riesgos.push({ titulo: 'Margen bruto ajustado', detalle: `Un margen del ${pct(gm)} deja poco espacio ante variaciones de costo. Un incremento del 5% en COGS eliminaría casi toda la utilidad bruta.`, nivel: 'medio' });
 if (snap.hedgPct > 0) riesgos.push({ titulo: 'Exposición cambiaria', detalle: `El hedging del ${snap.hedgPct}% (USD ${f0(snap.hedging)}) sugiere exposición al tipo de cambio PEN/USD. Con el BCRP manteniendo volatilidad controlada, evaluar si este costo es proporcional al riesgo real.`, nivel: 'bajo' });

 //  Financiamiento 
 // Monto recomendado = peak negative cash + 15% buffer
 const montoRec = need > 0 ? Math.ceil(need * 1.15 / 1000) * 1000 : 0;
 const descFinanc = need > 0
 ? `Para cubrir la brecha máxima de liquidez de USD ${f0(need)} más un colchón de seguridad del 15%, se recomienda estructurar financiamiento por USD ${f0(montoRec)}. Este monto cubre el período de mayor exposición sin sobreendeudar el proyecto.`
 : `El proyecto genera flujo positivo y no requiere financiamiento externo obligatorio. Sin embargo, un capital de trabajo de USD ${f0(ti*0.05)} puede optimizar el ciclo de cobro y reducir la presión operativa.`;

 const opciones = [
 {
 tipo: 'Capital de trabajo  -  BCP / BBVA / Scotiabank',
 monto: montoRec > 0 ? montoRec : Math.ceil(ti * 0.05),
 tasaMin: 9.5, tasaMax: 14.0,
 plazo: '12 a 24 meses',
 descripcion: 'Línea de capital de trabajo para empresas con facturación demostrada. BCP ofrece tasas desde 9.5% anual en USD para empresas con historial crediticio. Requiere estados financieros de 2 años y contratos firmados como garantía.',
 viabilidad: gm >= 15 ? 'alta' : 'media'
 },
 {
 tipo: 'Financiamiento COFIDE  -  Programas PyME / Mediana Empresa',
 monto: montoRec > 0 ? montoRec : Math.ceil(ti * 0.08),
 tasaMin: 7.0, tasaMax: 11.0,
 plazo: '24 a 60 meses',
 descripcion: 'COFIDE canaliza recursos a través del sistema financiero peruano a tasas preferenciales. El programa FONDO MIPYME financia hasta S/ 5M. Tasas en USD desde 7% anual. Ideal para proyectos de infraestructura y tecnología con contratos del Estado.',
 viabilidad: 'alta'
 },
 {
 tipo: 'Factoring de Facturas (Financiamiento de cuentas por cobrar)',
 monto: Math.ceil(ti * 0.3),
 tasaMin: 8.0, tasaMax: 13.0,
 plazo: '30 a 180 días por operación',
 descripcion: 'Adelanto del 80-90% del valor de facturas emitidas a clientes con buen historial. Plataformas como Factoringnet, Compite.pe o bancos locales. Costo efectivo mensual entre 0.8% y 1.2%. Ideal si el cliente paga a 60-90 días y hay necesidad de liquidez inmediata.',
 viabilidad: snap.finExpCB > 0 ? 'alta' : 'media'
 },
 {
 tipo: 'Leasing / Arrendamiento financiero (para CAPEX)',
 monto: Math.ceil(Math.abs(cogs) * 0.4),
 tasaMin: 8.5, tasaMax: 12.0,
 plazo: '24 a 48 meses',
 descripcion: 'Para financiar equipos y activos de capital (CAPEX). Interbank y Scotiabank ofrecen leasing en USD desde 8.5% anual. Ventaja tributaria: el IGV del activo es crédito fiscal inmediato y la cuota es gasto deducible. Recomendado si el CAPEX supera USD 50,000.',
 viabilidad: Math.abs(cogs) > 50000 ? 'alta' : 'media'
 },
 {
 tipo: 'Emisión de pagarés / Deuda privada (para proyectos > USD 500K)',
 monto: montoRec,
 tasaMin: 10.0, tasaMax: 16.0,
 plazo: '12 a 36 meses',
 descripcion: 'Estructuración de deuda privada con inversionistas institucionales o family offices. Tasas negociables entre 10-16% anual en USD. Requiere auditoría financiera y project finance estructurado. Aplica si el financiamiento bancario no cubre el monto requerido.',
 viabilidad: montoRec > 200000 ? 'media' : 'baja'
 }
 ];

 //  Recomendaciones 
 const recomendaciones = [];
 if (ebm < 5) recomendaciones.push({
 accion: 'Revisar estructura de costos y negociar COGS',
 prioridad: 'alta',
 impacto: `Reducir COGS en un 10% incrementaría el EBIT en USD ${f0(Math.abs(cogs)*0.1)} y mejoraría el margen en ~${pct(Math.abs(cogs)*0.1/ti*100)}.`
 });
 if (need > ti * 0.1) recomendaciones.push({
 accion: 'Negociar anticipos con el cliente (20-30% del contrato)',
 prioridad: 'alta',
 impacto: `Un anticipo del 20% sobre ingresos (USD ${f0(ti*0.2)}) reduciría la brecha de caja en ~${f0(need > ti*0.2 ? need - ti*0.2 : 0)} USD y el costo de financiamiento externo.`
 });
 if (!be || be > pm * 0.5) recomendaciones.push({
 accion: 'Rediseñar el cronograma de cobros  -  pagos más frecuentes',
 prioridad: 'alta',
 impacto: 'Pasar de cobros trimestrales a mensuales puede anticipar hasta el 30% del flujo y reducir la necesidad de financiamiento puente.'
 });
 if (snap.penPct > 3) recomendaciones.push({
 accion: 'Establecer hitos contractuales claros para minimizar penalidades',
 prioridad: 'media',
 impacto: `Eliminar las penalidades del ${snap.penPct}% recuperaría USD ${f0(Math.abs(snap.penalties))} en ingresos netos.`
 });
 recomendaciones.push({
 accion: 'Estructurar financiamiento antes del inicio del proyecto',
 prioridad: 'media',
 impacto: `Contar con una línea aprobada de USD ${f0(montoRec > 0 ? montoRec : ti*0.1)} pre-inicio reduce el riesgo operativo y permite negociar mejores tasas.`
 });
 if (snap.hedgPct > 2) recomendaciones.push({
 accion: `Evaluar cobertura cambiaria real vs. costo del hedging (${snap.hedgPct}%)`,
 prioridad: 'baja',
 impacto: `Si el riesgo cambiario es bajo (proyecto en USD con costos en USD), eliminar el hedging libera USD ${f0(snap.hedging)} de caja.`
 });

 return {
 resumenEjecutivo: resumen,
 kpis, fortalezas, riesgos,
 interpretacionPL: plText,
 interpretacionCF: cfText,
 financiamiento: { montoRecomendado: montoRec, descripcion: descFinanc, opciones },
 recomendaciones
 };
}

async function runAIAnalysis() {
 const btn = document.getElementById('ai-run-btn');
 const output = document.getElementById('ai-output');
 const loading = document.getElementById('ai-loading');
 const result = document.getElementById('ai-result');

 btn.disabled = true;
 btn.textContent = ' Analizando&';
 output.style.display = 'block';
 result.style.display = 'none';
 result.innerHTML = '';
 loading.style.display = 'block';

 // Delay so browser repaints before heavy JS
 await new Promise(r => setTimeout(r, 120));

 try {
 const snap = buildFinancialSnapshot();
 const ai = generateLocalAnalysis(snap);
 renderAIResult(ai, snap);
 } catch(err) {
 result.innerHTML = '<div class="ai-card bad"><h4>Error al generar análisis</h4><p>' + err.message + '</p></div>';
 result.style.display = 'block';
 loading.style.display = 'none';
 }

 btn.disabled = false;
 btn.textContent = ' Actualizar Análisis';
}

function renderAIResult(ai, snap) {
 const loading = document.getElementById('ai-loading');
 const result = document.getElementById('ai-result');
 loading.style.display = 'none';

 const nivel2color = { alto:'#BA0517', medio:'#A56105', bajo:'#2E844A' };
 const prio2color = { alta:'#BA0517', media:'#A56105', baja:'#2E844A' };
 const viab2color = { alta:'#2E844A', media:'#A56105', baja:'#BA0517' };
 const f2 = v => (v||0).toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0});
 const now = new Date().toLocaleString('es-PE', {dateStyle:'long', timeStyle:'short'});
 const overallStatus = snap.ebitMargin >= 10 ? 'VIABLE' : snap.ebitMargin >= 0 ? 'AJUSTADO' : 'CRÍTICO';
 const overallColor = snap.ebitMargin >= 10 ? '#2E844A' : snap.ebitMargin >= 0 ? '#A56105' : '#BA0517';

 let h = '';

 //  REPORT HEADER 
 h += `<div style="background:linear-gradient(135deg,#032D60 0%,#0176D3 100%);border-radius:10px;padding:24px 28px;margin-bottom:24px;color:#fff">
 <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px">
 <div>
 <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;opacity:.7;margin-bottom:6px">Reporte Ejecutivo  -  Análisis Financiero</div>
 <div style="font-size:22px;font-weight:800;letter-spacing:-.3px;margin-bottom:4px">${snap.projName}</div>
 <div style="font-size:12px;opacity:.75">${snap.months} meses &nbsp;·&nbsp; USD/PEN S/${snap.fx} &nbsp;·&nbsp; Generado: ${now}</div>
 </div>
 <div style="text-align:right">
 <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;opacity:.7;margin-bottom:4px">Estado del Proyecto</div>
 <div style="font-size:20px;font-weight:900;color:${overallColor};background:rgba(255,255,255,.12);padding:6px 16px;border-radius:6px;letter-spacing:.05em">${overallStatus}</div>
 </div>
 </div>
 <div style="margin-top:20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px">
 ${(ai.kpis||[]).slice(0,6).map(k => `
 <div style="background:rgba(255,255,255,.1);border-radius:6px;padding:10px 12px">
 <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;opacity:.65;margin-bottom:4px">${k.label}</div>
 <div style="font-size:15px;font-weight:800;color:${k.status==='good'?'#57D9A3':k.status==='bad'?'#FF9A9A':k.status==='warn'?'#FFDE7A':'#fff'}">${k.value}</div>
 </div>`).join('')}
 </div>
 </div>`;

 //  RESUMEN EJECUTIVO 
 h += `<div class="ai-section">
 <div class="ai-section-title">01  -  Resumen Ejecutivo</div>
 <div class="ai-card info" style="border-left:4px solid #0176D3;font-size:13px;line-height:1.7">
 <p>${ai.resumenEjecutivo||''}</p>
 </div>
 </div>`;

 //  P&L + CF SIDE BY SIDE 
 h += `<div class="ai-section">
 <div class="ai-section-title">02  -  Análisis Financiero</div>
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
 <div class="ai-card info">
 <h4 style="margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)"> Profit & Loss</h4>
 <p style="font-size:12px">${ai.interpretacionPL||''}</p>
 </div>
 <div class="ai-card ${snap.peakNegCF < -1000 ? 'warn' : 'good'}">
 <h4 style="margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)"> Cash Flow</h4>
 <p style="font-size:12px">${ai.interpretacionCF||''}</p>
 </div>
 </div>
 </div>`;

 //  FORTALEZAS Y RIESGOS 
 h += `<div class="ai-section">
 <div class="ai-section-title">03  -  Fortalezas &amp; Riesgos</div>
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">`;

 if (ai.fortalezas?.length) {
 h += '<div>';
 ai.fortalezas.forEach(f => {
 h += `<div class="ai-card good" style="margin-bottom:10px">
 <h4 style="color:#2E844A"> ${f.titulo}</h4><p style="font-size:12px">${f.detalle}</p>
 </div>`;
 });
 h += '</div>';
 }
 if (ai.riesgos?.length) {
 h += '<div>';
 ai.riesgos.forEach(r => {
 const c = r.nivel === 'alto' ? 'bad' : r.nivel === 'medio' ? 'warn' : '';
 const nc = nivel2color[r.nivel] || '#888';
 h += `<div class="ai-card ${c}" style="margin-bottom:10px">
 <h4> ${r.titulo} <span class="ai-badge" style="background:${nc}18;color:${nc};margin-left:6px">${r.nivel}</span></h4>
 <p style="font-size:12px">${r.detalle}</p>
 </div>`;
 });
 h += '</div>';
 }
 h += '</div></div>';

 //  FINANCIAMIENTO 
 if (ai.financiamiento) {
 const fn = ai.financiamiento;
 h += `<div class="ai-section">
 <div class="ai-section-title">04  -  Estrategia de Financiamiento</div>
 <div style="background:#e8f4fd;border:1px solid #b3d9f5;border-radius:8px;padding:14px 18px;margin-bottom:14px;display:flex;align-items:center;gap:16px">
 <div>
 <div style="font-size:11px;color:#0176D3;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Monto recomendado</div>
 <div style="font-size:26px;font-weight:900;color:#032D60">USD ${f2(fn.montoRecomendado)}</div>
 </div>
 <div style="flex:1;font-size:12px;color:#333;line-height:1.6;border-left:2px solid #b3d9f5;padding-left:16px">${fn.descripcion||''}</div>
 </div>`;

 if (fn.opciones?.length) {
 h += `<div style="overflow-x:auto"><table class="ai-table" style="font-size:11px">
 <thead><tr>
 <th style="min-width:180px">Instrumento</th>
 <th style="text-align:right;min-width:100px">Monto</th>
 <th style="text-align:center;min-width:100px">Tasa anual</th>
 <th style="min-width:90px">Plazo</th>
 <th style="min-width:200px">Detalle</th>
 <th style="text-align:center;min-width:80px">Viabilidad</th>
 </tr></thead><tbody>`;
 fn.opciones.forEach(op => {
 const vc = viab2color[op.viabilidad] || '#888';
 h += `<tr>
 <td style="font-weight:700;color:#032D60">${op.tipo}</td>
 <td style="text-align:right;font-weight:600">$ ${f2(op.monto)}</td>
 <td style="text-align:center"><span style="background:#e8f4fd;color:#0176D3;padding:2px 8px;border-radius:10px;font-weight:700">${op.tasaMin} - ${op.tasaMax}%</span></td>
 <td style="color:#555">${op.plazo}</td>
 <td style="color:#555;line-height:1.45">${op.descripcion}</td>
 <td style="text-align:center"><span class="ai-badge" style="background:${vc}18;color:${vc};padding:3px 10px">${op.viabilidad}</span></td>
 </tr>`;
 });
 h += '</tbody></table></div>';
 }
 h += '</div>';
 }

 //  PLAN DE ACCIÓN 
 if (ai.recomendaciones?.length) {
 h += `<div class="ai-section">
 <div class="ai-section-title">05  -  Plan de Acción</div>
 <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">`;
 ai.recomendaciones.forEach((r, i) => {
 const pc = prio2color[r.prioridad] || '#888';
 h += `<div class="ai-card" style="padding:14px 16px">
 <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
 <div style="min-width:24px;height:24px;border-radius:50%;background:${pc};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;flex-shrink:0">${i+1}</div>
 <div style="font-weight:700;font-size:12px;color:#032D60;line-height:1.3">${r.accion}</div>
 </div>
 <p style="font-size:11px;color:#555;margin:0 0 8px;line-height:1.5">${r.impacto}</p>
 <span class="ai-badge" style="background:${pc}18;color:${pc};padding:2px 8px">Prioridad ${r.prioridad}</span>
 </div>`;
 });
 h += '</div></div>';
 }

 //  Footer 
 h += `<div style="margin-top:24px;padding:12px 16px;background:#f4f6f8;border-radius:6px;font-size:10px;color:#888;text-align:center">
 Análisis generado automáticamente por el modelo financiero · ${now} · Los datos de tasas son referenciales basados en el mercado peruano a 2025
 </div>`;

 result.innerHTML = h;
 result.style.display = 'block';
}

document.getElementById('ai-run-btn').addEventListener('click', runAIAnalysis);

//  EXCEL EXPORT (.xlsx) 
function exportTableXLSX(tblId, sheetName, filename) {
 try {
 if (typeof XLSX === 'undefined') { alert('SheetJS library not loaded. Please check your internet connection.'); return; }

 const tbl = document.getElementById(tblId);
 if (!tbl) { alert('Table not found: ' + tblId); return; }

 const projName = (document.getElementById('proj-name').value || 'Model').trim();
 const cv = compute();

 //  Sheet 1: Full table 
 const wsData = [];
 wsData.push([projName + '  -  ' + sheetName]);
 wsData.push(['Generated: ' + new Date().toLocaleString('es-PE', {dateStyle:'medium',timeStyle:'short'})]);
 wsData.push([]); // blank spacer

 Array.from(tbl.querySelectorAll('tr')).forEach(tr => {
 const secCell = tr.querySelector('td[colspan="999"]');
 if (secCell) { wsData.push(['--- ' + secCell.textContent.trim() + ' ---']); return; }

 const cells = Array.from(tr.querySelectorAll('th,td'));
 if (!cells.length) return;
 const rowArr = [];
 cells.forEach(cell => {
 const span = parseInt(cell.getAttribute('colspan') || 1);
 const raw = cell.textContent.trim();
 // Parse accounting numbers: "(1,234.56)"  -1234.56, "1,234.56"  1234.56, " - "  ""
 let val = raw === ' - ' ? '' : raw;
 if (raw !== ' - ' && raw !== '') {
 const isNeg = /^\(.*\)$/.test(raw);
 const digits = raw.replace(/[(),\s]/g,'');
 const n = parseFloat(digits);
 if (!isNaN(n) && String(n).length >= digits.replace('.','').length - 1) {
 val = isNeg ? -n : n;
 }
 }
 rowArr.push(val);
 for (let s = 1; s < span; s++) rowArr.push(null);
 });
 wsData.push(rowArr);
 });

 const ws = XLSX.utils.aoa_to_sheet(wsData);

 // Column widths
 const maxC = Math.max(...wsData.map(r => Array.isArray(r) ? r.length : 1), 1);
 ws['!cols'] = [{ wch: 34 }];
 for (let i = 1; i < maxC; i++) ws['!cols'].push({ wch: 13 });

 // Number format: accounting with parens
 const ref = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
 for (let R = ref.s.r; R <= ref.e.r; R++) {
 for (let C = ref.s.c; C <= ref.e.c; C++) {
 const addr = XLSX.utils.encode_cell({r:R, c:C});
 const cell = ws[addr];
 if (cell && typeof cell.v === 'number') {
 cell.t = 'n';
 cell.z = '#,##0.00_);(#,##0.00)';
 }
 }
 }

 // Freeze top rows + first column
 ws['!views'] = [{ state:'frozen', xSplit:1, ySplit:4 }];

 const wb = XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0,31));

 //  Sheet 2: Dynamic Summary 
 const sumData = buildSummarySheet(cv, sheetName, projName);
 const wsSum = XLSX.utils.aoa_to_sheet(sumData);
 wsSum['!cols'] = [{ wch: 32 }, { wch: 16 }, { wch: 14 }, { wch: 12 }];
 // Format numbers in summary
 const ref2 = XLSX.utils.decode_range(wsSum['!ref'] || 'A1:A1');
 for (let R = ref2.s.r; R <= ref2.e.r; R++) {
 for (let C = 1; C <= ref2.e.c; C++) {
 const addr = XLSX.utils.encode_cell({r:R, c:C});
 const cell = wsSum[addr];
 if (cell && typeof cell.v === 'number') {
 cell.t = 'n';
 cell.z = C === 2 ? '0.00"%"' : '#,##0.00_);(#,##0.00)';
 }
 }
 }
 XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');

 XLSX.writeFile(wb, filename);
 } catch(err) {
 alert('Export failed: ' + err.message);
 console.error('Excel export error:', err);
 }
}

function buildSummarySheet(cv, type, projName) {
 const isPL = type === 'P&L';
 const f2 = v => Math.round(v * 100) / 100;
 const pct = (a, b) => !b ? 0 : Math.round(a / Math.abs(b) * 10000) / 100;
 const ti = rSum(cv.totalIncome);
 const ncf = rSum(cv.netCF);

 const rows = [
 [projName + '  -  Financial Summary', '', '', ''],
 ['Sheet: ' + type, '', '', ''],
 [],
 ['METRIC', 'USD', '% Revenue', 'STATUS'],
 [],
 ];

 if (isPL) {
 const cogs = rSum(cv.totalCogsAdj);
 const gp = rSum(cv.grossProfit);
 const pb = rSum(cv.profitBeforeOpex);
 const eb = rSum(cv.ebit);
 const ed = rSum(cv.ebitda);
 rows.push(['INCOME', '', '', '']);
 rows.push([' Total Income', f2(ti), pct(ti,ti), ti >= 0 ? 'OK' : 'REVIEW']);
 Object.entries(cv.revCats).forEach(([cat, arr]) =>
 rows.push([' ' + cat, f2(rSum(arr)), pct(rSum(arr),ti), ''])
 );
 rows.push([' Penalties', f2(rSum(cv.penArr)), pct(rSum(cv.penArr),ti), '']);
 rows.push([]);
 rows.push(['COSTS', '', '', '']);
 cv.userCats.forEach(cat => {
 const v = rSum(cv.costCat[cat]||Z());
 if (v) rows.push([' ' + cat, f2(-v), pct(-v,ti), '']);
 });
 rows.push([' Contingency (' + CFG.con + '%)', f2(-rSum(cv.costCat['Contingency']||Z())), '', '']);
 rows.push([' Total COGS', f2(cogs), pct(cogs,ti), '']);
 rows.push([]);
 rows.push(['RESULTS', '', '', '']);
 rows.push([' Gross Profit', f2(gp), pct(gp,ti), gp >= 0 ? 'POSITIVE' : 'NEGATIVE']);
 rows.push([' OPEX Buffer (' + (CFG.opxbuf||30) + '%)', f2(-rSum(cv.opexBuffer)), pct(-rSum(cv.opexBuffer),ti), '']);
 rows.push([' Financial Exp (CB+UB)', f2(-rSum(cv.outOfPocket)), '', '']);
 rows.push([' Hedging', f2(-rSum(cv.hedgingArr)), '', '']);
 rows.push([' Profit before OPEX', f2(pb), pct(pb,ti), pb >= 0 ? 'POSITIVE' : 'NEGATIVE']);
 rows.push([' EBIT', f2(eb), pct(eb,ti), eb >= 0 ? 'POSITIVE' : 'NEGATIVE']);
 rows.push([' EBITDA', f2(ed), pct(ed,ti), ed >= 0 ? 'POSITIVE' : 'NEGATIVE']);
 rows.push([]);
 rows.push(['CAPEX TOTAL', f2(capex.reduce((s,i)=>s+getBase(i),0)), '', '']);
 rows.push(['OPEX TOTAL', f2(opex.reduce((s,i)=>s+getBase(i),0)), '', '']);
 rows.push(['DURATION', PM() + ' months', '', '']);
 rows.push(['FX RATE', '1 USD = ' + CFG.fx + ' PEN', '', '']);
 } else {
 const peak = Math.min(...cv.accumCF);
 const beIdx = cv.accumCF.findIndex(v => v > 0);
 const finalAccum = cv.accumCF[cv.accumCF.length - 1] || 0;
 rows.push(['CASH FLOW SUMMARY', '', '', '']);
 rows.push([' Total CF Inflows', f2(rSum(cv.totalIncomeCF)), '', '']);
 rows.push([' Total CF Outflows', f2(-(rSum(cv.totalCogsCFAdj)+rSum(cv.opexBufferCF)+rSum(cv.finExpCB)+rSum(cv.finExpUB)+rSum(cv.hedgingArr)+rSum(cv.vatToPay))), '', '']);
 rows.push([' Net Cash Flow', f2(ncf), '', ncf >= 0 ? 'POSITIVE' : 'NEGATIVE']);
 rows.push([' Peak Negative CF', f2(peak), '', peak < -1000 ? 'NEEDS FINANCING' : 'OK']);
 rows.push([' Min. Cash Needed', f2(Math.abs(peak)), '', '']);
 rows.push([' Break-even Month', beIdx >= 0 ? 'Month ' + (beIdx+1) : 'Not reached', '', beIdx >= 0 ? 'OK' : 'REVIEW']);
 rows.push([' Final Accumulated CF', f2(finalAccum), '', finalAccum >= 0 ? 'POSITIVE' : 'NEGATIVE']);
 rows.push([]);
 rows.push(['NPV ANALYSIS', '', '', '']);
 rows.push([' Discount Rate', CFG.dis + '%', '', '']);
 rows.push([' NPV (Net CF)', f2(cv.npvCF), '', cv.npvCF >= 0 ? 'VIABLE' : 'REVIEW']);
 rows.push([' NPV (Income)', f2(cv.npvInc), '', '']);
 rows.push([]);
 rows.push(['VAT SUMMARY', '', '', '']);
 rows.push([' Total VAT Inflows', f2(rSum(cv.vatIn)), '', '']);
 rows.push([' Total VAT Outflows', f2(-rSum(cv.vatOut)), '', '']);
 rows.push([' Total VAT to SUNAT', f2(rSum(cv.vatToPay)), '', '']);
 }

 return rows;
}

document.addEventListener('click', e => {
 const name = (document.getElementById('proj-name').value || 'model').replace(/\s+/g,'_');
 if (e.target.id === 'pl-xlsx-btn') exportTableXLSX('pl-tbl', 'P&L', name + '_PL.xlsx');
 if (e.target.id === 'cf-xlsx-btn') exportTableXLSX('cf-tbl', 'Cash Flow', name + '_CF.xlsx');
});

//  PNG EXPORT (canvas-based direct renderer) 
function exportTablePNG(tblId, filename) {
 const tbl = document.getElementById(tblId);
 if (!tbl) return;

 const SCALE = 2; // retina
 const PAD = 24;
 const FONT = 11;
 const ROW_H = 26;
 const HDR_H = 30;

 //  collect rows 
 const allRows = Array.from(tbl.querySelectorAll('tr'));

 //  measure column widths (max content per col) 
 const colW = [];
 allRows.forEach(tr => {
 let ci = 0;
 Array.from(tr.querySelectorAll('th,td')).forEach(cell => {
 const span = parseInt(cell.getAttribute('colspan') || 1);
 if (span === 1) {
 const txt = cell.textContent.trim();
 const w = Math.max(60, txt.length * (FONT * 0.62) + 16);
 colW[ci] = Math.max(colW[ci] || 0, w);
 }
 ci += span;
 });
 });
 const totalW = colW.reduce((s,w) => s + (w||70), 0) + PAD * 2;

 //  measure total height 
 let totalH = PAD * 2 + 20; // title
 allRows.forEach(tr => {
 const isSec = tr.querySelector('td[colspan="999"]');
 totalH += isSec ? 22 : ROW_H;
 });

 //  create canvas 
 const canvas = document.createElement('canvas');
 canvas.width = totalW * SCALE;
 canvas.height = totalH * SCALE;
 const ctx = canvas.getContext('2d');
 ctx.scale(SCALE, SCALE);

 // White background
 ctx.fillStyle = '#ffffff';
 ctx.fillRect(0, 0, totalW, totalH);

 //  title 
 const projName = document.getElementById('proj-name').value || 'Financial Model';
 ctx.fillStyle = '#032D60';
 ctx.font = `700 12px Inter,system-ui,sans-serif`;
 ctx.fillText(projName + '  -  ' + filename.replace('.png',''), PAD, PAD + 12);

 //  draw rows 
 let y = PAD + 22;

 // Color helpers matching the table CSS
 function getRowStyle(tr) {
 if (tr.classList.contains('sec-row')) {
 const bg = tr.querySelector('td')?.style.background || '#032D60';
 return { bg, fg:'#ffffff', bold:true, h:22, fontSize:10 };
 }
 if (tr.classList.contains('bold-row')) return { bg:'#f0f4f8', fg:'#032D60', bold:true, h:ROW_H, fontSize:FONT };
 return { bg:'#ffffff', fg:'#1a1a1a', bold:false, h:ROW_H, fontSize:FONT };
 }

 allRows.forEach((tr, ri) => {
 const style = getRowStyle(tr);
 const cells = Array.from(tr.querySelectorAll('th,td'));

 // Row background
 ctx.fillStyle = ri % 2 === 0 && !style.bg.startsWith('#0') && style.bg === '#ffffff'
 ? '#fafafa' : style.bg;
 ctx.fillRect(PAD, y, totalW - PAD * 2, style.h);

 // Row bottom border
 ctx.strokeStyle = '#e0e0e0';
 ctx.lineWidth = 0.5;
 ctx.beginPath();
 ctx.moveTo(PAD, y + style.h);
 ctx.lineTo(totalW - PAD, y + style.h);
 ctx.stroke();

 // Cells
 let x = PAD;
 cells.forEach((cell) => {
 const span = parseInt(cell.getAttribute('colspan') || 1);
 const isNum = cell.classList.contains('num') || cell.classList.contains('tot');
 const isRed = cell.classList.contains('c-red');
 const isBold = cell.classList.contains('bold') || style.bold;
 const isHdr = cell.tagName === 'TH';

 // compute cell width
 let cw = 0;
 if (span >= 999) {
 cw = totalW - PAD * 2 - x + PAD;
 } else {
 for (let s = 0; s < span; s++) cw += (colW[cells.indexOf(cell) + s] || 70);
 }

 // Cell bg for header
 if (isHdr) {
 ctx.fillStyle = '#032D60';
 ctx.fillRect(x, y, cw, style.h);
 }

 // Text
 const fontSize = style.fontSize || FONT;
 ctx.font = `${isBold || isHdr ? '700' : '400'} ${fontSize}px Inter,system-ui,sans-serif`;
 ctx.fillStyle = isHdr ? '#ffffff' : isRed ? '#BA0517' : style.fg;

 const txt = cell.textContent.trim();
 const tx = isNum ? x + cw - 8 : x + 8;
 const ty = y + style.h / 2 + fontSize * 0.36;
 ctx.textAlign = isNum ? 'right' : 'left';

 // Clip text to cell
 ctx.save();
 ctx.beginPath();
 ctx.rect(x + 2, y, cw - 4, style.h);
 ctx.clip();
 ctx.fillText(txt, tx, ty);
 ctx.restore();

 x += cw;
 });

 y += style.h;
 });

 // Download
 const a = document.createElement('a');
 a.download = filename;
 a.href = canvas.toDataURL('image/png');
 a.click();
}

document.addEventListener('click', e => {
 if (e.target.id === 'pl-png-btn') {
 const name = (document.getElementById('proj-name').value || 'model').replace(/\s+/g,'_');
 exportTablePNG('pl-tbl', name + '_PL.png');
 }
 if (e.target.id === 'cf-png-btn') {
 const name = (document.getElementById('proj-name').value || 'model').replace(/\s+/g,'_');
 exportTablePNG('cf-tbl', name + '_CF.png');
 }
});

//  CSV TEMPLATE & IMPORT 

// CSV helpers
function csvEsc(v) {
 const s = String(v == null ? '' : v);
 return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g,'""') + '"' : s;
}
function csvRow(arr) { return arr.map(csvEsc).join(','); }
function parseCSV(text) {
 const rows = []; let row = [], cell = '', inQ = false;
 for (let i = 0; i < text.length; i++) {
 const c = text[i], n = text[i+1];
 if (inQ) {
 if (c==='"' && n==='"') { cell += '"'; i++; }
 else if (c==='"') inQ = false;
 else cell += c;
 } else {
 if (c==='"') { inQ = true; }
 else if (c===',') { row.push(cell.trim()); cell = ''; }
 else if (c==='\r'||c==='\n') {
 if (c==='\r'&&n==='\n') i++;
 row.push(cell.trim()); rows.push(row); row=[]; cell='';
 } else cell += c;
 }
 }
 if (cell||row.length) { row.push(cell.trim()); rows.push(row); }
 return rows.filter(r => r.some(c=>c));
}

// Template columns
const REV_COLS = ['name','amount_without_igv','original_currency(USD/PEN)','category','igv_applicable(yes/no)','reference_note','reference_url'];
const COST_COLS = ['name','amount_without_igv','original_currency(USD/PEN)','category(Equipment/Payroll/Services/Overhead)','igv_applicable(yes/no)','payment_cond_days','advance_pct','reference_note','reference_url'];


function _downloadTextFile(filename, content, mime) {
 const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
 const a = document.createElement('a');
 a.href = URL.createObjectURL(blob);
 a.download = filename;
 document.body.appendChild(a);
 a.click();
 setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function _downloadCSVTemplate(label, headers, exRows) {
 const csv = [headers, ...exRows].map(csvRow).join('\n');
 _downloadTextFile(label + '_template.csv', csv, 'text/csv;charset=utf-8');
}

function ensureXLSXLoaded() {
 if (typeof XLSX !== 'undefined') return Promise.resolve(true);
 return new Promise(resolve => {
  const existing = document.querySelector('script[data-xlsx-loader="1"]');
  if (existing) {
   existing.addEventListener('load', () => resolve(typeof XLSX !== 'undefined'), { once:true });
   existing.addEventListener('error', () => resolve(false), { once:true });
   setTimeout(() => resolve(typeof XLSX !== 'undefined'), 3500);
   return;
  }
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  s.async = true;
  s.dataset.xlsxLoader = '1';
  s.onload = () => resolve(typeof XLSX !== 'undefined');
  s.onerror = () => {
   const s2 = document.createElement('script');
   s2.src = 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js';
   s2.async = true;
   s2.onload = () => resolve(typeof XLSX !== 'undefined');
   s2.onerror = () => resolve(false);
   document.head.appendChild(s2);
  };
  document.head.appendChild(s);
  setTimeout(() => resolve(typeof XLSX !== 'undefined'), 5000);
 });
}

async function downloadTemplate(type) {
 const label = type === 'revenues' ? 'Revenue' : type === 'capex' ? 'CAPEX' : 'OPEX';
 const isRev = type === 'revenues';

 // Header row with friendly names
 const headers = isRev
 ? ['name', 'amount_without_igv', 'original_currency (USD/PEN)', 'category', 'igv_applicable (yes/no)', 'reference_note', 'reference_url']
 : ['name', 'amount_without_igv', 'original_currency (USD/PEN)', 'category (Equipment/Payroll/Services/Overhead)', 'igv_applicable (yes/no)', 'payment_cond_days', 'advance_pct', 'reference_note', 'reference_url'];

 // Example rows
 const exRows = isRev ? [
 ['Consulting Services Phase 1', 50000, 'USD', 'Services', 'no', 'Contract #2024-01', 'https://drive.google.com/...'],
 ['Supply of Equipment', 80000, 'USD', 'Components', 'no', 'PO #2024-55', ''],
 ['Software License', 12000, 'PEN', 'Technology', 'yes','Quote SW-001', ''],
 ] : [
 ['Server Equipment', 20000, 'USD', 'Equipment', 'no', 60, 10, 'Quote Ferreyros #001', 'https://drive.google.com/...'],
 ['Engineering Staff', 15000, 'USD', 'Payroll', 'no', 30, 0, 'HR Contract #A-12', ''],
 ['Cloud Services', 5000, 'USD', 'Services', 'no', 0, 0, 'AWS Invoice', ''],
 ['Project Overhead', 3000, 'USD', 'Overhead', 'no', 0, 0, '', ''],
 ];

 const ready = await ensureXLSXLoaded();
 if (!ready) {
  _downloadCSVTemplate(label, headers, exRows);
  alert('No se pudo cargar la librería de Excel (XLSX). Te descargué el template en CSV, que también puedes importar en esta app.');
  return;
 }

 // Build workbook via SheetJS
 const ws = XLSX.utils.aoa_to_sheet([headers, ...exRows]);
 ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 18) }));
 const wb = XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(wb, ws, label);
 XLSX.writeFile(wb, label + '_template.xlsx');
}

function importCSV(type, text) {
 const rows = parseCSV(text);
 if (rows.length < 2) { alert('CSV must have a header row and at least one data row.'); return; }
 const header = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9_]/g,'_'));
 const get = (row, key) => {
 const i = header.indexOf(key);
 return i >= 0 ? row[i] || '' : '';
 };
 const getFirst = (row, keys) => {
 for (const k of keys) { const v = get(row, k); if (v) return v; }
 return '';
 };

 let added = 0;
 const dataRows = rows.slice(1).filter(r => r.some(c=>c));
 dataRows.forEach(row => {
 const name = getFirst(row, ['name','item_name','description']);
 const amount = getFirst(row, ['amount_without_igv','amount','total','value','monto_sin_igv','monto']);
 if (!name && !amount) return; // skip blank rows

 if (type === 'revenues') {
 const item = mkRev();
 item.name = name;
 item.amount = amount;
 item.cur = (getFirst(row, ['original_currency_usd_pen_','currency_usd_pen_','original_currency','currency','moneda']) || 'USD').toUpperCase().includes('PEN') ? 'PEN' : 'USD';
 item.cat = getFirst(row, ['category','categoria','type']);
 item.igv = _yes(getFirst(row, ['igv_applicable_yes_no_','igv_yes_no_','igv_applicable','afecto_igv','igv','incluye_igv']));
 item.refNote = getFirst(row, ['reference_note','referencia','notes','ref']);
 item.refUrl = getFirst(row, ['reference_url','url','link','backup']);
 revenues.push(item);
 } else {
 const item = mkCost();
 item.name = name;
 item.amount = amount;
 item.cur = (getFirst(row, ['original_currency_usd_pen_','currency_usd_pen_','original_currency','currency','moneda']) || 'USD').toUpperCase().includes('PEN') ? 'PEN' : 'USD';
 const catRaw = getFirst(row, ['category_equipment_payroll_services_overhead_','category','categoria','type']) || '';
 const catMap = {equipment:'Equipment',payroll:'Payroll',services:'Services',overhead:'Overhead'};
 item.cat = catMap[catRaw.toLowerCase().trim()] || catRaw || 'Equipment';
 item.igv = _yes(getFirst(row, ['igv_applicable_yes_no_','igv_yes_no_','igv_applicable','afecto_igv','igv']));
 item.payCond = getFirst(row, ['payment_cond_days','payment_days','cond_pago','dias']) || '';
 item.adv = getFirst(row, ['advance_pct','anticipo','advance']) || '';
 item.refNote = getFirst(row, ['reference_note','referencia','notes','ref']);
 item.refUrl = getFirst(row, ['reference_url','url','link','backup']);
 if (type === 'capex') capex.push(item); else opex.push(item);
 }
 added++;
 });

 renderList(type);
 alert('Importado: ' + added + ' item' + (added!==1?'s':'') + ' en ' + type.toUpperCase() + '. Los montos se cargaron sin IGV y en su moneda original; P&L/CF se convierten a USD con el FX del proyecto.');
}

// Wire buttons
document.getElementById('dl-tpl-rev') .addEventListener('click', () => downloadTemplate('revenues'));
document.getElementById('dl-tpl-capex').addEventListener('click', () => downloadTemplate('capex'));
document.getElementById('dl-tpl-opex') .addEventListener('click', () => downloadTemplate('opex'));

function handleImportFile(type, file) {
 if (!file) return;
 const ext = file.name.split('.').pop().toLowerCase();
 if (ext === 'xlsx' || ext === 'xls') {
  const r = new FileReader();
  r.onload = async ev => {
   try {
    const ready = await ensureXLSXLoaded();
    if (!ready) {
     alert('No se pudo cargar la librería de Excel (XLSX). Guarda el archivo como CSV e impórtalo nuevamente, o revisa tu conexión.');
     return;
    }
    const wb = XLSX.read(ev.target.result, {type:'array'});
    const ws = wb.Sheets[wb.SheetNames[0]];
    const csv = XLSX.utils.sheet_to_csv(ws);
    importCSV(type, csv);
   } catch(e) { alert('Error reading Excel file: ' + e.message); }
  };
  r.readAsArrayBuffer(file);
 } else {
  const r = new FileReader();
  r.onload = ev => importCSV(type, ev.target.result);
  r.readAsText(file);
 }
}

document.getElementById('imp-rev').addEventListener('change', e => {
 handleImportFile('revenues', e.target.files[0]); e.target.value = '';
});
document.getElementById('imp-capex').addEventListener('change', e => {
 handleImportFile('capex', e.target.files[0]); e.target.value = '';
});
document.getElementById('imp-opex').addEventListener('change', e => {
 handleImportFile('opex', e.target.files[0]); e.target.value = '';
});

//  PORTFOLIO RENDER 
let activeFilter = 'All';

async function renderPortfolio() {
 await loadPortfolio();

 // Build filter chips
 const cats = ['All', ...new Set(portfolio.map(p => p.classification).filter(Boolean))];
 const filterEl = document.getElementById('port-filter');
 filterEl.innerHTML = '';
 cats.forEach(c => {
 const chip = document.createElement('div');
 chip.className = 'filter-chip' + (c === activeFilter ? ' active' : '');
 chip.textContent = c;
 chip.addEventListener('click', () => { activeFilter = c; renderPortfolio(); });
 filterEl.appendChild(chip);
 });

 const filtered = activeFilter === 'All' ? portfolio : portfolio.filter(p => p.classification === activeFilter);

 // Subtitle
 document.getElementById('port-subtitle').innerHTML =
 portfolio.length === 0 ? 'No projects saved yet' :
 `<strong>${portfolio.length} project${portfolio.length>1?'s':''}</strong> · <strong>${filtered.length} shown</strong>`;

 const grid = document.getElementById('port-grid');
 grid.innerHTML = '';

 if (!portfolio.length) {
 grid.innerHTML = `<div class="port-empty" style="grid-column:1/-1">
 <div class="port-empty-icon"></div>
 <div class="port-empty-title">No projects yet</div>
 <div style="font-size:13px">Create a new project to get started</div>
 </div>`;
 return;
 }
 if (!filtered.length) {
 grid.innerHTML = `<div class="port-empty" style="grid-column:1/-1">
 <div class="port-empty-icon"></div>
 <div class="port-empty-title">No projects in this category</div>
 </div>`;
 return;
 }

 // Sort by updatedAt desc
 const sorted = [...filtered].sort((a,b) => (b.updatedAt||'') > (a.updatedAt||'') ? 1 : -1);

 sorted.forEach(proj => {
 const s = proj.snapshot || {};
 const clsColor = CLASS_COLORS[proj.classification] || '#444';
 const stColor = STATUS_COLORS[proj.status] || '#444';
 const mg = s.margin != null ? s.margin.toFixed(2) + '%' : ' - ';
 const dur = s.months ? s.months + ' mo' : ' - ';
 const updated = proj.updatedAt ? new Date(proj.updatedAt).toLocaleDateString('es-PE', {day:'2-digit',month:'short',year:'numeric'}) : '';

 const card = document.createElement('div');
 card.className = 'proj-card';
 card.innerHTML = `
 <div class="proj-card-top">
 <div class="proj-card-name">${esc(proj.name||'Untitled')}</div>
 <div class="proj-card-meta" style="margin-top:6px">
 <span class="proj-badge" style="background:${clsColor}22;color:${clsColor}">${esc(proj.classification||'')}</span>
 <span class="proj-badge" style="background:${stColor}22;color:${stColor}">${esc(proj.status||'')}</span>
 ${proj.description ? `<span style="font-size:11px;color:var(--muted)">${esc(proj.description)}</span>` : ''}
 </div>
 </div>
 <div class="proj-card-kpis">
 <div class="proj-kpi">
 <div class="proj-kpi-lbl">Revenue</div>
 <div class="proj-kpi-val" style="color:#06A59A">$${fmtK(s.revenue||0)}</div>
 </div>
 <div class="proj-kpi">
 <div class="proj-kpi-lbl">COGS</div>
 <div class="proj-kpi-val" style="color:#BA0517">$${fmtK(s.cogs||0)}</div>
 </div>
 <div class="proj-kpi">
 <div class="proj-kpi-lbl">GP Margin</div>
 <div class="proj-kpi-val" style="color:#0176D3">${mg}</div>
 </div>
 <div class="proj-kpi">
 <div class="proj-kpi-lbl">Net CF</div>
 <div class="proj-kpi-val" style="color:${(s.netCF||0)>=0?'#2E844A':'#BA0517'}">$${fmtK(s.netCF||0)}</div>
 </div>
 <div class="proj-kpi">
 <div class="proj-kpi-lbl">NPV</div>
 <div class="proj-kpi-val" style="color:#5A2D82">$${fmtK(s.npv||0)}</div>
 </div>
 <div class="proj-kpi">
 <div class="proj-kpi-lbl">Duration</div>
 <div class="proj-kpi-val" style="color:var(--sub)">${dur}</div>
 </div>
 </div>
 <div class="proj-card-footer">
 <span class="proj-card-dur" style="color:var(--muted)">Updated ${updated}</span>
 <div style="display:flex;gap:8px;align-items:center">
 <button class="btn-remove" style="font-size:10px;padding:2px 7px" data-del="${proj.id}">Delete</button>
 <button class="exp-btn" style="font-size:11px;padding:3px 10px;color:var(--sub);border-color:var(--bdr2)" data-export="${proj.id}"> JSON</button>
 <span class="proj-card-open">Open </span>
 </div>
 </div>`;

 // Open project
 card.addEventListener('click', e => {
 if (e.target.dataset.del || e.target.dataset.export) return;
 openProject(proj.id);
 });

 // Delete
 card.querySelector('[data-del]').addEventListener('click', async e => {
 e.stopPropagation();
 if (confirm('Delete "' + proj.name + '"?')) {
  try {
   await deleteProjectFromSupabase(proj.id);
   portfolio = portfolio.filter(p => p.id !== proj.id);
   if (currentProjectId === proj.id) currentProjectId = null;
   await renderPortfolio();
  } catch(err) {
   console.error('Error deleting project from Supabase:', err);
   alert('No se pudo eliminar el proyecto online: ' + (err.message || err));
  }
 }
 });

 // Export JSON
 card.querySelector('[data-export]').addEventListener('click', e => {
 e.stopPropagation();
 const blob = new Blob([JSON.stringify(proj, null, 2)], {type:'application/json'});
 const a = document.createElement('a');
 a.href = URL.createObjectURL(blob);
 a.download = (proj.name||'project').replace(/\s+/g,'_') + '.json';
 a.click();
 });

 grid.appendChild(card);
 });
}

function openProject(id) {
 const proj = portfolio.find(p => p.id === id);
 if (!proj) return;
 loadProjectPayload(proj.data);
 currentProjectId = id;
 showProject();
 renderSettings();
 setTab('dashboard');
}

//  NEW PROJECT 
function newProject() {
 currentProjectId = null;
 CFG = { fx:3.75, pen:5, con:5, dis:12, months:12, sm:1, sy:2025, fcb:0, fcbCost:0, fub:0, hedg:0, opxbuf:30, finRate:0 };
 revenues = [];
 capex = [];
 opex = [];
 adjustments = [];
 customLines = [];
 plRowOrder = [];
 cfRowOrder = [];
 document.getElementById('proj-name').value = 'New Project';
 showProject();
 renderSettings();
 setTab('dashboard');
}

document.getElementById('port-new-btn').addEventListener('click', newProject);
document.getElementById('back-to-portfolio').addEventListener('click', showPortfolio);

//  IMPORT JSON 
document.getElementById('port-import-btn').addEventListener('click', () => {
 document.getElementById('port-import-file').click();
});
document.getElementById('port-import-file').addEventListener('change', e => {
 const file = e.target.files[0];
 if (!file) return;
 const reader = new FileReader();
 reader.onload = async ev => {
  try {
   const proj = JSON.parse(ev.target.result);
   // Could be a full portfolio entry or just raw project data
   if (proj.data && proj.name) {
    const imported = {
     name: proj.name || 'Imported Project',
     classification: proj.classification || proj.category || 'Infrastructure',
     description: proj.description || '',
     status: proj.status || 'Active',
     createdAt: proj.createdAt || new Date().toISOString(),
     updatedAt: new Date().toISOString(),
     snapshot: proj.snapshot,
     data: proj.data,
    };
    if (!imported.snapshot && imported.data) {
     // Reconstruct snapshot by loading and computing
     const previousPayload = projectPayload();
     loadProjectPayload(imported.data);
     imported.snapshot = buildSnapshot();
     loadProjectPayload(previousPayload);
    }
    const saved = await saveProjectToSupabase(imported);
    portfolio.unshift(saved);
    await renderPortfolio();
    alert('Project "' + saved.name + '" imported successfully.');
   } else {
    alert('Invalid project file format.');
   }
  } catch(err) { alert('Error reading file: ' + err.message); }
 };
 reader.readAsText(file);
 e.target.value = '';
});



/* =====================================================================
   FINAL TARGETED PATCH — stable formulas, P&L totals, CF/dashboard sanity
   ===================================================================== */
(function(){
  function _arrZero(){ return Z(); }
  function _arrClone(a){ return (a || _arrZero()).map(v => Number(v) || 0); }
  function _arrAdd(a,b){ const z=_arrZero(); a=a||z; b=b||z; return z.map((_,i)=>(Number(a[i])||0)+(Number(b[i])||0)); }
  function _arrSub(a,b){ const z=_arrZero(); a=a||z; b=b||z; return z.map((_,i)=>(Number(a[i])||0)-(Number(b[i])||0)); }
  function _arrNeg(a){ return (a || _arrZero()).map(v => -(Number(v)||0)); }
  function _sumMany(arrs){ return (arrs||[]).reduce((acc,a)=>_arrAdd(acc,a), _arrZero()); }
  function _escRE(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function _addAlias(map, name, value){
    const n = String(name || '').trim();
    if (!n) return;
    const v = Number(value) || 0;
    const forms = new Set([
      n, n.toLowerCase(), n.toUpperCase(),
      n.replace(/\s+/g, '_'), n.toLowerCase().replace(/\s+/g, '_'),
      n.replace(/\s+/g, ''), n.toLowerCase().replace(/\s+/g, ''),
      n.replace(/[&/\-]/g, ' '), n.toLowerCase().replace(/[&/\-]/g, ' '),
      n.replace(/[^A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ]/g, ''),
      n.toLowerCase().replace(/[^a-z0-9áéíóúüñ]/g, '')
    ]);
    forms.forEach(k => { if (k) map[k] = v; });
  }
  function _cogsRawFromVisible(cv){
    const rows = [];
    (cv.userCats || []).forEach(cat => rows.push((cv.costCat || {})[cat] || _arrZero()));
    rows.push((cv.costCat || {}).Contingency || _arrZero());
    (cv.adjCostRows || []).forEach(ac => {
      const src = ac.arr || _arrZero();
      rows.push(src.map(v => (ac.adj && ac.adj.sign === 'add') ? (Number(v)||0) : -(Number(v)||0)));
    });
    return _sumMany(rows);
  }
  function _incomeDisplay(cv){ return _arrClone(cv.totalIncome); }
  function _cogsDisplay(cv){ return _arrNeg(cv.totalCogsAdj || _cogsRawFromVisible(cv)); }
  function _grossDisplay(cv){ return _arrAdd(_incomeDisplay(cv), _cogsDisplay(cv)); }
  function _bondDisplay(cv){ return _sumMany([_arrNeg(cv.finExpCB), _arrNeg(cv.finExpUB)]); }
  function _opexInterestDisplay(cv){ return _sumMany([_arrNeg(cv.opexBuffer), _arrNeg(cv.hedgingArr), _arrNeg(cv.finCostArr)]); }

  // Wrap compute once so all dashboards/formulas receive reliable baseline totals.
  const _baseCompute = compute;
  compute = window.compute = function(){
    const cv = _baseCompute();
    const cogsRaw = _cogsRawFromVisible(cv);                // positive raw cost base
    cv.totalCogsAdj = cogsRaw;
    cv.grossProfit = _arrSub(cv.totalIncome || _arrZero(), cogsRaw);
    cv.bondFees = _arrAdd(cv.finExpCB || _arrZero(), cv.finExpUB || _arrZero());
    cv.profitBeforeOpex = _arrSub(cv.grossProfit, cv.bondFees);
    cv.ebit = _sumMany([cv.profitBeforeOpex, _arrNeg(cv.opexBuffer), _arrNeg(cv.hedgingArr), _arrNeg(cv.finCostArr)]);
    // Excel reference sent by user showed EBITDA linked to EBIT.
    cv.ebitda = _arrClone(cv.ebit);
    // Recalculate net CF using the same visible logic used in CF table.
    const adjIncomeCF = (cv.adjIncomeRows || []).map(ac => (ac.arrCF || ac.arr || _arrZero()).map(v => (ac.adj && ac.adj.sign === 'add') ? (Number(v)||0) : -(Number(v)||0)));
    const adjCostCF = (cv.adjCostRows || []).map(ac => (ac.arrCF || ac.arr || _arrZero()).map(v => (ac.adj && ac.adj.sign === 'add') ? (Number(v)||0) : -(Number(v)||0)));
    const inflows = _sumMany([...Object.values(cv.revCatsCF || {}), cv.penArrCF || _arrZero(), ...adjIncomeCF, cv.vatIn || _arrZero()]);
    const outflows = _sumMany([...(cv.userCats||[]).map(c => (cv.costCatCF||{})[c] || _arrZero()), (cv.costCatCF||{}).Contingency || _arrZero(), ...adjCostCF, cv.opexBufferCF || _arrZero(), cv.finExpCB || _arrZero(), cv.finExpUB || _arrZero(), cv.hedgingArr || _arrZero(), cv.finCostArr || _arrZero(), cv.vatOut || _arrZero()]);
    cv.totalInflowsVisible = inflows;
    cv.totalOutflowsVisible = outflows;
    cv.netCF = _arrSub(inflows, outflows);
    let ac = 0; cv.accumCF = cv.netCF.map(v => { ac += Number(v)||0; return ac; });
    return cv;
  };

  function _formulaVars(cv, mi){
    const map = {};
    const add = (n,v) => _addAlias(map,n,v);
    const cogsDisp = _cogsDisplay(cv);
    const gp = _grossDisplay(cv);
    const pbo = _arrAdd(gp, _bondDisplay(cv));
    const ebit = _arrAdd(pbo, _opexInterestDisplay(cv));
    const ebitda = ebit;
    add('Total Income', (cv.totalIncome||_arrZero())[mi]); add('totalIncome', (cv.totalIncome||_arrZero())[mi]); add('Income', (cv.totalIncome||_arrZero())[mi]); add('Revenue', (cv.totalIncome||_arrZero())[mi]);
    add('Total COGS', cogsDisp[mi]); add('totalCogs', cogsDisp[mi]); add('COGS', cogsDisp[mi]); add('Cost of Goods Sold', cogsDisp[mi]);
    add('Gross Profit', gp[mi]); add('grossProfit', gp[mi]); add('GP', gp[mi]);
    add('Profit before OPEX Interest', pbo[mi]); add('Profit before OPEX / Interest', pbo[mi]); add('profitBeforeOpex', pbo[mi]);
    add('EBIT', ebit[mi]); add('ebit', ebit[mi]); add('EBITDA', ebitda[mi]); add('ebitda', ebitda[mi]);
    add('OPEX Buffer', _arrNeg(cv.opexBuffer)[mi]); add('opexBuffer', _arrNeg(cv.opexBuffer)[mi]);
    add('Hedging', _arrNeg(cv.hedgingArr)[mi]); add('Hedging Adjustment', _arrNeg(cv.hedgingArr)[mi]); add('hedging', _arrNeg(cv.hedgingArr)[mi]);
    add('Financing Cost', _arrNeg(cv.finCostArr)[mi]); add('finCostArr', _arrNeg(cv.finCostArr)[mi]); add('financingCost', _arrNeg(cv.finCostArr)[mi]);
    add('Net Cash Flow', (cv.netCF||_arrZero())[mi]); add('netCF', (cv.netCF||_arrZero())[mi]);
    add('Accumulated Cash Flow', (cv.accumCF||_arrZero())[mi]); add('Accumulated CF', (cv.accumCF||_arrZero())[mi]); add('accumCF', (cv.accumCF||_arrZero())[mi]);
    add('Total Inflows', (cv.totalInflowsVisible||cv.totalIncomeCF||_arrZero())[mi]); add('Total Outflows', (cv.totalOutflowsVisible||_arrZero())[mi]);
    add('Penalties', (cv.penArr||_arrZero())[mi]); add('VAT Inflow', (cv.vatIn||_arrZero())[mi]); add('VAT Outflow', _arrNeg(cv.vatOut)[mi]);
    add('Compliance Bond Fee', _arrNeg(cv.finExpCB)[mi]); add('Upfront Bond Fee', _arrNeg(cv.finExpUB)[mi]);
    add('Contingency', _arrNeg((cv.costCat||{}).Contingency)[mi]);
    Object.entries(cv.revCats || {}).forEach(([k,a]) => add(k, (a||_arrZero())[mi]));
    Object.entries(cv.costCat || {}).forEach(([k,a]) => add(k, _arrNeg(a||_arrZero())[mi]));
    (revenues || []).forEach(it => { if (it.name) add(it.name, (getDistArr(it)||_arrZero())[mi]); });
    ([...(capex||[]), ...(opex||[])]).forEach(it => { if (it.name) add(it.name, _arrNeg(getDistArr(it)||_arrZero())[mi]); });
    add('FX', CFG.fx); add('fx', CFG.fx); add('IGV', IGV); add('igv', IGV); add('month', mi+1); add('m', mi+1); add('months', PM()); add('pm', PM());
    return map;
  }
  function _evalExcelish(raw, cv, mi){
    if (!String(raw||'').trim()) return 0;
    let expr = String(raw).trim().replace(/^=/,'');
    // Excel-like separators and functions
    expr = expr.replace(/;/g, ',');
    // 10% of EBIT / 10% de Total Income
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*%\s*(?:of|de)\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 _&/\-.]*?)(?=\s*(?:[+\-*/),]|$))/gi, function(_, pct, ref){ return '('+(parseFloat(pct)/100)+')*('+ref.trim()+')'; });
    // 10% as a numeric factor
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*%/g, (_,pct)=>'('+(parseFloat(pct)/100)+')');
    const vars = _formulaVars(cv, mi);
    Object.keys(vars).sort((a,b)=>b.length-a.length).forEach(name => {
      const re = new RegExp('(?<![A-Za-z0-9_])' + _escRE(name) + '(?![A-Za-z0-9_])', 'gi');
      expr = expr.replace(re, String(vars[name]));
    });
    try {
      const v = Function('"use strict"; const IF=(c,a,b)=>c?a:b; const ABS=Math.abs; const MAX=Math.max; const MIN=Math.min; const ROUND=Math.round; const SUM=(...a)=>a.flat(Infinity).reduce((s,v)=>s+(Number(v)||0),0); return (' + expr + ')')();
      return isFinite(v) ? v : 0;
    } catch(e){
      console.warn('Formula error:', raw, '=>', expr, e.message);
      return 0;
    }
  }
  evalCustomFormula = window.evalCustomFormula = function(formula, cv, monthIdx){ return _evalExcelish(formula, cv || compute(), Number(monthIdx)||0); };
  evalCustomLineArr = window.evalCustomLineArr = function(line, cv){ const c=cv||compute(); return AMs().map((_,i)=>{ const raw=_evalExcelish(line.formula, c, i); return (line.sign||'subtract') === 'subtract' ? -Math.abs(raw) : raw; }); };
  _evalFormulaForId = window._evalFormulaForId = function(fid, expr, cv){ const c=cv||compute(); return AMs().map((_,i)=>_evalExcelish(expr, c, i)); };

  function _formulaLabels(){
    const cv = compute();
    const fixed = ['Total Income','Total COGS','Gross Profit','Profit before OPEX / Interest','EBIT','EBITDA','OPEX Buffer','Hedging Adjustment','Financing Cost','Net Cash Flow','Accumulated Cash Flow','Total Inflows','Total Outflows','Penalties','Compliance Bond Fee','Upfront Bond Fee','Contingency'];
    const dyn = [...Object.keys(cv.revCats||{}), ...Object.keys(cv.costCat||{}), ...(revenues||[]).map(x=>x.name).filter(Boolean), ...([...(capex||[]),...(opex||[])]).map(x=>x.name).filter(Boolean)];
    return Array.from(new Set([...fixed, ...dyn])).filter(Boolean);
  }
  function _ensureFormulaDatalist(){
    let dl = document.getElementById('formula-suggestions');
    if (!dl) { dl = document.createElement('datalist'); dl.id='formula-suggestions'; document.body.appendChild(dl); }
    dl.innerHTML = _formulaLabels().map(x=>`<option value="${String(x).replace(/"/g,'&quot;')}"></option>`).join('');
    document.querySelectorAll('#cl-m-formula, .cl-formula, [id^="fbar-"]').forEach(inp => inp.setAttribute('list','formula-suggestions'));
  }
  window._ensureFormulaDatalist = _ensureFormulaDatalist;

  // Debounce previews so formulas fields remain fluid.
  let _clTimer=null, _fbTimer=null;
  const _oldClPreview = _clPreview;
  _clPreview = window._clPreview = function(){ clearTimeout(_clTimer); _clTimer=setTimeout(_oldClPreview, 140); };
  const _oldLive = _livePreviewFormula;
  _livePreviewFormula = window._livePreviewFormula = function(fid, expr){ clearTimeout(_fbTimer); _fbTimer=setTimeout(()=>_oldLive(fid, expr), 140); };

  // Keep formula suggestion list fresh whenever formula UI opens/renders.
  const _oldOpenCLModal = openCLModal;
  openCLModal = window.openCLModal = function(section){ _oldOpenCLModal(section); setTimeout(_ensureFormulaDatalist, 0); };
  const _oldOpenEditLineModal = openEditLineModal;
  openEditLineModal = window.openEditLineModal = function(line){ _oldOpenEditLineModal(line); setTimeout(_ensureFormulaDatalist, 0); };
  const _oldRenderFormulaPanel = renderFormulaPanel;
  renderFormulaPanel = window.renderFormulaPanel = function(){ _oldRenderFormulaPanel(); setTimeout(_ensureFormulaDatalist, 0); };
  const _oldRenderCustomLines = renderCustomLines;
  renderCustomLines = window.renderCustomLines = function(){ _oldRenderCustomLines(); setTimeout(_ensureFormulaDatalist, 0); };

  // Override P&L renderer with the same table structure, but using reliable visible totals.
  const _oldRenderPL = renderPL;
  renderPL = window.renderPL = function(){
    const togWrap = document.getElementById('pl-view-tog');
    if (togWrap) { togWrap.innerHTML=''; const tog=buildToggle(plView, v=>{plView=v; renderPL();}); if (tog) togWrap.appendChild(tog); }
    const cv = compute(); const view = plView;
    if (view === 'grouped') { renderGroupedPLCF('pl', cv); return; }
    const cols = view === 'annual' ? yrLabels() : AMs().map(m=>mInfo(m).label);
    const mNums = view === 'annual' ? null : AMs();
    const cw = view === 'annual' ? 110 : 82;
    const nc = cols.length;
    function dArr(a){ return view==='annual' ? aggY(a) : a; }
    function row(label, arr, opts={}){ return dataRow(label, arr, view, opts); }
    function sum(label, arr, color, pctArr){
      const d=dArr(arr), tot=rSum(arr), badge=pctArr?pctBadge(arr,pctArr):'';
      return '<tr class="bold-row"><td class="lbl bold" style="'+(color?'color:'+color:'')+'">'+label+badge+'</td>'+d.map(v=>'<td class="num bold'+(v<0?' c-red':'')+'" style="'+(color?'color:'+color:'')+'">'+fmt(v)+'</td>').join('')+'<td class="num tot bold'+(tot<0?' c-red':'')+'" style="'+(color?'color:'+color:'')+'">'+fmt(tot)+'</td></tr>';
    }
    function customs(section){
      return customLines.filter(l=>l.section===section && String(l.formula||'').trim()).map(l=>({line:l, arr:evalCustomLineArr(l, cv)}));
    }
    const incomeCustom = customs('income_section');
    const cogsCustom = customs('cogs_section');
    const afterGP = customs('after_gross_profit');
    const afterPBO = customs('after_profit_b_opex');
    const afterEBIT = customs('after_ebit');
    const totalIncome = _sumMany([cv.totalIncome||_arrZero(), ...incomeCustom.map(x=>x.arr)]);
    const cogsBase = _cogsDisplay(cv);
    const totalCogs = _sumMany([cogsBase, ...cogsCustom.map(x=>x.arr)]);
    const grossProfit = _arrAdd(totalIncome, totalCogs);
    const bondRows = [_arrNeg(cv.finExpCB), _arrNeg(cv.finExpUB)];
    const profitBefore = _sumMany([grossProfit, ...bondRows, ...afterGP.map(x=>x.arr)]);
    const opexRows = [_arrNeg(cv.opexBuffer), _arrNeg(cv.hedgingArr), _arrNeg(cv.finCostArr)];
    const ebit = _sumMany([profitBefore, ...opexRows, ...afterPBO.map(x=>x.arr)]);
    const ebitda = _arrClone(ebit);

    let h=tHead(cols,cw,mNums)+'<tbody>';
    h += secRow('INCOME','var(--th-income)');
    Object.entries(cv.revCats||{}).forEach(([cat,a])=>h+=row(cat,a,{ind:true}));
    h += row('Penalties', cv.penArr||_arrZero(), {ind:true,color:'amber'});
    (cv.adjIncomeRows||[]).forEach(ac=>h+=row((ac.adj.name||'Adj')+' ('+(ac.adj.pct||0)+'%)', (ac.arr||_arrZero()).map(v=>ac.adj.sign==='add'?v:-v), {ind:true,color:'amber'}));
    incomeCustom.forEach(x=>h+=row(x.line.name||'Custom', x.arr, {ind:true,color:x.line.color||'amber'}));
    h += addLineRow('income_section', nc);
    h += sum('Total Income', totalIncome, 'var(--th-income)');

    h += secRow('COGS','var(--th-cogs)');
    (cv.userCats||[]).forEach(cat=>h+=row(cat, _arrNeg((cv.costCat||{})[cat]||_arrZero()), {ind:true}));
    h += row('Contingency ('+CFG.con+'%)', _arrNeg((cv.costCat||{}).Contingency||_arrZero()), {ind:true});
    (cv.adjCostRows||[]).forEach(ac=>h+=row((ac.adj.name||'Adj')+' ('+(ac.adj.pct||0)+'%)', (ac.arr||_arrZero()).map(v=>ac.adj.sign==='add'?-v:v), {ind:true,color:'amber'}));
    cogsCustom.forEach(x=>h+=row(x.line.name||'Custom', x.arr, {ind:true,color:x.line.color||'amber'}));
    h += addLineRow('cogs_section', nc);
    h += sum('Total COGS', totalCogs, 'var(--th-cogs)');
    h += sum('Gross Profit', grossProfit, 'var(--accent)', totalIncome);
    afterGP.forEach(x=>h+=row(x.line.name||'Custom', x.arr, {ind:true,color:x.line.color||'amber'}));
    h += addLineRow('after_gross_profit', nc);

    h += secRow('BOND FEES','var(--th-bond)');
    h += row('Compliance Bond Fee', _arrNeg(cv.finExpCB), {ind:true,color:'amber'});
    h += row('Upfront Bond Fee', _arrNeg(cv.finExpUB), {ind:true,color:'amber'});
    h += sum('Profit before OPEX / Interest', profitBefore, 'var(--accent)', totalIncome);
    afterPBO.forEach(x=>h+=row(x.line.name||'Custom', x.arr, {ind:true,color:x.line.color||'amber'}));
    h += addLineRow('after_profit_b_opex', nc);

    h += secRow('OPEX & INTEREST','var(--th-opex)');
    h += row('OPEX Buffer ('+(CFG.opxbuf??30)+'% of Revenue)', _arrNeg(cv.opexBuffer), {ind:true,color:'amber'});
    h += row('Hedging Adjustment (monthly)', _arrNeg(cv.hedgingArr), {ind:true});
    h += row('Financing Cost (on neg. CF)', _arrNeg(cv.finCostArr), {ind:true,color:'amber'});
    h += sum('EBIT', ebit, 'var(--accent)', totalIncome);
    afterEBIT.forEach(x=>h+=row(x.line.name||'Custom', x.arr, {ind:true,color:x.line.color||'amber'}));
    h += addLineRow('after_ebit', nc);
    h += sum('EBITDA', ebitda, 'var(--teal)', totalIncome);
    h += '</tbody>';
    document.getElementById('pl-tbl').innerHTML = h;
  };

  // Cost Summary minor cleanup for the two cards the user flagged.
  const _oldRenderCostSummary = renderCostSummary;
  renderCostSummary = window.renderCostSummary = function(){
    _oldRenderCostSummary();
    const wrap = document.getElementById('costs-content');
    if (!wrap) return;
    wrap.querySelectorAll('*').forEach(el=>{
      if ((el.textContent||'').trim()==='Financial / Bond Fees' || (el.textContent||'').trim()==='Total Cost Base') {
        el.style.letterSpacing = '.02em';
      }
    });
  };

  setTimeout(_ensureFormulaDatalist, 0);
})();

//  INIT 
initSettings();
renderSettings();
renderDashboard();
updateSub();
// Start on portfolio
document.getElementById('project-screen').style.display = 'none';
renderPortfolio();