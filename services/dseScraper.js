// services/dseScraper.js — v4.0.0
// ✅ tickerInitial JSON → LTP (388 symbols)
// ✅ market-depth → Open/High/Low/YCP/Volume/Trades/Value
// ✅ company page → Sector/MarketCap/FreeFloatMarketCap
// ✅ 300ms delay + 50-symbol batches
// ✅ MongoDB unique (symbol+date) upsert
// ✅ Telegram start + summary

const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const https = require('https');
const CandleData = require('./../models/CandleData');

// =========================================
// TLS + Headers
// =========================================
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  timeout: 60000,
});
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 60000;

axios.defaults.headers.common['User-Agent'] =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
axios.defaults.headers.common['Accept'] =
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
axios.defaults.headers.common['Accept-Language'] = 'en-US,en;q=0.9';
axios.defaults.headers.common['Cache-Control'] = 'no-cache';

// =========================================
// MongoDB
// =========================================
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

// =========================================
// Config
// =========================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE = 'https://new.dsebd.org';

const PER_SYMBOL_DELAY_MS = 300;
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 2000;

// =========================================
// Helpers
// =========================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text }
    );
  } catch (e) {
    console.warn(`⚠️ Telegram failed: ${e.message}`);
  }
}

// =========================================
// Parse tickerInitial JSON
// =========================================
function parseTickerInitial(html) {
  const idx = html.search(/tickerInitial/);
  if (idx === -1) {
    console.log('❌ tickerInitial not found');
    return null;
  }

  const bracketStart = html.indexOf('[', idx);
  if (bracketStart === -1 || bracketStart > idx + 200) {
    console.log('❌ no "[" near tickerInitial');
    return null;
  }

  let depth = 0, bracketEnd = -1, inString = false, escapeNext = false;
  for (let i = bracketStart; i < Math.min(html.length, bracketStart + 500000); i++) {
    const c = html[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (c === '\\') { escapeNext = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) { bracketEnd = i; break; }
    }
  }

  if (bracketEnd === -1) {
    console.log('❌ no matching "]"');
    return null;
  }

  const raw = html.substring(bracketStart, bracketEnd + 1);
  console.log(`📦 Raw tickerInitial: ${raw.length} bytes`);

  let tickers = null;
  try {
    tickers = JSON.parse(raw);
    console.log(`✅ Direct JSON: ${tickers.length} entries`);
  } catch (e) {
    console.log(`   direct failed: ${e.message}`);
  }

  if (!tickers) {
    try {
      const cleaned = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      tickers = JSON.parse(cleaned);
      console.log(`✅ After unescape: ${tickers.length} entries`);
    } catch (e) {
      console.log(`   unescape failed: ${e.message}`);
    }
  }

  if (!tickers) {
    try {
      tickers = [];
      const pattern = /code\\?"\s*:\s*\\?"([A-Z0-9&._()\-]+)\\?"\s*,\s*\\?"price\\?"\s*:\s*\\?"([\d.,]+)\\?"/g;
      let m;
      while ((m = pattern.exec(raw)) !== null) {
        tickers.push({ code: m[1], price: m[2], change: 0, delta: 0 });
      }
      console.log(`✅ Regex fallback: ${tickers.length} entries`);
    } catch (e) {
      console.log(`   regex failed: ${e.message}`);
    }
  }

  return tickers && tickers.length ? tickers : null;
}

// =========================================
// Latest Board
// =========================================
async function getLatestBoard() {
  const url = `${BASE}/markets/latest-share-price`;
  console.log(`🌐 Fetching board: ${url}`);

  const { data: html, status } = await axios.get(url);
  console.log(`📄 HTTP ${status}, length=${html.length}`);
  console.log(`📄 Has "tickerInitial": ${html.includes('tickerInitial')}`);

  const tickers = parseTickerInitial(html);
  if (!tickers || !tickers.length) {
    console.log('❌ No tickerInitial data');
    return [];
  }

  const rows = [];
  for (const t of tickers) {
    const sym = (t.code || '').trim().toUpperCase();
    const price = parseFloat(String(t.price).replace(/,/g, ''));
    if (!sym || isNaN(price)) continue;
    rows.push({
      symbol: sym,
      close: price,
      change: typeof t.change === 'number' ? t.change : null,
    });
  }

  console.log(`✅ Board: ${rows.length} symbols`);
  if (rows.length) {
    console.log(`   Sample: ${rows.slice(0, 3).map(r => `${r.symbol}=${r.close}`).join(', ')}`);
  }
  return rows;
}

