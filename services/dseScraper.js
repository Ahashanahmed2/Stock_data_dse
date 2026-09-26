// services/dseScraper.js — v2.0.0
// Complete daily scraper for new.dsebd.org

const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const https = require('https');
const CandleData = require('./../models/CandleData');

// =========================================
// TLS — GitHub Actions / Render-এর জন্য
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

const PER_SYMBOL_DELAY_MS = 300;   // প্রতি symbol-এ delay
const BATCH_SIZE = 50;             // প্রতি ব্যাচে symbol সংখ্যা
const BATCH_DELAY_MS = 2000;       // ব্যাচ শেষে breather

// =========================================
// Utility
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
// ১. Latest board — সব সিম্বলের LTP/High/Low/...
// =========================================
async function getLatestBoard() {
  const url = `${BASE}/markets/latest-share-price`;
  console.log(`🌐 Fetching board: ${url}`);

  const { data: html, status } = await axios.get(url);
  console.log(`📄 HTTP ${status}, length=${html.length}`);

  const $ = cheerio.load(html);
  const rows = [];

  $('table tbody tr').each((_, row) => {
    const $row = $(row);
    const $cells = $row.find('td');
    if ($cells.length < 11) return;

    // TRADING CODE — ২য় সেলে (index 1)
    const symbol = $cells.eq(1).find('a').text().trim();
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
      close:  num(2),   // LTP*
      high:   num(3),   // HIGH
      low:    num(4),   // LOW
      // closep: num(5), // CLOSEP*
      ycp:    num(6),   // YCP*
      change: num(7),   // CHANGE
      trades: int(8),   // TRADE
      value:  num(9),   // VALUE (mn)
      volume: int(10),  // VOLUME
    });
  });

  console.log(`✅ Board: ${rows.length} symbols`);
  return rows;
}

// =========================================
// ২. Market status (date নির্ধারণের জন্য)
// =========================================
async function getMarketStatus() {
  try {
    const { data: html } = await axios.get(`${BASE}/markets/latest-share-price`);

    // priority ১: header time "20:10 BST" + "· Opens Sun, 27 Sept, 10:00"
    // priority ২: fallback — generic date regex

    // আজকের তারিখ Dhaka timezone (Asia/Dhaka = UTC+6) থেকে
    // এটাই সবচেয়ে নির্ভরযোগ্য কারণ new.dsebd.org header client-side render করে
    const dhakaMs = Date.now() + 6 * 60 * 60 * 1000;
    const dhaka = new Date(dhakaMs);
    const dateStr = dhaka.toISOString().split('T')[0];

    // Market closed কিনা চেক
    const marketClosed = /Market\s+closed/i.test(html);
    const marketOpen   = /Market\s+open/i.test(html);

    return {
      isMarketOpen: marketOpen && !marketClosed,
      date: dateStr,
    };
  } catch (err) {
    console.error(`❌ Market status error: ${err.message}`);
    // Dhaka date fallback
    const dhakaMs = Date.now() + 6 * 60 * 60 * 1000;
    return {
      isMarketOpen: false,
      date: new Date(dhakaMs).toISOString().split('T')[0],
    };
  }
}

// =========================================
// ৩. Market Depth → Open price
// =========================================
async function getMarketDepth(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url = `${BASE}/market-depth?instrument=${encoded}`;
  const { data: html } = await axios.get(url);
  const $ = cheerio.load(html);

  const stats = {};

  // "Price Statistics" শিরোনামযুক্ত div খুঁজে বের করা
  $('div').each((_, div) => {
    const $div = $(div);
    const headerText = $div.children().first().text().trim();
    if (headerText !== 'Price Statistics') return;

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
// ৪. Company page → Market Cap + Free Float + Sector
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

  // Key statistics বক্স
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

      if (/^Market cap$/i.test(label))                out.marketCap = numFrom(valueText);
      else if (/^Free float market cap$/i.test(label)) out.freeFloatMarketCap = numFrom(valueText);
      else if (/^Opening price$/i.test(label))        out.open = numFrom(valueText);
      else if (/^Last Update$/i.test(label))          out.lastUpdate = valueText;
    });
  });

  // Sector badge — h1 এর পরে rounded-full badge, প্রথম সাধারণ badge
  $('span.inline-flex.items-center.rounded-full').each((_, el) => {
    const t = $(el).text().trim();
    if (!out.sector && t && !/^(DSE |HQ ·|Debt|Equity)/i.test(t)) {
      out.sector = t;
    }
  });

  return out;
}

