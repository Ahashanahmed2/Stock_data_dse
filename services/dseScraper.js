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
      // 📌 ডুপ্লিকেট চেক
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

      // ✅ সব টেবিল চেক করুন
      $$('table').each((tableIndex, table) => {
        const $table = $$(table);
        
        $table.find('tr').each((rowIndex, row) => {
          const $row = $$(row);
          const ths = $row.find('th');
          const tds = $row.find('td');
          
          ths.each((i, th) => {
            const key = $$(th).text().trim();
            
            if (tds.length > i) {
              const raw = $$(tds[i]).text().trim().replace(/,/g, '');
              const value = raw === '' ? null : raw;
              
              if (key === 'Opening Price') open = parseFloat(value);
              if (key === 'Market Capitalization (mn)') marketCap = parseFloat(value);
              if (key === 'Sector') sector = raw;
            }
          });
        });
      });

      // ✅ ফলব্যাক পদ্ধতি
      if (!sector) {
        $$('th').each((_, el) => {
          if ($$(el).text().trim() === 'Sector') {
            const nextTd = $$(el).next('td');
            if (nextTd.length) {
              sector = nextTd.text().trim();
            }
          }
        });
      }

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