// =========================================
// Market Status
// =========================================
async function getMarketStatus() {
  try {
    const { data: html } = await axios.get(`${BASE}/markets/latest-share-price`);
    const marketClosed = /Market\s+closed/i.test(html);
    const marketOpen = /Market\s+open/i.test(html);
    const dhakaMs = Date.now() + 6 * 60 * 60 * 1000;
    const dateStr = new Date(dhakaMs).toISOString().split('T')[0];
    return { isMarketOpen: marketOpen && !marketClosed, date: dateStr };
  } catch (err) {
    console.error(`❌ Market status error: ${err.message}`);
    const dhakaMs = Date.now() + 6 * 60 * 60 * 1000;
    return { isMarketOpen: false, date: new Date(dhakaMs).toISOString().split('T')[0] };
  }
}

// =========================================
// Market Depth → Open/High/Low/YCP/Volume/Trades/Value
// =========================================
async function getMarketDepth(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url = `${BASE}/market-depth?instrument=${encoded}`;
  const { data: html } = await axios.get(url);
  const $ = cheerio.load(html);

  const stats = {};

  // Strategy 1: "Price Statistics" heading-এর parent থেকে flex rows নিই
  $('div').each((_, div) => {
    const $div = $(div);
    const firstChildText = $div.children().first().text().trim();
    if (firstChildText !== 'Price Statistics') return;

    const $container = $div.parent();
    $container.find('div.flex.items-center.justify-between').each((_, row) => {
      const $row = $(row);
      const spans = $row.find('span');
      if (spans.length < 2) return;
      const label = $(spans[0]).text().trim();
      const value = $(spans[spans.length - 1]).text().trim();
      if (label && value) stats[label] = value;
    });
  });

  // Strategy 2 fallback: known labels দিয়ে সব rows খুঁজি
  if (Object.keys(stats).length === 0) {
    const KNOWN = [
      'Open Price', "Day's High", 'Last Trade Price', "Day's Low",
      'Yesterday Close Price', 'No. of Trade', 'Close Price',
      'Total Volume', 'Total Value (mn)'
    ];
    $('div.flex.items-center.justify-between').each((_, row) => {
      const $row = $(row);
      const spans = $row.find('span');
      if (spans.length < 2) return;
      const label = $(spans[0]).text().trim();
      const value = $(spans[spans.length - 1]).text().trim();
      if (KNOWN.includes(label)) stats[label] = value;
    });
  }

  const num = (key) => {
    const raw = (stats[key] || '').trim();
    if (!raw || raw === '—' || raw === '-' || raw === 'N/A') return null;
    const n = parseFloat(raw.replace(/,/g, ''));
    return isNaN(n) ? null : n;
  };

  const int = (key) => {
    const v = num(key);
    return v === null ? null : Math.round(v);
  };

  return {
    open:   num('Open Price'),
    high:   num("Day's High"),
    low:    num("Day's Low"),
    ltp:    num('Last Trade Price'),
    ycp:    num('Yesterday Close Price'),
    closep: num('Close Price'),
    trades: int('No. of Trade'),
    volume: int('Total Volume'),
    value:  num('Total Value (mn)'),
  };
}

// =========================================
// Company → Sector / MarketCap / FreeFloat
// =========================================
async function getCompanyDetails(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url = `${BASE}/company/${encoded}`;
  const { data: html } = await axios.get(url);
  const $ = cheerio.load(html);

  const out = {
    sector: null,
    marketCap: null,
    freeFloatMarketCap: null,
    open: null,
  };

  // Key statistics cards
  $('div.p-3.rounded-xl').each((_, card) => {
    const $card = $(card);
    const label = $card.find('div').first().text().trim();
    const valueText = $card.children().last().text().trim();

    const numFrom = (s) => {
      if (!s || s === '—' || s === '-') return null;
      const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      return m ? parseFloat(m[0]) : null;
    };

    if (/^Market cap$/i.test(label))                 out.marketCap = numFrom(valueText);
    else if (/^Free float market cap$/i.test(label)) out.freeFloatMarketCap = numFrom(valueText);
    else if (/^Opening price$/i.test(label))         out.open = numFrom(valueText);
  });

  // Regex fallbacks
  if (out.marketCap == null) {
    const idx = html.indexOf('Market cap');
    if (idx > -1) {
      const m = html.substring(idx, idx + 400).match(/BDT\s*([\d,]+\.?\d*)\s*mn/);
      if (m) out.marketCap = parseFloat(m[1].replace(/,/g, ''));
    }
  }

  if (out.freeFloatMarketCap == null) {
    const idx = html.indexOf('Free float market cap');
    if (idx > -1) {
      const m = html.substring(idx, idx + 400).match(/BDT\s*([\d,]+\.?\d*)\s*mn/);
      if (m) out.freeFloatMarketCap = parseFloat(m[1].replace(/,/g, ''));
    }
  }

  if (out.open == null) {
    const idx = html.indexOf('Opening price');
    if (idx > -1) {
      const m = html.substring(idx, idx + 400).match(/BDT\s*([\d,]+\.?\d*)/);
      if (m) out.open = parseFloat(m[1].replace(/,/g, ''));
    }
  }

  // Sector badge
  $('span.inline-flex.items-center.rounded-full').each((_, el) => {
    const t = $(el).text().trim();
    if (!out.sector && t && !/^(DSE |HQ ·|Debt|Equity)/i.test(t)) {
      out.sector = t;
    }
  });

  return out;
}