// =========================================
// ৫. Per-symbol enrichment (open + company info)
// =========================================
async function enrichSymbol(row) {
  const result = {
    open: null,
    sector: null,
    marketCap: null,
    freeFloatMarketCap: null,
  };

  // Market depth → Open
  try {
    const depth = await getMarketDepth(row.symbol);
    result.open = depth.open;
  } catch (e) {
    console.warn(`⚠️ market-depth ${row.symbol}: ${e.message}`);
  }

  await sleep(PER_SYMBOL_DELAY_MS);

  // Company page → sector + market cap
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
// ৬. Main
// =========================================
async function fetchAndStoreStockData() {
  const startTime = Date.now();
  console.log('🚀 DSE scraper started');

  // ১. Market status + date
  const { isMarketOpen, date } = await getMarketStatus();
  console.log(`📅 Date: ${date} | Market open: ${isMarketOpen}`);

  if (!date) {
    await sendTelegram('❌ Scraper aborted: no date determined.');
    await mongoose.connection.close();
    return;
  }

  // ২. Latest board — সব সিম্বলের LTP/High/Low/...
  const board = await getLatestBoard();
  if (!board.length) {
    await sendTelegram(`⚠️ No symbols on board.\n📅 ${date}`);
    await mongoose.connection.close();
    return;
  }

  await sendTelegram(
    `📦 DSE Scraping Start\n📅 Date: ${date}\n📊 Symbols: ${board.length}\n⏱️ Est: ~${Math.round(board.length * PER_SYMBOL_DELAY_MS / 1000 / 60)} min`
  );

  let success = 0;
  let skipped = 0;
  let failed = 0;

  // ৩. Batch loop
  for (let b = 0; b < board.length; b += BATCH_SIZE) {
    const batch = board.slice(b, b + BATCH_SIZE);
    console.log(`\n🔄 Batch ${Math.floor(b / BATCH_SIZE) + 1} (${batch.length} symbols)`);

    for (const row of batch) {
      try {
        // Already exists?
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

        // Enrichment: open, sector, market cap
        const extra = await enrichSymbol(row);

        const candle = new CandleData({
          symbol: row.symbol,
          date,

          open:   extra.open   ?? row.ycp ?? null,   // fallback to YCP if market-depth fails
          close:  row.close,
          high:   row.high,
          low:    row.low,
          ycp:    row.ycp,
          change: row.change,

          volume: row.volume,
          value:  row.value,
          trades: row.trades,

          sector:             extra.sector,
          marketCap:          extra.marketCap,
          freeFloatMarketCap: extra.freeFloatMarketCap,
        });

        await candle.save();
        success++;
        console.log(
          `✅ ${row.symbol} | LTP=${row.close} | open=${extra.open ?? '-'} | sector=${extra.sector || '-'}`
        );

        // Polite delay after each successful save
        await sleep(PER_SYMBOL_DELAY_MS);
      } catch (err) {
        console.warn(`⚠️  ${row.symbol}: ${err.message}`);
        failed++;
        await sleep(PER_SYMBOL_DELAY_MS);
      }
    }

    // Batch breather
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
// ৭. Run
// =========================================
fetchAndStoreStockData().catch(async (err) => {
  console.error('💥 Fatal error:', err);
  await sendTelegram(`💥 Fatal: ${err.message}`);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});