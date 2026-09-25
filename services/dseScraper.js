const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const https = require('https');
const CandleData = require('./../models/CandleData');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  timeout: 60000,
});
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 60000;

mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE = 'https://new.dsebd.org';

// ─────────────────────────────────────────────
// ১. latest-share-price থেকে পুরো বোর্ড
// ─────────────────────────────────────────────
async function getLatestBoard() {
  const { data: html } = await axios.get(`${BASE}/markets/latest-share-price`);
  const $ = cheerio.load(html);
  const rows = [];

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
      close:  num('td:nth-child(3)'),   // LTP
      high:   num('td:nth-child(4)'),
      low:    num('td:nth-child(5)'),
      ycp:    num('td:nth-child(7)'),
      change: num('td:nth-child(8)'),
      trades: int('td:nth-child(9)'),
      value:  num('td:nth-child(10)'),  // VALUE (mn)
      volume: int('td:nth-child(11)'),
    });
  });

  return rows;
}

// ─────────────────────────────────────────────
// ২. market status / today's date
// ─────────────────────────────────────────────
async function getMarketStatus() {
  try {
    const { data: html } = await axios.get(`${BASE}/markets/latest-share-price`);
    const match = html.match(/On (\w+ \d{1,2}, \d{4}) at/);
    if (match) {
      const updateDate = new Date(match[1]);
      const today = new Date();
      return {
        isMarketOpen: updateDate.toDateString() === today.toDateString(),
        date: updateDate.toISOString().split('T')[0],
      };
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

  // ── Key statistics বক্সে লেবেল-মান পেয়ার খোঁজা
  $('div').each((_, div) => {
    const $div = $(div);
    const header = $div.children().first().text().trim();
    if (header !== 'Key statistics') return;

    // প্রতিটি ছোট কার্ডে লেবেল + মান
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

  // ── Sector — h1 এর পরে rounded-full ব্যাজের প্রথমটি
  $('span.inline-flex.items-center.rounded-full').each((_, el) => {
    const t = $(el).text().trim();
    // "DSE PUBLIC", "HQ · ..." ব্যাজ বাদ দিয়ে প্রথম সাধারণ ব্যাজ
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
  if (!isMarketOpen || !date) {
    console.log('❌ Market Closed Today or Date not found');
    mongoose.connection.close();
    return;
  }

  const board = await getLatestBoard();
  console.log(`📦 Total symbols: ${board.length}`);

  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID,
    text: `📦 Scraping Start\n📦 Total symbols: ${board.length}`,
  });

  let success = 0, failed = 0;

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
        symbol:  row.symbol,
        date,
        open:    details.open,
        close:   row.close,
        high:    row.high,
        low:     row.low,
        volume:  row.volume,
        value:   row.value,
        trades:  row.trades,
        change:  row.change,
        marketCap:         details.marketCap,
        freeFloatMarketCap: details.freeFloatMarketCap,
        sector:  details.sector,
      });

      await candle.save();
      console.log(`✅ ${row.symbol} | sector=${details.sector || 'N/A'} | mcap=${details.marketCap ?? 'N/A'}`);
      success++;

      // polite delay — একটু বিরতি দিয়ে রিকোয়েস্ট করলে block কম হবে
      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      console.warn(`⚠️ Error for ${row.symbol}: ${err.message}`);
      failed++;
    }
  }

  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID,
    text: `✅ Done. Success: ${success}, Failed: ${failed}`,
  });

  console.log(`✅ Done. Success: ${success}, Failed: ${failed}`);
  mongoose.connection.close();
}

fetchAndStoreStockData();