// =========================================
// Enrich one symbol
// =========================================
async function enrichSymbol(row) {
  const result = {
    open: null,
    high: null,
    low: null,
    ycp: null,
    closep: null,
    volume: null,
    trades: null,
    value: null,
    sector: null,
    marketCap: null,
    freeFloatMarketCap: null,
  };

  // Step 1: market-depth
  try {
    const depth = await getMarketDepth(row.symbol);
    result.open = depth.open;
    result.high = depth.high;
    result.low = depth.low;
    result.ycp = depth.ycp;
    result.closep = depth.closep;
    result.volume = depth.volume;
    result.trades = depth.trades;
    result.value = depth.value;
  } catch (e) {
    console.warn(`⚠️ market-depth ${row.symbol}: ${e.message}`);
  }

  await sleep(PER_SYMBOL_DELAY_MS);

  // Step 2: company page
  try {
    const details = await getCompanyDetails(row.symbol);
    result.sector = details.sector;
    result.marketCap = details.marketCap;
    result.freeFloatMarketCap = details.freeFloatMarketCap;
    if (result.open == null && details.open != null) {
      result.open = details.open;
    }
  } catch (e) {
    console.warn(`⚠️ company ${row.symbol}: ${e.message}`);
  }

  // Fallback: YCP → Open
  if (result.open == null && result.ycp != null) {
    result.open = result.ycp;
  }

  return result;
}

// =========================================
// Main
// =========================================
async function fetchAndStoreStockData() {
  const startTime = Date.now();
  console.log('🚀 DSE scraper started');

  const { isMarketOpen, date } = await getMarketStatus();
  console.log(`📅 Date: ${date} | Market open: ${isMarketOpen}`);

  if (!date) {
    await sendTelegram('❌ No date.');
    await mongoose.connection.close();
    return;
  }

  const board = await getLatestBoard();
  if (!board.length) {
    await sendTelegram(`⚠️ Board empty.\n📅 ${date}`);
    await mongoose.connection.close();
    return;
  }

  await sendTelegram(
    `📦 DSE Scraper Start\n📅 Date: ${date}\n📊 Symbols: ${board.length}`
  );

  let success = 0, skipped = 0, failed = 0;

  for (let b = 0; b < board.length; b += BATCH_SIZE) {
    const batch = board.slice(b, b + BATCH_SIZE);
    const batchNum = Math.floor(b / BATCH_SIZE) + 1;
    console.log(`\n🔄 Batch ${batchNum} (${batch.length} symbols)`);

    for (const row of batch) {
      try {
        const exists = await CandleData.findOne({ symbol: row.symbol, date });
        if (exists) {
          console.log(`ℹ️  Skip: ${row.symbol}`);
          skipped++;
          continue;
        }

        if (!row.close) {
          console.warn(`⚠️  No LTP: ${row.symbol}`);
          failed++;
          continue;
        }

        const extra = await enrichSymbol(row);

        const candle = new CandleData({
          symbol: row.symbol,
          date,

          open:   extra.open,
          close:  row.close,
          high:   extra.high,
          low:    extra.low,
          ycp:    extra.ycp,
          change: row.change,

          volume: extra.volume,
          value:  extra.value,
          trades: extra.trades,

          sector:             extra.sector,
          marketCap:          extra.marketCap,
          freeFloatMarketCap: extra.freeFloatMarketCap,
        });

        await candle.save();
        success++;
        console.log(
          `✅ ${row.symbol} | LTP=${row.close} | open=${extra.open ?? '-'} | high=${extra.high ?? '-'} | vol=${extra.volume ?? '-'} | sector=${extra.sector || '-'}`
        );

        await sleep(PER_SYMBOL_DELAY_MS);
      } catch (err) {
        console.warn(`⚠️  ${row.symbol}: ${err.message}`);
        failed++;
        await sleep(PER_SYMBOL_DELAY_MS);
      }
    }

    if (b + BATCH_SIZE < board.length) {
      console.log(`⏸️  Batch done. Sleeping ${BATCH_DELAY_MS}ms...`);
      await sleep(BATCH_DELAY_MS);
    }
  }

  const elapsedSec = Math.round((Date.now() - startTime) / 1000);
  const summary = `✅ DSE Done
📅 Date: ${date}
✅ Success: ${success}
ℹ️  Skipped: ${skipped}
❌ Failed:  ${failed}
⏱️ Time: ${elapsedSec}s`;

  console.log(summary);
  await sendTelegram(summary);

  await mongoose.connection.close();
}

fetchAndStoreStockData().catch(async (err) => {
  console.error('💥 Fatal:', err);
  await sendTelegram(`💥 Fatal: ${err.message}`);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});