require('dotenv').config();
const express = require('express');
const { scrapeServicebox, scrapeQuotelink, activateWarranty, scrapeFrequencyOnly } = require('./scraper');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// =========================================
// WORKER_MODE: 'scrape', 'warranty', of 'all' (standaard)
// - scrape:    alleen /scrape + /debug-frequency (meerdere replicas OK, 2s cooldown)
// - warranty:  alleen /activate-warranty (1 replica, 30s cooldown)
// - all:       alle endpoints (backward compatible)
// =========================================
const WORKER_MODE = (process.env.WORKER_MODE || 'all').toLowerCase();

// =========================================
// QUEUE: max 1 browser tegelijk per replica
// Chromium is te zwaar om meerdere browsers tegelijk te draaien
// =========================================
const queue = [];
let isProcessing = false;

const COOLDOWN_SCRAPE_MS = 2000;    // 2s pauze tussen scrape jobs
const COOLDOWN_WARRANTY_MS = 30000; // 30s pauze tussen warranty jobs (CEM backend beschermen)

function enqueue(job, type = 'scrape') {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject, type });
    console.log(`[Queue] ${type} job toegevoegd, ${queue.length} in wachtrij`);
    processQueue();
  });
}

async function processQueue() {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  const { job, resolve, reject, type } = queue.shift();
  console.log(`[Queue] Start ${type} job, nog ${queue.length} in wachtrij`);

  try {
    const result = await job();
    resolve(result);
  } catch (error) {
    reject(error);
  } finally {
    isProcessing = false;
    // Verwerk volgende job met cooldown per type
    if (queue.length > 0) {
      const cooldown = type === 'warranty' ? COOLDOWN_WARRANTY_MS : COOLDOWN_SCRAPE_MS;
      console.log(`[Queue] Wacht ${cooldown / 1000}s cooldown (${type}) voor volgende job...`);
      setTimeout(() => {
        console.log(`[Queue] Cooldown voorbij, volgende job starten...`);
        processQueue();
      }, cooldown);
    }
  }
}

// Health check (altijd beschikbaar)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    worker_mode: WORKER_MODE,
    timestamp: new Date().toISOString(),
    queue_length: queue.length,
    is_processing: isProcessing
  });
});

