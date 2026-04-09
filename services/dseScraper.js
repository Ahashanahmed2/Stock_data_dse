// scripts/fetchAndStoreStockData.js
// DSE থেকে স্টক ডেটা স্ক্র্যাপ ও MongoDB-তে সংরক্ষণের সম্পূর্ণ স্ক্রিপ্ট

const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');

// =========================================================
// মডেল ইম্পোর্ট
// =========================================================
const CandleData = require('../models/CandleData'); // ✅ আপনার ফোল্ডার স্ট্রাকচার অনুযায়ী পাথ ঠিক করুন

// =========================================================
// এনভায়রনমেন্ট ভেরিয়েবল
// =========================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGO_URL = process.env.MONGO_URI;

// =========================================================
// হেল্পার ফাংশন: রিট্রাই লজিক (নেটওয়ার্ক এরর সহনশীল)
// =========================================================
async function fetchWithRetry(url, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.get(url, { timeout: 30000 });
            return response;
        } catch (err) {
            if (i === retries - 1) throw err;
            console.log(`   🔄 Retry ${i + 1}/${retries} for ${url} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
        }
    }
}

// =========================================================
// হেল্পার ফাংশন: টেলিগ্রাম মেসেজ পাঠানো
// =========================================================
async function sendTelegramMessage(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('⚠️ Telegram credentials missing, skipping notification');
        return;
    }
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text,
            parse_mode: 'HTML'
        });
    } catch (err) {
        console.error('⚠️ Failed to send Telegram message:', err.message);
    }
}

// =========================================================
// হেল্পার ফাংশন: নিরাপদ নাম্বার পার্সিং
// =========================================================
function parseNumber(value) {
    if (!value || value === '-' || value === '--') return null;
    const cleaned = String(value).replace(/,/g, '').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
}

function parseIntNumber(value) {
    if (!value || value === '-' || value === '--') return null;
    const cleaned = String(value).replace(/,/g, '').trim();
    const num = parseInt(cleaned, 10);
    return isNaN(num) ? null : num;
}

// =========================================================
// প্রধান ফাংশন: DSE থেকে ডেটা স্ক্র্যাপ এবং MongoDB-তে সংরক্ষণ
// =========================================================
async function fetchAndStoreStockData() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 DSE STOCK DATA SCRAPER');
    console.log('='.repeat(60));
    
    // 1. MongoDB সংযোগ চেক
    if (mongoose.connection.readyState !== 1) {
        console.log('❌ MongoDB not connected. Attempting to connect...');
        try {
            await mongoose.connect(MONGO_URL);
            console.log('✅ MongoDB connected');
        } catch (err) {
            console.error('❌ MongoDB connection failed:', err.message);
            return;
        }
    }

    // 2. বাজার খোলা আছে কিনা চেক
    const { isMarketOpen, date } = await getMarketStatus();
    if (!isMarketOpen || !date) {
        console.log('❌ Market Closed Today or Date not found');
        await sendTelegramMessage('❌ Market Closed Today. No data scraped.');
        mongoose.connection.close();
        return;
    }
    console.log(`📅 Date: ${date} | Market: ${isMarketOpen ? 'OPEN ✅' : 'CLOSED ❌'}`);

    // 3. সিম্বল তালিকা সংগ্রহ
    const symbols = await getStockSymbols();
    console.log(`📦 Total symbols to process: ${symbols.length}`);
    await sendTelegramMessage(`📦 Scraping Started\n📅 Date: ${date}\n📦 Total symbols: ${symbols.length}`);

    // 4. LTP টেবিল একবারেই লোড করে নেওয়া (পারফরম্যান্সের জন্য)
    let $;
    try {
        const { data: detailHtml } = await fetchWithRetry('https://www.dsebd.org/latest_share_price_scroll_by_ltp.php');
        $ = cheerio.load(detailHtml);
    } catch (err) {
        console.error('❌ Failed to load LTP page:', err.message);
        await sendTelegramMessage('❌ Failed to load DSE LTP page.');
        mongoose.connection.close();
        return;
    }

    let success = 0, failed = 0, skipped = 0;
    const startTime = Date.now();

    // 5. প্রতিটি সিম্বল প্রসেস করা
    for (let idx = 0; idx < symbols.length; idx++) {
        const symbol = symbols[idx];
        
        try {
            // 📌 ডুপ্লিকেট চেক (symbol + date)
            const exists = await CandleData.findOne({ symbol, date });
            if (exists) {
                console.log(`ℹ️ [${idx + 1}/${symbols.length}] Already exists: ${symbol}`);
                skipped++;
                continue;
            }

            // LTP ডেটা সংগ্রহ
            let ltpData = null;
            $('table.table tbody tr').each((_, row) => {
                const sym = $(row).find('td:nth-child(2) a').text().trim();
                if (sym === symbol) {
                    ltpData = {
                        close: parseNumber($(row).find('td:nth-child(6)').text()),
                        high: parseNumber($(row).find('td:nth-child(4)').text()),
                        low: parseNumber($(row).find('td:nth-child(5)').text()),
                        volume: parseIntNumber($(row).find('td:nth-child(11)').text()),
                        value: parseNumber($(row).find('td:nth-child(10)').text()),
                        change: parseNumber($(row).find('td:nth-child(8)').text()),
                        trades: parseIntNumber($(row).find('td:nth-child(9)').text())
                    };
                    return false; // break loop
                }
            });

            if (!ltpData || !ltpData.close) {
                console.warn(`⚠️ [${idx + 1}/${symbols.length}] Skipped ${symbol}: No LTP data`);
                failed++;
                continue;
            }

            // কোম্পানির অতিরিক্ত ডেটা (Open, Market Cap, Sector)
            let open = null, marketCap = null, sector = null;

            try {
                const { data: companyHtml } = await fetchWithRetry(`https://www.dsebd.org/displayCompany.php?name=${symbol}`);
                const $$ = cheerio.load(companyHtml);

                // পদ্ধতি ১: Basic Information টেবিল
                $$('table').each((_, table) => {
                    const $table = $$(table);
                    const tableHtml = $table.html() || '';
                    
                    if (tableHtml.includes('Basic Information') || tableHtml.includes('Authorized Capital')) {
                        $table.find('tr').each((_, row) => {
                            const $row = $$(row);
                            const ths = $row.find('th');
                            const tds = $row.find('td');
                            
                            ths.each((i, th) => {
                                const key = $$(th).text().trim();
                                if (tds.length > i) {
                                    const raw = $$(tds[i]).text().trim();
                                    
                                    if (key === 'Opening Price') open = parseNumber(raw);
                                    if (key === 'Market Capitalization (mn)') marketCap = parseNumber(raw);
                                    if (key === 'Sector') sector = raw || null;
                                }
                            });
                        });
                    }
                });

                // পদ্ধতি ২: সরাসরি Sector খোঁজা
                if (!sector) {
                    $$('th').each((_, el) => {
                        if ($$(el).text().trim() === 'Sector') {
                            const parentRow = $$(el).closest('tr');
                            const td = parentRow.find('td').eq($$(el).index());
                            if (td.length) sector = td.text().trim() || null;
                        }
                    });
                }

                // পদ্ধতি ৩: রেগেক্স (লাস্ট রিসোর্ট)
                if (!sector) {
                    const bodyText = $$('body').text();
                    const sectorMatch = bodyText.match(/Sector\s*:?\s*([A-Za-z\s&]+?)(?=\s{2,}|\n|$)/i);
                    if (sectorMatch?.[1] && sectorMatch[1].length < 50) {
                        sector = sectorMatch[1].trim();
                    }
                }
            } catch (err) {
                console.warn(`   ⚠️ Company page error for ${symbol}: ${err.message}`);
            }

            // MongoDB-তে সংরক্ষণ
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
            console.log(`✅ [${idx + 1}/${symbols.length}] Saved: ${symbol} | Sector: ${sector || 'N/A'} | Close: ${ltpData.close}`);
            success++;

            // ব্যাচ প্রগ্রেস আপডেট (প্রতি ৫০টি)
            if (success % 50 === 0) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                await sendTelegramMessage(`📊 Progress: ${success}/${symbols.length} symbols processed\n⏱️ Elapsed: ${elapsed}s`);
            }

            // রেট লিমিট এড়াতে ছোট বিরতি
            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (err) {
            console.error(`❌ [${idx + 1}/${symbols.length}] Error for ${symbol}:`, err.message);
            failed++;
        }
    }

    // 6. সমাপ্তি ও নোটিফিকেশন
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    const summary = `
✅ <b>DSE Scraping Completed</b>
📅 Date: ${date}
📊 Total Symbols: ${symbols.length}
✅ Success: ${success}
⏭️ Skipped: ${skipped}
❌ Failed: ${failed}
⏱️ Total Time: ${Math.floor(totalTime / 60)}m ${totalTime % 60}s
    `.trim();

    console.log('\n' + '='.repeat(60));
    console.log('📊 FINAL SUMMARY');
    console.log('='.repeat(60));
    console.log(summary.replace(/<[^>]+>/g, ''));
    console.log('='.repeat(60));

    await sendTelegramMessage(summary);
    
    mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
}

// =========================================================
// ডামি ফাংশন (আপনার বাস্তব ইমপ্লিমেন্টেশন অনুযায়ী প্রতিস্থাপন করুন)
// =========================================================
async function getMarketStatus() {
    // TODO: বাস্তব বাজার সময় চেক লজিক
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '-');
    return { isMarketOpen: true, date: today };
}

async function getStockSymbols() {
    // TODO: DSE থেকে বা লোকাল লিস্ট থেকে সিম্বল আনার লজিক
    // উদাহরণ:
    // const stocks = await CandleData.distinct('symbol');
    // return stocks;
    return ['RECKITTBEN', 'MARICO', 'EASTRNLUB']; // ডেমো
}

// =========================================================
// এক্সপোর্ট ও এক্সিকিউশন
// =========================================================
module.exports = { fetchAndStoreStockData };

// সরাসরি রান করলে
if (require.main === module) {
    fetchAndStoreStockData().catch(console.error);
}
