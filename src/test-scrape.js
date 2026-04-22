/**
 * Test script — draait de scraper standalone (zonder server).
 *
 * Gebruik:
 *   node src/test-scrape.js KR342F 34000
 *
 * Draait met HEADLESS=false en SLOW_MO=500 zodat je de browser live ziet.
 */
require('dotenv').config();

// Forceer visuele modus voor debugging
process.env.HEADLESS = 'false';
process.env.SLOW_MO = '500';

const { scrapeServicebox } = require('./scraper');

const kenteken = process.argv[2] || 'KR342F';
const kmStand = process.argv[3] ? parseInt(process.argv[3]) : null;

console.log(`\n🔍 Test scrape gestart`);
console.log(`   Kenteken: ${kenteken}`);
console.log(`   KM-stand: ${kmStand || 'niet opgegeven'}\n`);

(async () => {
  try {
    const result = await scrapeServicebox(kenteken, kmStand);

    console.log('\n✅ Resultaat:\n');
    console.log(JSON.stringify(result, null, 2));

    // Samenvatting
    console.log('\n--- Samenvatting ---');
    console.log(`Voertuig: ${result.vehicle?.merk || '?'} ${result.vehicle?.model || '?'}`);
    console.log(`VIN: ${result.vehicle?.vin || '?'}`);
    console.log(`Recalls: ${result.recalls?.length || 0}`);
    console.log(`Intervallen: ${result.intervals?.length || 0}`);
    console.log(`Prijzen: ${result.prices?.length || 0}`);

  } catch (error) {
    console.error('\n❌ Scrape mislukt:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