// =========================================
// SCRAPE ENDPOINTS (mode: 'scrape' of 'all')
// =========================================
if (WORKER_MODE === 'scrape' || WORKER_MODE === 'all') {

/**
 * GET /debug-frequency?kenteken=5SPR48
 *
 * Synchronous endpoint for debugging frequency extraction.
 * Returns the result + debug_log directly (no callback).
 */
app.get('/debug-frequency', async (req, res) => {
  const kenteken = req.query.kenteken;
  if (!kenteken) {
    return res.status(400).json({ error: 'kenteken query parameter is verplicht' });
  }

  console.log(`[Debug] Start debug-frequency voor kenteken: ${kenteken}`);

  try {
    const result = await enqueue(async () => {
      return await scrapeFrequencyOnly(kenteken);
    });
    console.log(`[Debug] Resultaat: ${JSON.stringify(result).substring(0, 500)}`);
    res.json(result);
  } catch (error) {
    console.error(`[Debug] Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /scrape
 *
 * Wordt aangeroepen door de Supabase Edge Function (start-lookup).
 * Start de scrape asynchroon en stuurt resultaten terug via callback.
 *
 * Body (kenteken lookup — volledig):
 * {
 *   "lookup_id": "uuid",
 *   "kenteken": "KR342F",
 *   "km_stand": 34000,
 *   "servicebox_username": "DF21261",
 *   "servicebox_password": "...",
 *   "callback_url": "https://xxx.supabase.co/functions/v1/worker-callback",
 *   "callback_secret": "secret"
 * }
 *
 * Body (VIN lookup — alleen intervallen + prijzen):
 * {
 *   "lookup_id": "uuid",
 *   "vin": "W0L000000Y2000001",
 *   "km_stand": 34000,
 *   "servicebox_username": "DF21261",
 *   "servicebox_password": "...",
 *   "callback_url": "...",
 *   "callback_secret": "secret"
 * }
 */
app.post('/scrape', async (req, res) => {
  const { lookup_id, kenteken, vin, km_stand, callback_url, callback_secret, only_frequency, servicebox_username, servicebox_password } = req.body;
  const credentials = { username: servicebox_username, password: servicebox_password };

  if (!lookup_id || (!kenteken && !vin)) {
    return res.status(400).json({ error: 'lookup_id en kenteken of vin zijn verplicht' });
  }

  if (!servicebox_username || !servicebox_password) {
    return res.status(400).json({ error: 'servicebox_username en servicebox_password zijn verplicht' });
  }

  const searchType = kenteken ? 'kenteken' : 'vin';
  const searchValue = kenteken || vin;
  const mode = only_frequency ? 'FREQUENCY_ONLY' : 'FULL';

  console.log(`\n========================================`);
  console.log(`[Server] Nieuwe scrape request ontvangen`);
  console.log(`[Server] Lookup ID: ${lookup_id}`);
  console.log(`[Server] Mode: ${mode}`);
  console.log(`[Server] Type: ${searchType.toUpperCase()}`);
  console.log(`[Server] ${searchType}: ${searchValue}`);
  console.log(`[Server] KM-stand: ${km_stand || 'n.v.t.'}`);
  console.log(`[Server] Wachtrij: ${queue.length} jobs wachtend, verwerking: ${isProcessing}`);
  console.log(`========================================\n`);

  // Stuur meteen 200 terug — scraping wordt in de queue gezet
  res.json({ status: 'accepted', lookup_id, type: searchType, mode, queue_position: queue.length });

  // Voeg toe aan queue (max 1 browser tegelijk)
  try {
    const result = await enqueue(async () => {
      if (only_frequency && kenteken) {
        return await scrapeFrequencyOnly(kenteken, credentials);
      }
      return kenteken
        ? await scrapeServicebox(kenteken, km_stand, credentials)
        : await scrapeQuotelink(vin, km_stand, credentials);
    });

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

} // einde scrape endpoints

// =========================================
// WARRANTY ENDPOINTS (mode: 'warranty' of 'all')
// =========================================
if (WORKER_MODE === 'warranty' || WORKER_MODE === 'all') {

/**
 * POST /activate-warranty
 *
 * Activeert 2+6 jaar speciale garantie voor een voertuig.
 *
 * Body:
 * {
 *   "lookup_id": "uuid",
 *   "vin": "VXKUPHPY9S4259523",
 *   "km_stand": 45000,
 *   "customer_email": "klant@example.com",
 *   "servicebox_username": "DF21261",
 *   "servicebox_password": "...",
 *   "callback_url": "https://xxx.supabase.co/functions/v1/worker-callback",
 *   "callback_secret": "secret"
 * }
 */
app.post('/activate-warranty', async (req, res) => {
  const { lookup_id, vin, km_stand, customer_email, callback_url, callback_secret, servicebox_username, servicebox_password } = req.body;
  const credentials = { username: servicebox_username, password: servicebox_password };

  if (!lookup_id || !vin) {
    return res.status(400).json({ error: 'lookup_id en vin zijn verplicht' });
  }

  if (!km_stand) {
    return res.status(400).json({ error: 'km_stand is verplicht' });
  }

  if (!customer_email) {
    return res.status(400).json({ error: 'customer_email is verplicht' });
  }

  if (!servicebox_username || !servicebox_password) {
    return res.status(400).json({ error: 'servicebox_username en servicebox_password zijn verplicht' });
  }

  console.log(`\n========================================`);
  console.log(`[Server] Warranty activatie request ontvangen`);
  console.log(`[Server] Lookup ID: ${lookup_id}`);
  console.log(`[Server] VIN: ${vin}`);
  console.log(`[Server] KM-stand: ${km_stand}`);
  console.log(`[Server] Email: ***`);
  console.log(`[Server] Wachtrij: ${queue.length} jobs wachtend, verwerking: ${isProcessing}`);
  console.log(`========================================\n`);

  // Stuur meteen 200 terug — activatie wordt in de queue gezet
  res.json({ status: 'accepted', lookup_id, type: 'warranty', queue_position: queue.length });

  // Voeg toe aan queue (max 1 browser tegelijk)
  try {
    const result = await enqueue(async () => {
      return await activateWarranty(vin, km_stand, customer_email, credentials);
    }, 'warranty');

    console.log(`[Server] Warranty activatie voltooid: ${result.status}`);

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
          status: result.status || 'error',
          data: result
        })
      });

      if (!callbackResponse.ok) {
        const errorText = await callbackResponse.text();
        console.error(`[Server] Callback failed: ${callbackResponse.status} - ${errorText}`);
      } else {
        console.log('[Server] Warranty callback succesvol verstuurd!');
      }
    } else {
      console.log('[Server] Geen callback_url, resultaat alleen gelogd');
      console.log(JSON.stringify(result, null, 2));
    }

  } catch (error) {
    console.error(`[Server] Warranty error: ${error.message}`);

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

} // einde warranty endpoints

// =========================================
// START SERVER
// =========================================
app.listen(PORT, () => {
  console.log(`\n🚗 Servicebox Worker draait op http://localhost:${PORT}`);
  console.log(`   WORKER_MODE: ${WORKER_MODE}`);
  if (WORKER_MODE === 'scrape' || WORKER_MODE === 'all') {
    console.log(`   POST /scrape             — Start een lookup (kenteken of VIN)`);
    console.log(`   GET  /debug-frequency    — Debug frequency extraction`);
  }
  if (WORKER_MODE === 'warranty' || WORKER_MODE === 'all') {
    console.log(`   POST /activate-warranty   — Activeer 2+6 garantie`);
  }
  console.log(`   GET  /health             — Health check`);
  console.log(`   Max 1 gelijktijdige browser per replica (queue-systeem)\n`);
});
