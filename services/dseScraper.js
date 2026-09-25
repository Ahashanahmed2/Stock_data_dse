// services/dseScraper.js

const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const https = require('https');
const CandleData = require('./../models/CandleData');

// TLS — GitHub Actions-এর জন্য
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  timeout: 60000,
});
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 60000;

// বাস্তব ব্রাউজারের মতো headers
axios.defaults.headers.common['User-Agent'] =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
axios.defaults.headers.common['Accept'] =
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
axios.defaults.headers.common['Accept-Language'] = 'en-US,en;q=0.9';
axios.defaults.headers.common['Cache-Control'] = 'no-cache';

// MongoDB সংযোগ
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE = 'https://new.dsebd.org';

// ─────────────────────────────────────────────
// Telegram helper
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// ১. latest-share-price থেকে পুরো বোর্ড
// ─────────────────────────────────────────────
async function getLatestBoard() {
  const url = `${BASE}/markets/latest-share-price`;
  console.log(`🌐 Fetching: ${url}`);

  const { data: html, status } = await axios.get(url);

  // 🔍 ডায়াগনস্টিক
  console.log(`📄 HTTP status: ${status}`);
  console.log(`📄 HTML length: ${html.length} bytes`);
  console.log(`📄 Contains <table>: ${html.includes('<table')}`);
  console.log(`📄 Contains 'TRADING CODE': ${html.includes('TRADING CODE')}`);
  console.log(`📄 Contains '1JANATAMF': ${html.includes('1JANATAMF')}`);

  const $ = cheerio.load(html);
  console.log(`🔢 <table> count: ${$('table').length}`);
  console.log(`🔢 table tbody tr count: ${$('table tbody tr').length}`);
  console.log(`🔢 all <tr> count: ${$('tr').length}`);
  console.log(`🔢 /company/ anchors: ${$('a[href*="/company/"]').length}`);

  console.log('📄 HTML head: ' + html.slice(0, 400).replace(/\s+/g, ' '));

  const rows = [];

  // Primary selector — টেবিল
  $('table tbody tr').each((_, row) => {
    const $row = $(row);
    const symbol = $row.find('td:nth-child(2) a').text().trim();
    if (!symbol) return;

    const num = (sel) => {
      const t = $row.find(sel).text().trim().replace(/,/g, '');
      const v = parseFloat(t);
      return isNaN(v) ? null : v;
    };
    const int = (sel) => {
      const t = $row.find(sel).text().trim().replace(/,/g, '');
      const v = parseInt(t, 10);
      return isNaN(v) ? null : v;
    };

    rows.push({
      symbol,
      close: num('td:nth-child(3)'),
      high: num('td:nth-child(4)'),
      low: num('td:nth-child(5)'),
      ycp: num('td:nth-child(7)'),
      change: num('td:nth-child(8)'),
      trades: int('td:nth-child(9)'),
      value: num('td:nth-child(10)'),
      volume: int('td:nth-child(11)'),
    });
  });

  // Fallback — টেবিল খালি হলে /company/ anchor থেকে symbol
  if (rows.length === 0) {
    console.log('⚠️ Table empty — trying anchor fallback');
    $('a[href*="/company/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const m = href.match(/\/company\/([^/?#]+)/);
      if (m && m[1]) {
        const sym = decodeURIComponent(m[1]);
        if (!rows.find((r) => r.symbol === sym)) {
          rows.push({
            symbol: sym,
            close: null, high: null, low: null,
            ycp: null, change: null,
            trades: null, value: null, volume: null,
          });
        }
      }
    });
    console.log(`🔁 Fallback symbols: ${rows.length}`);
  }

  return rows;
}

// ─────────────────────────────────────────────
// ২. market status / today's date
// ─────────────────────────────────────────────
async function getMarketStatus() {
  try {
    const { data: html } = await axios.get(`${BASE}/markets/latest-share-price`);

    // 🔍 ডায়াগনস্টিক
    console.log(`📄 [status] HTML length: ${html.length}`);
    console.log(`📄 [status] Contains 'On ': ${html.includes('On ')}`);
    console.log(`📄 [status] Contains 'at ': ${html.includes('at ')}`);
    console.log(`📄 [status] Contains 'Last update': ${html.includes('Last update')}`);

    // সব সম্ভাব্য date pattern try
    const patterns = [
      { name: 'On <Mon> <d>, <y> at', re: /On (\w+ \d{1,2}, \d{4}) at/ },
      { name: 'On <d> <Mon>, <y> at', re: /On (\d{1,2} \w+,? \d{4}) at/ },
      { name: 'On <d> <Mon> <y> at',  re: /On (\d{1,2} \w+ \d{4}) at/ },
      { name: 'Last update on <Mon> <d>, <y>', re: /Last update on (\w+ \d{1,2}, \d{4})/i },
      { name: 'Updated <Mon> <d>,? <y>', re: /Updated?:?\s*([A-Za-z]+ \d{1,2},? \d{4})/i },
      { name: '<Mon> <d>, <y>', re: /(\w+ \d{1,2}, \d{4})/ },
    ];

    for (const p of patterns) {
      const m = html.match(p.re);
      if (m && m[1]) {
        console.log(`✅ Matched pattern: [${p.name}]`);
        console.log(`📅 Date string: "${m[1]}"`);

        const updateDate = new Date(m[1]);
        if (isNaN(updateDate.getTime())) {
          console.log(`⚠️ Could not parse date: "${m[1]}"`);
          continue;
        }

        console.log(`📅 Parsed date: ${updateDate.toString()}`);
        const today = new Date();
        const isSame = updateDate.toDateString() === today.toDateString();
        return {
          isMarketOpen: isSame,
          date: updateDate.toISOString().split('T')[0],
        };
      }
    }

    // কিছুই না মিললে debug info
    console.log('❌ No date pattern matched');
    const onIndex = html.indexOf('On ');
    if (onIndex > -1) {
      console.log(`📍 'On ' found at index ${onIndex}`);
      console.log('📄 Context: ' + html.slice(onIndex, onIndex + 200).replace(/\s+/g, ' '));
    } else {
      console.log('📍 "On " not found');
      console.log('📄 HTML first 500: ' + html.slice(0, 500).replace(/\s+/g, ' '));
    }

    return { isMarketOpen: false, date: null };
  } catch (err) {
    console.error('❌ Market status error:', err.message);
    return { isMarketOpen: false, date: null };
  }
}

