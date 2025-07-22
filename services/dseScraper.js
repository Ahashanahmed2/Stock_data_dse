
const crone = require("node-cron")
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const CandleData = require('./../models/services.dseScraper');

// MongoDB সংযোগ
mongoose.connect(process.env.MONGO_URI);
//Telegram সংযোগ
let TELEGRAM_TOKEN=process.env.TELEGRAM_TOKEN;
let TELEGRAM_CHAT_ID=process.env.TELEGRAM_CHAT_ID;

// ✅ মার্কেট খোলা কি না চেক করুন
async function getMarketStatus() {
  try {
    const { data: html } = await axios.get('https://www.dsebd.org/index.php');
    const $ = cheerio.load(html);
    const updateText = $('h2.Bodyheading').first().text().trim();

    const match = updateText.match(/Last update on (\w+ \d{2}, \d{4}) at/);
    if (match && match[1]) {
      const updateDate = new Date(match[1]);
      const today = new Date();
      const isMarketOpen = updateDate.toDateString() === today.toDateString();
      return {
        isMarketOpen,
        date: isMarketOpen ? updateDate.toISOString().split('T')[0] : null
      };
    }
    return { isMarketOpen: false, date: null };
  } catch (err) {
    console.error('❌ Market status error:', err.message);
    return { isMarketOpen: false, date: null };
  }
}
let count = 1
// ✅ স্টক সিম্বল সংগ্রহ করুন
async function getStockSymbols() {
  try {
    const { data: html } = await axios.get('https://www.dsebd.org/latest_share_price_scroll_by_ltp.php');
    const $ = cheerio.load(html);
    const symbols = [];

    $('table.table tbody tr').each((_, row) => {
      const symbol = $(row).find('td:nth-child(2) a').text().trim();
      if (symbol) symbols.push(symbol);
    });

    return symbols;
  } catch (err) {
    console.error('❌ Symbols fetch error:', err.message);
    return [];
  }
}

// ✅ DSE থেকে ডেটা স্ক্র্যাপ এবং MongoDB-তে সংরক্ষণ (ডুপ্লিকেট চেক সহ)
async function fetchAndStoreStockData() {
  const { isMarketOpen, date } = await getMarketStatus();
  if (!isMarketOpen || !date) {
    console.log('❌ Market Closed Today or Date not found');
    mongoose.connection.close();
    return;
  }

  const symbols = await getStockSymbols();
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID,
    text: `📦 Scriping Start 📦\n📦 Total symbols: ${symbols.length}`
  });

  console.log(`📦 Total symbols: ${symbols.length}`);

  let success = 0, failed = 0;

  const { data: detailHtml } = await axios.get('https://www.dsebd.org/latest_share_price_scroll_by_ltp.php');
  const $ = cheerio.load(detailHtml);

  for (const symbol of symbols) {
    try {
      // 📌 ডুপ্লিকেট চেক (symbol + date)
      const exists = await CandleData.findOne({ symbol, date });
      if (exists) {
        console.log(`ℹ️ Already exists: ${symbol} on ${date}`);
        continue;
      }

      // LTP ডেটা সংগ্রহ
      let ltpData = {};
      $('table.table tbody tr').each((_, row) => {
        const sym = $(row).find('td:nth-child(2) a').text().trim();
        if (sym === symbol) {
          ltpData = {
            close: parseFloat($(row).find('td:nth-child(6)').text().trim().replace(/,/g, '')) || null,
            high: parseFloat($(row).find('td:nth-child(4)').text().trim().replace(/,/g, '')) || null,
            low: parseFloat($(row).find('td:nth-child(5)').text().trim().replace(/,/g, '')) || null,
            volume: parseInt($(row).find('td:nth-child(11)').text().trim().replace(/,/g, '')) || null,
            value: parseFloat($(row).find('td:nth-child(10)').text().trim().replace(/,/g, '')) || null,
            change: parseFloat($(row).find('td:nth-child(8)').text().trim().replace(/,/g, '')) || null,
            trades: parseInt($(row).find('td:nth-child(9)').text().trim().replace(/,/g, '')) || null
          };
        }
      });

      if (!ltpData.close) {
        console.warn(`⚠️ Skipped ${symbol}: No LTP data`);
        failed++;
        continue;
      }

      // কোম্পানির অতিরিক্ত ডেটা
      const { data: companyHtml } = await axios.get(`https://www.dsebd.org/displayCompany.php?name=${symbol}`);
      const $$ = cheerio.load(companyHtml);
      let table = $$('table#company').eq(1);

      let open = null;
      let marketCap = null;

      table.find('tr').each((_, row) => {
        const $row = $$(row);
        const ths = $row.find('th');
        const tds = $row.find('td');

        ths.each((i, th) => {
          const key = $$(th).text().trim();
          const raw = $$(tds[i]).text().trim().replace(/,/g, '');
          const value = raw === '' ? null : raw;

          if (key === 'Opening Price') open = parseFloat(value);
          if (key === "Market Capitalization (mn)") marketCap = parseFloat(value);
        });
      });

      // ✅ MongoDB-তে ইনসার্ট
      const candle = new CandleData({
        symbol,
        date,
        open,
        close: ltpData.close,
        high: ltpData.high,
        low: ltpData.low,
        volume: ltpData.volume,
        value: ltpData.value,
        trades: ltpData.trades,
        change: ltpData.change,
        marketCap
      });

      await candle.save();
      console.log(`✅ Saved: ${symbol}`);
      success++;
    } catch (err) {
      console.warn(`⚠️ Error for ${symbol}: ${err.message}`);
      failed++;
    }
  }

  // ✅ শেষে টেলিগ্রামে নোটিফিকেশন
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID,
    text: `✅ Done. Success: ${success}, Failed: ${failed}`
  });

  console.log(`✅ Done. Success: ${success}, Failed: ${failed}`);
  mongoose.connection.close();
}
fetchAndStoreStockData()

