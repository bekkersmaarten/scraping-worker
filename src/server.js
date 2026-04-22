require('dotenv').config();
const express = require('express');
const { scrapeServicebox } = require('./scraper');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * POST /scrape
 *
 * Wordt aangeroepen door de Supabase Edge Function (start-lookup).
 * Start de scrape asynchroon en stuurt resultaten terug via callback.
 *
 * Body:
 * {
 *   "lookup_id": "uuid",
 *   "kenteken": "KR342F",
 *   "km_stand": 34000,
 *   "callback_url": "https://xxx.supabase.co/functions/v1/worker-callback",
 *   "callback_secret": "secret"
 * }
 */
app.post('/scrape', async (req, res) => {
  const { lookup_id, kenteken, km_stand, callback_url, callback_secret } = req.body;

  if (!lookup_id || !kenteken) {
    return res.status(400).json({ error: 'lookup_id en kenteken zijn verplicht' });
  }

  console.log(`\n========================================`);
  console.log(`[Server] Nieuwe scrape request ontvangen`);
  console.log(`[Server] Lookup ID: ${lookup_id}`);
  console.log(`[Server] Kenteken: ${kenteken}`);
  console.log(`[Server] KM-stand: ${km_stand || 'n.v.t.'}`);
  console.log(`========================================\n`);

  // Stuur meteen 200 terug — scraping draait op de achtergrond
  res.json({ status: 'accepted', lookup_id });

  // Start de scrape asynchroon
  try {
    const result = await scrapeServicebox(kenteken, km_stand);

    console.log('[Server] Scrape voltooid, resultaat terugsturen naar callback...');

    // Stuur resultaat terug naar Supabase via callback URL
    if (callback_url) {
      const callbackResponse = await fetch(callback_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-callback-secret': callback_secret || process.env.CALLBACK_SECRET || ''
        },
        body: JSON.stringify({
          lookup_id,
          status: 'completed',
          data: result
        })
      });

      if (!callbackResponse.ok) {
        const errorText = await callbackResponse.text();
        console.error(`[Server] Callback failed: ${callbackResponse.status} - ${errorText}`);
      } else {
        console.log('[Server] Callback succesvol verstuurd!');
      }
    } else {
      console.log('[Server] Geen callback_url, resultaat alleen gelogd');
      console.log(JSON.stringify(result, null, 2));
    }

  } catch (error) {
    console.error(`[Server] Scrape error: ${error.message}`);

    // Stuur error terug via callback
    if (callback_url) {
      try {
        await fetch(callback_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-callback-secret': callback_secret || process.env.CALLBACK_SECRET || ''
          },
          body: JSON.stringify({
            lookup_id,
            status: 'error',
            error_message: error.message
          })
        });
        console.log('[Server] Error callback verstuurd');
      } catch (callbackError) {
        console.error(`[Server] Kon error callback niet versturen: ${callbackError.message}`);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`\n🚗 Servicebox Scraping Worker draait op http://localhost:${PORT}`);
  console.log(`   POST /scrape  — Start een nieuwe kenteken lookup`);
  console.log(`   GET  /health  — Health check\n`);
});
