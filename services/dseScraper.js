
const crone = require("node-cron")
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const CandleData = require('./../models/services.dseScraper');

// MongoDB সংযোগ
mongoose.connect(process.env.AHASHAN111);

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

// ✅ ডেটা স্ক্র্যাপ ও সংরক্ষণ
async function fetchAndStoreStockData() {
  const { isMarketOpen, date } = await getMarketStatus();
  if (!isMarketOpen) {
    console.log('❌ Market Closed Today');
    mongoose.connection.close();
    return;
  }

  const symbols = await getStockSymbols();
  console.log(`📦 Total symbols: ${symbols.length}`);

  let success = 0, failed = 0;

  const { data: detailHtml } = await axios.get('https://www.dsebd.org/latest_share_price_scroll_by_ltp.php');
  const $ = cheerio.load(detailHtml);

  for (const symbol of symbols) {
    try {
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
           
          }
          // tr =>5=> td => 1 -9 => opening price
          // tr => 7 td =>2 -14=> market capital
          // {"_id":{"$oid":"6818b7a8227f1b426c0b28e3"},"symbol":"RECKITTBEN","date":"2025-05-04","open":null,"close":{"$numberDouble":"3500.6"},"high":{"$numberDouble":"3667.8"},"low":{"$numberDouble":"3495.3"},"volume":{"$numberInt":"3500"},"value":{"$numberDouble":"3495300000.0"},"trades":{"$numberInt":"5"},"change":{"$numberInt":"337"},"marketCap":null,"collectedAt":{"$date":{"$numberLong":"1746450344355"}},"__v":{"$numberInt":"0"}}
        }
      });

      if (!ltpData.close) {
        console.warn(`⚠️ Skipped ${symbol}: No LTP data`);
        failed++;
        continue;
      }

      // কোম্পানি ডেটা সংগ্রহ
      const { data: companyHtml } = await axios.get(`https://www.dsebd.org/displayCompany.php?name=${symbol}`);
      const $$ = cheerio.load(companyHtml);
      let table = $$('table#company');
      let table_second = $$(table).eq(1)
let open =''|| null;
let marketCap = '' || null;

table_second.find('tr').each((_, row) => {
  const $row = $$(row);
  const ths = $row.find('th');
  const tds = $row.find('td');

  ths.each((i, th) => {
    const key = $$(th).text().trim();
    // i ইন্ডেক্সের td নাও, সেটা হবে একই পজিশনের value
    const raw = $$(tds[i]).text().trim().replace(/,/g, '');
    const value = raw === '' ? null : raw;

    //console.log('key:', key, 'value:', value);

    if (key === 'Opening Price') {
      open = parseFloat(value);
    }
    if (key === "Market Capitalization (mn)") {
      marketCap = parseFloat(value) * 1e6;
    }
  })});

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
        marketCap,
        collectedAt: new Date()
      });

      await candle.save();
      console.log(`✅ Saved: ${symbol}`);
      success++;
    } catch (err) {
      console.warn(`⚠️ Error for ${symbol}: ${err.message}`);
      failed++;
    }
  }

  console.log(`✅ Done. Success: ${success}, Failed: ${failed}`);
  mongoose.connection.close();
}

fetchAndStoreStockData();
