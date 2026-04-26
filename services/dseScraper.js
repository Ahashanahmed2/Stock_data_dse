const crone = require("node-cron")
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const CandleData = require('./../models/CandleData');

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
      let sector = null;

      // --- ✅ চূড়ান্ত সেক্টর পার্সিং (সকল সম্ভাব্য পদ্ধতি) ---

      // পদ্ধতি ১: যেকোনো টেবিল সেলে "Sector" টেক্সট খুঁজে পরবর্তী সেলের মান নেওয়া
      $$('td, th').each((_, el) => {
        const text = $$(el).text().trim();
        if (text.match(/^Sector\s*$/i)) {
          const nextCell = $$(el).next('td');
          if (nextCell.length) {
            const value = nextCell.text().trim();
            if (value && value.length > 2 && value.length < 100 && !value.includes('Company List')) {
              sector = value;
              return false;
            }
          }
        }
      });
      if (sector) console.log(`   ✅ Method 1 found: ${sector}`);

      // পদ্ধতি ২: "Basic Information" টেবিলের মধ্যে ২-কলাম ফরম্যাটে খোঁজা
      if (!sector) {
        $$('table').each((_, tbl) => {
          const $tbl = $$(tbl);
          if ($tbl.text().includes('Basic Information')) {
            $tbl.find('tr').each((_, row) => {
              const cells = $$(row).find('td');
              if (cells.length === 2) {
                const key = $$(cells[0]).text().trim();
                if (key === 'Sector') {
                  const value = $$(cells[1]).text().trim();
                  if (value && value.length > 2 && value.length < 100) {
                    sector = value;
                    return false;
                  }
                }
              }
            });
          }
          if (sector) return false;
        });
      }
      if (sector) console.log(`   ✅ Method 2 found: ${sector}`);

      // পদ্ধতি ৩: "Basic Information" টেবিলের মধ্যে ৪-কলাম ফরম্যাটে খোঁজা
      if (!sector) {
        $$('table').each((_, tbl) => {
          const $tbl = $$(tbl);
          if ($tbl.text().includes('Basic Information')) {
            $tbl.find('tr').each((_, row) => {
              const cells = $$(row).find('td');
              if (cells.length >= 4) {
                const key1 = $$(cells[0]).text().trim();
                const value1 = $$(cells[1]).text().trim();
                const key2 = $$(cells[2]).text().trim();
                const value2 = $$(cells[3]).text().trim();

                if (key1 === 'Sector' && value1 && value1.length < 100) sector = value1;
                if (key2 === 'Sector' && value2 && value2.length < 100) sector = value2;
                if (sector) return false;
              }
            });
          }
          if (sector) return false;
        });
      }
      if (sector) console.log(`   ✅ Method 3 found: ${sector}`);

      // পদ্ধতি ৪: "Sector:" লেবেল খুঁজে সম্পূর্ণ ভ্যালু নেওয়া (ফিক্সড রেগেক্স)
      if (!sector) {
        const bodyText = $$('body').text();
        const sectorLabelRegex = /Sector\s*:\s*/i;
        let sectorMatch = bodyText.match(sectorLabelRegex);
        
        if (sectorMatch) {
          const startIndex = sectorMatch.index + sectorMatch[0].length;
          const remainingText = bodyText.substring(startIndex);
          // Improved regex to capture full sector name including special characters
          const sectorValueMatch = remainingText.match(/^([A-Za-z0-9\s&()\-.,]+?)(?=\s{2,}|\n|Sector|[A-Z][a-z]+\s*:|$)/);
          
          if (sectorValueMatch && sectorValueMatch[1]) {
            let possibleSector = sectorValueMatch[1].trim();
            if (possibleSector.length > 2 && possibleSector.length < 100 && !possibleSector.includes('Company List')) {
              sector = possibleSector;
            }
          }
        }
      }
      if (sector) console.log(`   ✅ Method 4 found: ${sector}`);

      // পদ্ধতি ৫: Bond সেক্টরের জন্য স্পেশাল চেক
      if (!sector) {
        const bodyText = $$('body').text();
        const bondPatterns = [
          /Sector\s*:?\s*(Corporate\s*Bond)/i,
          /Sector\s*:?\s*(Govt\.?\s*Bond)/i,
          /Sector\s*:?\s*(Treasury\s*Bond)/i,
          /Sector\s*:?\s*([A-Za-z\s]*Bond[A-Za-z\s]*)/i,
          /Sector\s*:?\s*([A-Za-z\s]*Debenture[A-Za-z\s]*)/i
        ];
        
        for (const pattern of bondPatterns) {
          const match = bodyText.match(pattern);
          if (match && match[1]) {
            let bondSector = match[1].trim();
            if (bondSector.length > 2 && bondSector.length < 100) {
              sector = bondSector;
              break;
            }
          }
        }
      }
      if (sector) console.log(`   ✅ Method 5 (Bond check) found: ${sector}`);

      // পদ্ধতি ৬: HTML স্ট্রাকচার থেকে সরাসরি খোঁজা (সর্বশেষ চেষ্টা)
      if (!sector) {
        const htmlText = $$.html();
        const sectorPattern = />Sector\s*:?\s*<\/(?:th|td)>\s*<td[^>]*>([^<]+)<\/td>/i;
        const match = htmlText.match(sectorPattern);
        if (match && match[1]) {
          let value = match[1].trim();
          if (value && value.length > 2 && value.length < 100) {
            sector = value;
          }
        }
      }
      if (sector) console.log(`   ✅ Method 6 (HTML structure) found: ${sector}`);

      console.log(`   🔍 Final Sector for ${symbol}: ${sector || 'NOT FOUND'}`);
      // --- সেক্টর পার্সিং শেষ ---

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

      // ✅ MongoDB-তে ইনসার্ট (sector সহ)
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
        sector
      });

      await candle.save();
      console.log(`✅ Saved: ${symbol} | Sector: ${sector || 'N/A'}`);
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