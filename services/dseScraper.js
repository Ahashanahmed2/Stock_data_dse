// services/dseScraper.js — v7.0.0
// ✅ Puppeteer দিয়ে JS-render করে HIGH/LOW/YCP/TRADE/VALUE/VOLUME আনি
// ✅ company page → Sector/MarketCap/FreeFloat
// ✅ 300ms delay + 50-symbol batches
// ✅ MongoDB upsert (symbol+date unique)
// ✅ Telegram start + summary

const puppeteer = require('puppeteer');
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
async function connectMongo() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  console.log('✅ MongoDB connected:', mongoose.connection.name);
}

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
// Puppeteer দিয়ে full board আনি
// =========================================
async function getLatestBoardWithJS() {
  console.log('🌐 Launching Puppeteer...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1920, height: 1080 });

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.warn('⚠️ page console:', msg.text());
  });

  const url = `${BASE}/markets/latest-share-price`;
  console.log(`🌐 Navigating: ${url}`);

  await page.goto(url, {
    waitUntil: 'networkidle2',
    timeout: 90000,
  });

  // Wait for real table rows
  try {
    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('table tbody tr');
        return rows.length > 50;
      },
      { timeout: 45000 }
    );
    console.log('✅ Table populated');
  } catch (e) {
    console.warn('⚠️ Timeout waiting for table rows:', e.message);
    const content = await page.content();
    console.log('📄 Page length:', content.length);
    console.log('📄 Has <table>:', content.includes('<table'));
    console.log('📄 Has TRADING CODE:', content.includes('TRADING CODE'));
  }

  await sleep(3000);

  const rows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tbody tr').forEach((tr) => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 11) return;

      const symbol = tds[1].textContent.trim().toUpperCase();
      if (!symbol || symbol.length < 2) return;

      const num = (i) => {
        const t = tds[i]?.textContent.trim().replace(/,/g, '');
        if (!t || t === '—' || t === '-') return null;
        const v = parseFloat(t);
        return isNaN(v) ? null : v;
      };

      out.push({
        symbol,
        close:  num(2),   // LTP*
        high:   num(3),   // HIGH
        low:    num(4),   // LOW
        closep: num(5),   // CLOSEP*
        ycp:    num(6),   // YCP*
        change: num(7),   // CHANGE
        trades: num(8),   // TRADE
        value:  num(9),   // VALUE (mn)
        volume: num(10),  // VOLUME
      });
    });
    return out;
  });

  await browser.close();
  console.log(`✅ Board (Puppeteer): ${rows.length} symbols`);

  if (rows.length > 0) {
    console.log('   Sample:', JSON.stringify(rows.slice(0, 2), null, 2));
  }

  return rows;
}

// =========================================
// Market Status (date শুধু)
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
// Company Details
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
// Main
// =========================================
async function fetchAndStoreStockData() {
  const startTime = Date.now();
  console.log('🚀 DSE scraper started (Puppeteer mode)');

  try {
    await connectMongo();
  } catch (e) {
    console.error('❌ MongoDB connect failed:', e.message);
    await sendTelegram(`❌ MongoDB connect failed: ${e.message}`);
    process.exit(1);
  }

  const { date } = await getMarketStatus();
  console.log(`📅 Date: ${date}`);

  if (!date) {
    await sendTelegram('❌ No date.');
    await mongoose.connection.close();
    return;
  }

  // Puppeteer দিয়ে board আনি
  let board = [];
  try {
    board = await getLatestBoardWithJS();
  } catch (e) {
    console.error('❌ Puppeteer failed:', e.message);
    await sendTelegram(`❌ Puppeteer failed: ${e.message}`);
    await mongoose.connection.close();
    process.exit(1);
  }

  if (!board.length) {
    await sendTelegram(`⚠️ Board empty.\n📅 ${date}`);
    await mongoose.connection.close();
    return;
  }

  await sendTelegram(
    `📦 DSE Scraper Start\n📅 Date: ${date}\n📊 Symbols: ${board.length}`
  );

  let inserted = 0, updated = 0, skipped = 0, failed = 0;

  for (let b = 0; b < board.length; b += BATCH_SIZE) {
    const batch = board.slice(b, b + BATCH_SIZE);
    const batchNum = Math.floor(b / BATCH_SIZE) + 1;
    console.log(`\n🔄 Batch ${batchNum} (${batch.length} symbols)`);

    for (const row of batch) {
      try {
        // Company page → sector + marketCap + freeFloat + open fallback
        let details = {};
        try {
          details = await getCompanyDetails(row.symbol);
        } catch (e) {
          console.warn(`⚠️ company ${row.symbol}: ${e.message}`);
        }

        const doc = {
          symbol: row.symbol,
          date,

          // Price
          open:   details.open != null ? details.open : row.ycp,
          close:  row.close,                // LTP* from HTML table
          high:   row.high,
          low:    row.low,
          ycp:    row.ycp,
          change: row.change,

          // Volume / value
          volume: row.volume,
          value:  row.value,
          trades: row.trades,

          // Company
          sector:             details.sector,
          marketCap:          details.marketCap,
          freeFloatMarketCap: details.freeFloatMarketCap,

          savedAt: new Date(),
        };

        const res = await CandleData.updateOne(
          { symbol: row.symbol, date },
          { $set: doc },
          { upsert: true }
        );

        if (res.upsertedCount > 0) {
          inserted++;
          console.log(
            `✅ INSERT ${row.symbol} | close=${row.close} | H=${row.high ?? '-'} | L=${row.low ?? '-'} | V=${row.volume ?? '-'} | trades=${row.trades ?? '-'} | sector=${details.sector || '-'}`
          );
        } else if (res.modifiedCount > 0) {
          updated++;
          console.log(`🔄 UPDATE ${row.symbol}`);
        } else {
          skipped++;
          console.log(`ℹ️  No change ${row.symbol}`);
        }

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
✅ Inserted: ${inserted}
🔄 Updated:  ${updated}
ℹ️  Skipped:  ${skipped}
❌ Failed:   ${failed}
⏱️ Total:   ${board.length}
⏱️ Time:    ${elapsedSec}s`;

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