// ─────────────────────────────────────────────
// ৩. /company/{symbol} থেকে sector + marketCap + freeFloat + open
// ─────────────────────────────────────────────
async function getCompanyDetails(symbol) {
  const encoded = encodeURIComponent(symbol);
  const { data: html } = await axios.get(`${BASE}/company/${encoded}`);
  const $ = cheerio.load(html);

  const out = {
    sector: null,
    marketCap: null,
    freeFloatMarketCap: null,
    open: null,
  };

  // Key statistics বক্স
  $('div').each((_, div) => {
    const $div = $(div);
    const header = $div.children().first().text().trim();
    if (header !== 'Key statistics') return;

    $div.find('div.p-3.rounded-xl').each((_, card) => {
      const $card = $(card);
      const label = $card.find('div').first().text().trim();
      const valueText = $card.children().last().text().trim();

      const numFrom = (s) => {
        const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
        return m ? parseFloat(m[0]) : null;
      };

      if (/^Market cap$/i.test(label)) out.marketCap = numFrom(valueText);
      else if (/^Free float market cap$/i.test(label)) out.freeFloatMarketCap = numFrom(valueText);
      else if (/^Opening price$/i.test(label)) out.open = numFrom(valueText);
    });
  });

  // Sector — rounded-full badge
  $('span.inline-flex.items-center.rounded-full').each((_, el) => {
    const t = $(el).text().trim();
    if (!out.sector && t && !/^(DSE |HQ ·|Debt|Equity)/i.test(t)) {
      out.sector = t;
    }
  });

  return out;
}

// ─────────────────────────────────────────────
// ৪. main
// ─────────────────────────────────────────────
async function fetchAndStoreStockData() {
  const { isMarketOpen, date } = await getMarketStatus();

  console.log(`📅 Date: ${date} | Market open: ${isMarketOpen}`);

  if (!date) {
    console.log('❌ Date not found — aborting');
    await sendTelegram(
      `❌ Scraper aborted: could not determine date from DSE page.\nMarket open: ${isMarketOpen}`
    );
    mongoose.connection.close();
    return;
  }

  const board = await getLatestBoard();
  console.log(`📦 Total symbols: ${board.length}`);

  await sendTelegram(
    `📦 Scraping Start\n📅 Date: ${date}\n📦 Total symbols: ${board.length}`
  );

  if (board.length === 0) {
    console.log('❌ No symbols found — aborting');
    await sendTelegram(
      `⚠️ No symbols found on DSE board.\n📅 Date: ${date}\n(possible bot block or page changed)`
    );
    mongoose.connection.close();
    return;
  }

  let success = 0;
  let failed = 0;

  for (const row of board) {
    try {
      const exists = await CandleData.findOne({ symbol: row.symbol, date });
      if (exists) {
        console.log(`ℹ️ Already exists: ${row.symbol} on ${date}`);
        continue;
      }

      if (!row.close) {
        console.warn(`⚠️ Skipped ${row.symbol}: No LTP data`);
        failed++;
        continue;
      }

      let details = {};
      try {
        details = await getCompanyDetails(row.symbol);
      } catch (e) {
        console.warn(`⚠️ Company detail failed for ${row.symbol}: ${e.message}`);
      }

      const candle = new CandleData({
        symbol: row.symbol,
        date,
        open: details.open,
        close: row.close,
        high: row.high,
        low: row.low,
        volume: row.volume,
        value: row.value,
        trades: row.trades,
        change: row.change,
        marketCap: details.marketCap,
        freeFloatMarketCap: details.freeFloatMarketCap,
        sector: details.sector,
      });

      await candle.save();
      console.log(
        `✅ ${row.symbol} | sector=${details.sector || 'N/A'} | mcap=${details.marketCap ?? 'N/A'}`
      );
      success++;

      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      console.warn(`⚠️ Error for ${row.symbol}: ${err.message}`);
      failed++;
    }
  }

  await sendTelegram(
    `✅ Done\n📅 Date: ${date}\n✅ Success: ${success}\n❌ Failed: ${failed}`
  );

  console.log(`✅ Done. Success: ${success}, Failed: ${failed}`);
  mongoose.connection.close();
}

fetchAndStoreStockData().catch(async (err) => {
  console.error('💥 Fatal error:', err);
  await sendTelegram(`💥 Fatal error: ${err.message}`);
  mongoose.connection.close();
  process.exit(1);
});
