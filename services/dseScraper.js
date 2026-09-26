// services/dseScraper.js — v3.0.0
// Complete daily scraper for new.dsebd.org
// ✅ Board: tickerInitial JSON (388 symbols) with HTML table fallback
// ✅ Enrichment: market-depth (open/high/low/ycp) + company page (sector/marketCap)
// ✅ 300ms delay per symbol, 50-symbol batches with 2s breather
// ✅ MongoDB upsert, Telegram summary

const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const https = require('https');
const CandleData = require('./../models/CandleData');

// =========================================
// TLS
// =========================================
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  timeout: 60000,
});
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 60000;

// Browser-like headers
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
// Utilities
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
// ১. Parse tickerInitial JSON (Main board source)
// =========================================
function parseTickerInitial(html) {
  const idx = html.indexOf('"tickerInitial"');
  if (idx === -1) {
    console.log('❌ tickerInitial not found');
    return null;
  }

  const bracketStart = html.indexOf('[', idx);
  if (bracketStart === -1) {
    console.log('❌ no "[" after tickerInitial');
    return null;
  }

  let depth = 0, inString = false, escapeNext = false, bracketEnd = -1;

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

  // Method A: direct
  try {
    const t = JSON.parse(raw);
    console.log(`✅ Direct JSON: ${t.length} entries`);
    return t;
  } catch (e) {
    console.log(`   direct parse failed: ${e.message}`);
  }

  // Method B: unescape
  try {
    const cleaned = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const t = JSON.parse(cleaned);
    console.log(`✅ After unescape: ${t.length} entries`);
    return t;
  } catch (e) {
    console.log(`   unescape failed: ${e.message}`);
  }

  // Method C: regex
  try {
    const out = [];
    const pattern = /code\\?"\s*:\s*\\?"([A-Z0-9&._()\-]+)\\?"\s*,\s*\\?"price\\?"\s*:\s*\\?"([\d.,]+)\\?"/g;
    let m;
    while ((m = pattern.exec(raw)) !== null) {
      out.push({ code: m[1], price: m[2], change: 0, delta: 0 });
    }
    if (out.length) {
      console.log(`✅ Regex fallback: ${out.length} entries`);
      return out;
    }
  } catch (e) {
    console.log(`   regex failed: ${e.message}`);
  }

  console.log('❌ All parse methods failed');
  return null;
}

// =========================================
// ২. Latest board — JSON first, table fallback
// =========================================
async function getLatestBoard() {
  const url = `${BASE}/markets/latest-share-price`;
  console.log(`🌐 Fetching board: ${url}`);

  const { data: html, status } = await axios.get(url);
  console.log(`📄 HTTP ${status}, length=${html.length}`);

  // --- Try 1: tickerInitial JSON (main) ---
  const tickers = parseTickerInitial(html);
  if (tickers && tickers.length > 0) {
    const rows = [];
    for (const t of tickers) {
      const sym = (t.code || '').trim().toUpperCase();
      const price = parseFloat(String(t.price).replace(/,/g, ''));
      if (!sym || isNaN(price)) continue;
      rows.push({
        symbol: sym,
        close: price,
        high: null,
        low: null,
        ycp: null,
        change: typeof t.change === 'number' ? t.change : null,
        trades: null,
        value: null,
        volume: null,
      });
    }
    console.log(`✅ Board (tickerInitial): ${rows.length} symbols`);
    if (rows.length) {
      console.log(`   Sample: ${rows.slice(0, 3).map(r => `${r.symbol}=${r.close}`).join(', ')}`);
    }
    return rows;
  }

  // --- Try 2: HTML table (fallback when market open + SSR populates) ---
  console.log('⚠️ JSON empty → trying HTML table');
  const $ = cheerio.load(html);
  const rows = [];

  $('table tbody tr').each((_, row) => {
    const $row = $(row);
    const $cells = $row.find('td');
    if ($cells.length < 11) return;

    const symbol = $cells.eq(1).find('a').text().trim().toUpperCase();
    if (!symbol) return;

    const num = (idx) => {
      const t = $cells.eq(idx).text().trim().replace(/,/g, '');
      const v = parseFloat(t);
      return isNaN(v) ? null : v;
    };
    const int = (idx) => {
      const t = $cells.eq(idx).text().trim().replace(/,/g, '');
      const v = parseInt(t, 10);
      return isNaN(v) ? null : v;
    };

    rows.push({
      symbol,
      close:  num(2),
      high:   num(3),
      low:    num(4),
      ycp:    num(6),
      change: num(7),
      trades: int(8),
      value:  num(9),
      volume: int(10),
    });
  });

  console.log(`✅ Board (HTML table): ${rows.length} symbols`);
  return rows;
}

// =========================================
// ৩. Market status
// =========================================
async function getMarketStatus() {
  try {
    const { data: html } = await axios.get(`${BASE}/markets/latest-share-price`);

    const marketClosed = /Market\s+closed/i.test(html);
    const marketOpen = /Market\s+open/i.test(html);

    // Dhaka date (UTC+6)
    const dhakaMs = Date.now() + 6 * 60 * 60 * 1000;
    const dateStr = new Date(dhakaMs).toISOString().split('T')[0];

    return {
      isMarketOpen: marketOpen && !marketClosed,
      date: dateStr,
    };
  } catch (err) {
    console.error(`❌ Market status error: ${err.message}`);
    const dhakaMs = Date.now() + 6 * 60 * 60 * 1000;
    return {
      isMarketOpen: false,
      date: new Date(dhakaMs).toISOString().split('T')[0],
    };
  }
}

