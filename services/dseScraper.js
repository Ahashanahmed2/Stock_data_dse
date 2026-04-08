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

      let open = null;
      let marketCap = null;
      let sector = null;

      // ✅ পদ্ধতি ১: Basic Information টেবিল খুঁজে বের করা
      $$('table').each((tableIndex, table) => {
        const $table = $$(table);
        const tableHtml = $table.html() || '';
        
        // Basic Information টেবিল চিহ্নিত করা
        if (tableHtml.includes('Basic Information') || tableHtml.includes('Authorized Capital')) {
          $table.find('tr').each((rowIndex, row) => {
            const $row = $$(row);
            const ths = $row.find('th');
            const tds = $row.find('td');
            
            ths.each((i, th) => {
              const key = $$(th).text().trim();
              
              if (tds.length > i) {
                let raw = $$(tds[i]).text().trim().replace(/,/g, '');
                
                if (key === 'Opening Price') {
                  // ✅ NaN এরর ফিক্স
                  if (raw && raw !== '-' && raw !== '--' && !isNaN(parseFloat(raw))) {
                    open = parseFloat(raw);
                  }
                }
                if (key === 'Market Capitalization (mn)') {
                  if (raw && raw !== '-' && raw !== '--' && !isNaN(parseFloat(raw))) {
                    marketCap = parseFloat(raw);
                  }
                }
                if (key === 'Sector') {
                  sector = raw || null;
                }
              }
            });
          });
        }
      });

      // ✅ পদ্ধতি ২: সরাসরি Sector খোঁজা (যদি উপরে না পাওয়া যায়)
      if (!sector) {
        $$('th').each((_, el) => {
          const thText = $$(el).text().trim();
          if (thText === 'Sector') {
            const parentRow = $$(el).closest('tr');
            const td = parentRow.find('td').eq($$(el).index());
            if (td.length) {
              sector = td.text().trim() || null;
            }
          }
        });
      }

      // ✅ পদ্ধতি ৩: রেগেক্স দিয়ে Sector খোঁজা (লাস্ট রিসোর্ট)
      if (!sector) {
        const bodyText = $$('body').text();
        const sectorMatch = bodyText.match(/Sector\s*:?\s*([A-Za-z\s&]+?)(?=\s{2,}|\n|$)/i);
        if (sectorMatch && sectorMatch[1] && sectorMatch[1].length < 50) {
          sector = sectorMatch[1].trim();
        }
      }

      // ✅ Opening Price না পাওয়া গেলে LTP থেকে close ব্যবহার করবেন না
      // open ফিল্ড null রাখুন

      // ✅ MongoDB-তে ইনসার্ট
      const candle = new CandleData({
        symbol,
        date,
        open, // NaN এর বদলে null থাকবে
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
      console.log(`✅ Saved: ${symbol} | Sector: ${sector || 'N/A'} | Open: ${open || 'N/A'}`);
      success++;
      
      // ✅ রেট লিমিট এড়াতে ছোট ডেলে
      await new Promise(resolve => setTimeout(resolve, 100));
      
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