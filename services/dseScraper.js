// debug-enrich.js
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false, timeout: 30000 });
axios.defaults.timeout = 30000;
axios.defaults.headers.common['User-Agent'] =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BASE = 'https://new.dsebd.org';
const TEST_SYMBOL = 'AAMRATECH';

(async () => {
  // ==== 1. market-depth ====
  console.log('\n==== 1. /market-depth ====');
  try {
    const url = `${BASE}/market-depth?instrument=${TEST_SYMBOL}`;
    const { data: html, status } = await axios.get(url);
    console.log(`HTTP ${status}, length=${html.length}`);
    console.log(`Has "Price Statistics": ${html.includes('Price Statistics')}`);
    console.log(`Has "Open Price": ${html.includes('Open Price')}`);

    // Look for the "Open Price" context
    const idx = html.indexOf('Open Price');
    if (idx > -1) {
      console.log('Context:', html.substring(idx - 100, idx + 200).replace(/\s+/g, ' '));
    }

    const $ = cheerio.load(html);
    const stats = {};
    $('div').each((_, div) => {
      const $div = $(div);
      if ($div.children().first().text().trim() !== 'Price Statistics') return;
      $div.find('div.flex.items-center.justify-between').each((_, row) => {
        const label = $(row).find('span').first().text().trim();
        const value = $(row).find('span').last().text().trim();
        if (label && value) stats[label] = value;
      });
    });
    console.log('Parsed stats:', JSON.stringify(stats, null, 2));
  } catch (e) {
    console.error('❌ market-depth error:', e.message);
  }

  // ==== 2. company page ====
  console.log('\n==== 2. /company ====');
  try {
    const url = `${BASE}/company/${TEST_SYMBOL}`;
    const { data: html, status } = await axios.get(url);
    console.log(`HTTP ${status}, length=${html.length}`);
    console.log(`Has "Key statistics": ${html.includes('Key statistics')}`);
    console.log(`Has "Market cap": ${html.includes('Market cap')}`);
    console.log(`Has "Opening price": ${html.includes('Opening price')}`);

    const idx = html.indexOf('Key statistics');
    if (idx > -1) {
      console.log('Context:', html.substring(idx, idx + 600).replace(/\s+/g, ' '));
    }

    const $ = cheerio.load(html);
    let keyStatsFound = false;
    $('div').each((_, div) => {
      const $div = $(div);
      if ($div.children().first().text().trim() !== 'Key statistics') return;
      keyStatsFound = true;
      console.log('✅ Found "Key statistics" div');
      const cards = $div.find('div.p-3.rounded-xl');
      console.log(`   Cards with .p-3.rounded-xl: ${cards.length}`);
      cards.each((_, card) => {
        const $card = $(card);
        const label = $card.find('div').first().text().trim();
        const value = $card.children().last().text().trim();
        console.log(`   - ${label}: ${value}`);
      });
    });
    if (!keyStatsFound) {
      console.log('❌ No "Key statistics" div found via cheerio');
    }
  } catch (e) {
    console.error('❌ company error:', e.message);
  }
})();