// =========================================
// ৪. Market Depth → Open/High/Low/YCP
// =========================================
async function getMarketDepth(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url = `${BASE}/market-depth?instrument=${encoded}`;
  const { data: html } = await axios.get(url);
  const $ = cheerio.load(html);

  const stats = {};

  $('div').each((_, div) => {
    const $div = $(div);
    if ($div.children().first().text().trim() !== 'Price Statistics') return;

    $div.find('div.flex.items-center.justify-between').each((_, row) => {
      const label = $(row).find('span').first().text().trim();
      const value = $(row).find('span').last().text().trim();
      if (label && value) stats[label] = value;
    });
  });

  const num = (key) => {
    const v = (stats[key] || '').replace(/,/g, '').trim();
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  return {
    open:   num('Open Price'),
    high:   num("Day's High"),
    low:    num("Day's Low"),
    ltp:    num('Last Trade Price'),
    ycp:    num('Yesterday Close Price'),
    closep: num('Close Price'),
    trades: num('No. of Trade'),
    volume: num('Total Volume'),
    value:  num('Total Value (mn)'),
  };
}

// =========================================
// ৫. Company page → Sector + Market Cap
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
    lastUpdate: null,
  };

  // Key statistics box
  $('div').each((_, div) => {
    const $div = $(div);
    if ($div.children().first().text().trim() !== 'Key statistics') return;

    $div.find('div.p-3.rounded-xl').each((_, card) => {
      const $card = $(card);
      const label = $card.find('div').first().text().trim();
      const valueText = $card.children().last().text().trim();

      const numFrom = (s) => {
        const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
        return m ? parseFloat(m[0]) : null;
      };

      if (/^Market cap$/i.test(label))                 out.marketCap = numFrom(valueText);
      else if (/^Free float market cap$/i.test(label)) out.freeFloatMarketCap = numFrom(valueText);
      else if (/^Opening price$/i.test(label))         out.open = numFrom(valueText);
      else if (/^Last Update$/i.test(label))           out.lastUpdate = valueText;
    });
  });

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
// ৬. Per-symbol enrichment
// =========================================
async function enrichSymbol(row) {
  const result = {
    open: null,
    high: row.high,
    low: row.low,
    ycp: row.ycp,
    closep: null,
    volume: row.volume,
    trades: row.trades,
    value: row.value,
    sector: null,
    marketCap: null,
    freeFloatMarketCap: null,
  };

  // Market-depth: get open + fallback for high/low/ycp/volume/trades/value
  try {
    const depth = await getMarketDepth(row.symbol);
    result.open = depth.open ?? row.ycp ?? null;
    result.high = depth.high ?? row.high;
    result.low = depth.low ?? row.low;
    result.ycp = depth.ycp ?? row.ycp;
    result.closep = depth.closep;
    result.volume = depth.volume ?? row.volume;
    result.trades = depth.trades ?? row.trades;
    result.value = depth.value ?? row.value;
  } catch (e) {
    console.warn(`⚠️ market-depth ${row.symbol}: ${e.message}`);
  }

  await sleep(PER_SYMBOL_DELAY_MS);

  // Company: get sector + market cap
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

  return result;
}

// =========================================
// ৭. Main
// =========================================
async function fetchAndStoreStockData() {
  const startTime = Date.now();
  console.log('🚀 DSE scraper started');

  // Market status + date
  const { isMarketOpen, date } = await getMarketStatus();
  console.log(`📅 Date: ${date} | Market open: ${isMarketOpen}`);

  if (!date) {
    await sendTelegram('❌ Scraper aborted: no date.');
    await mongoose.connection.close();
    return;
  }

  // Board
  const board = await getLatestBoard();
  if (!board.length) {
    await sendTelegram(`⚠️ Board empty.\n📅 ${date}`);
    await mongoose.connection.close();
    return;
  }

  await sendTelegram(
    `📦 DSE Scraper Start\n📅 Date: ${date}\n📊 Symbols: ${board.length}\n⏱️ Est: ~${Math.round(board.length * PER_SYMBOL_DELAY_MS / 1000 / 60)} min`
  );

  let success = 0;
  let skipped = 0;
  let failed = 0;

  // Batch loop
  for (let b = 0; b < board.length; b += BATCH_SIZE) {
    const batch = board.slice(b, b + BATCH_SIZE);
    const batchNum = Math.floor(b / BATCH_SIZE) + 1;
    console.log(`\n🔄 Batch ${batchNum} (${batch.length} symbols)`);

    for (const row of batch) {
      try {
        const exists = await CandleData.findOne({ symbol: row.symbol, date });
        if (exists) {
          console.log(`ℹ️  Skip (exists): ${row.symbol}`);
          skipped++;
          continue;
        }

        if (!row.close) {
          console.warn(`⚠️  Skip (no LTP): ${row.symbol}`);
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
          `✅ ${row.symbol} | LTP=${row.close} | open=${extra.open ?? '-'} | sector=${extra.sector || '-'}`
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
  const summary = `✅ DSE Scraper Done
📅 Date: ${date}
✅ Success: ${success}
ℹ️  Skipped: ${skipped}
❌ Failed:  ${failed}
⏱️ Time: ${elapsedSec}s`;

  console.log(summary);
  await sendTelegram(summary);

  await mongoose.connection.close();
}

// =========================================
// ৮. Run
// =========================================
fetchAndStoreStockData().catch(async (err) => {
  console.error('💥 Fatal error:', err);
  await sendTelegram(`💥 Fatal: ${err.message}`);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});