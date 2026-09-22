const { chromium } = require('playwright');
const pdfParse = require('pdf-parse');

/**
 * Servicebox Scraper — v2 (gebaseerd op echte HTML structuur)
 *
 * Pagina-structuur (na kenteken zoeken):
 *   - Tabel header: Kenteken | VIN | Merk | Model | Nr. After Sales/Onderdelen | OPB-code
 *   - Detail rijen: AFLDAT, EINDDAT, DFA, dealers
 *   - Tabs: Auto | Garantiehistorie | Terugroepacties (N)
 *   - Recalls tabel: Code | Omschrijving | Type | Status | Startdatum | Items van terugroepacties
 *   - Bottom links: ESA | Menu pricing | New EPC | TIS2 WEB
 */

const SERVICEBOX_URL = process.env.SERVICEBOX_URL || 'https://servicebox.mpsa.com';

/**
 * Vertaal Playwright / technische fouten naar korte NL-meldingen.
 * De ruwe fout blijft in de console.log; alleen de schone melding gaat naar de klant.
 */
function sanitizeErrorMessage(rawMessage) {
  const msg = rawMessage || 'Onbekende fout';

  // Bewaar al schone eigen meldingen (beginnen niet met page.evaluate/frame/Timeout/etc.)
  if (/^(Login|Zoek|Kon geen|Indienen|Formulier|Onderhoudsschema|Garantie)/i.test(msg)) {
    return msg;
  }

  // Playwright-specifieke patronen → NL melding
  if (/page\.evaluate|frame\.evaluate|execution context/i.test(msg)) {
    return 'Pagina wisselde tijdens uitlezen — nieuwe poging aanbevolen';
  }
  if (/timeout|Timeout/i.test(msg)) {
    return 'Pagina reageerde niet op tijd — nieuwe poging aanbevolen';
  }
  if (/navigation|navigating/i.test(msg)) {
    return 'Pagina navigatie onderbroken — nieuwe poging aanbevolen';
  }
  if (/detached|disposed/i.test(msg)) {
    return 'Pagina-element verdwenen tijdens uitlezen — nieuwe poging aanbevolen';
  }
  if (/net::|ERR_/i.test(msg)) {
    return 'Netwerkfout bij laden van Servicebox — nieuwe poging aanbevolen';
  }
  if (/browser.*closed|target.*closed/i.test(msg)) {
    return 'Browser sessie onverwacht gesloten — nieuwe poging aanbevolen';
  }
  if (/protocol error/i.test(msg)) {
    return 'Communicatiefout met browser — nieuwe poging aanbevolen';
  }

  // Fallback: kort de melding in (max 120 chars, geen stacktrace)
  const firstLine = msg.split('\n')[0].substring(0, 120);
  return firstLine;
}

async function scrapeServicebox(kenteken, kmStand, credentials = {}) {
  const headless = process.env.HEADLESS !== 'false';
  const slowMo = parseInt(process.env.SLOW_MO || '0');
  const USERNAME = credentials.username;
  const PASSWORD = credentials.password;

  if (!USERNAME || !PASSWORD) {
    throw new Error('Servicebox credentials zijn verplicht. Stel deze in via Instellingen.');
  }

  console.log(`[Scraper] Start scrape voor kenteken: ${kenteken}, km: ${kmStand || 'n.v.t.'}`);
  console.log(`[Scraper] Headless: ${headless}, SlowMo: ${slowMo}`);
  console.log(`[Scraper] Credentials: ${USERNAME}`);

  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    httpCredentials: {
      username: USERNAME,
      password: PASSWORD
    }
  });

  // Luister naar nieuwe pagina's (popup vensters van bijv. Menu Pricing)
  let popupPage = null;
  context.on('page', (newPage) => {
    console.log(`[Scraper] Nieuw venster geopend: ${newPage.url()}`);
    popupPage = newPage;
  });

  const page = await context.newPage();

  try {
    // STAP 1: Login
    await login(page, USERNAME, PASSWORD);

    // STAP 2: Zoek voertuig op kenteken
    const vehicleData = await searchAndExtractVehicle(page, kenteken);

    // STAP 3: Extract recalls (klik op Terugroepacties tab)
    const recalls = await extractRecalls(page);

    // STAP 4: Ga terug naar Auto tab, klik Menu pricing → extract onderhoud
    const vin = vehicleData?.vin || kenteken;
    const { intervals, interval_pricing, prices, service_frequency } = await extractMaintenance(page, context, kmStand, vin);

    console.log('[Scraper] Scrape voltooid!');
    return {
      vehicle: vehicleData, recalls, intervals, interval_pricing, prices,
      service_frequency,
      // Top-level convenience velden voor directe mapping in Supabase
      service_frequency_km: service_frequency?.km || null,
      service_frequency_months: service_frequency?.months || null,
      service_frequency_source: service_frequency?.source || null
    };

  } catch (error) {
    console.error('[Scraper] Error:', error.message);
    console.error('[Scraper] Stack:', error.stack?.substring(0, 500));
    try {
      await page.screenshot({ path: `error-${Date.now()}.png` });
      console.log('[Scraper] Error screenshot opgeslagen');
    } catch (e) { /* ignore */ }
    // Geef gebruiksvriendelijke NL-melding, niet de ruwe Playwright stacktrace
    throw new Error(sanitizeErrorMessage(error.message));
  } finally {
    await browser.close();
  }
}

// =========================================
// LOGIN (HTTP credentials + SSO fallback)
// =========================================
async function login(page, USERNAME, PASSWORD) {
  console.log('[Login] Navigeren naar Servicebox...');
  // Probeer eerst met networkidle, fallback naar domcontentloaded
  try {
    await page.goto(SERVICEBOX_URL, { waitUntil: 'networkidle', timeout: 45000 });
  } catch (e) {
    console.log(`[Login] Eerste poging timeout, retry met domcontentloaded...`);
    await page.goto(SERVICEBOX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
  }
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  console.log(`[Login] Huidige URL: ${currentUrl}`);

  // Check of we ingelogd zijn (frameset = Servicebox is geladen)
  if (currentUrl.includes('loadPage.jsp') || currentUrl.includes('referer.jsp')) {
    console.log('[Login] Al ingelogd (HTTP credentials werkten)');
    // We navigeren straks direct naar de juiste pagina's — frameset niet nodig
    await page.waitForTimeout(2000);
    return;
  }

  // SSO login formulier
  console.log('[Login] SSO login pagina, inloggen...');

  // Username
  const usernameField = await page.$('input[type="text"], input[name*="user" i], input[name*="login" i], input[name="j_username"]');
  if (!usernameField) {
    await page.screenshot({ path: 'login-debug.png' });
    throw new Error('Login formulier niet gevonden');
  }
  try {
    await usernameField.fill(USERNAME);
  } catch (e) {
    throw new Error(`Login mislukt: kon gebruikersnaam niet invullen (veld disabled of niet zichtbaar)`);
  }

  // Password
  const passwordField = await page.$('input[type="password"]');
  try {
    if (passwordField) {
      await passwordField.fill(PASSWORD);
    } else {
      // Multi-step: submit username, dan password
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
      const pwField = await page.$('input[type="password"]');
      if (pwField) await pwField.fill(PASSWORD);
    }
  } catch (e) {
    throw new Error(`Login mislukt: kon wachtwoord niet invullen (veld disabled of niet zichtbaar)`);
  }

  // Submit
  const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForURL(/servicebox\.mpsa\.com/, { timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log(`[Login] Ingelogd! URL: ${page.url()}`);
}

// =========================================
// ZOEK VOERTUIG & EXTRACT DATA
// =========================================
async function searchAndExtractVehicle(page, kenteken) {
  const cleanKenteken = kenteken.replace(/-/g, '');
  console.log(`[Vehicle] Zoeken naar kenteken: ${cleanKenteken}`);

  // === DIRECT NAVIGATION: bypass frameset entirely ===
  // Navigate to the hub page directly (where the search input lives)
  console.log('[Vehicle] Direct navigeren naar loadFrameHub (bypass frameset)...');
  await page.goto(`${SERVICEBOX_URL}/do/loadFrameHub`, {
    waitUntil: 'networkidle',
    timeout: 30000
  });
  await page.waitForTimeout(2000);

  let searchInput = await page.$('input#short-vin, input[name="shortvin"]');

  // Fallback: try the socle page if hub doesn't have the search field
  if (!searchInput) {
    console.log('[Vehicle] Zoekveld niet op hub, probeer socle...');
    await page.goto(`${SERVICEBOX_URL}/socle/?start=true`, {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    await page.waitForTimeout(2000);
    searchInput = await page.$('input#short-vin, input[name="shortvin"]');
  }

  if (!searchInput) {
    await page.screenshot({ path: 'search-field-debug.png' });
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').substring(0, 300));
    console.log(`[Vehicle] Pagina-inhoud: ${bodyText}`);
    throw new Error('Zoekveld (input#short-vin) niet gevonden');
  }

  console.log(`[Vehicle] Zoekveld gevonden op: ${page.url()}`);

  // Fill in kenteken and submit
  // Change form target to _self so results load in THIS page (not frameHub)
  console.log('[Vehicle] Kenteken invullen en submitten...');

  const [navigation] = await Promise.all([
    page.waitForNavigation({ timeout: 20000 }).catch(() => null),
    page.evaluate((kent) => {
      const input = document.querySelector('input#short-vin, input[name="shortvin"]');
      if (!input) throw new Error('Zoekveld niet gevonden');

      // Force form to load results in same page
      const form = input.closest('form');
      if (form) {
        form.removeAttribute('target');
        form.target = '_self';
      }

      input.value = kent;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const okBtn = document.querySelector('input[name="VIN_OK_BUTTON"]');
      if (okBtn) {
        okBtn.click();
      } else if (form) {
        form.submit();
      }
    }, cleanKenteken)
  ]);

  console.log(`[Vehicle] Na submit URL: ${page.url()}`);
  console.log(`[Vehicle] Frames: ${page.frames().map(f => f.url()).join(', ')}`);
  await page.waitForTimeout(5000);

  // Extract vehicle data — 4 attempts
  let vehicleData = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`[Vehicle] Poging ${attempt}/4 om voertuigdata te extraheren (zoek: "${cleanKenteken}")...`);
    vehicleData = await extractVehicleData(page, cleanKenteken);
    if (vehicleData) break;

    console.log(`[Vehicle] Nog geen data, wacht 5s...`);
    await page.waitForTimeout(5000);
  }

  if (!vehicleData) {
    console.log('[Vehicle] === MISLUKT — pagina-inhoud: ===');
    const text = await page.evaluate(() => (document.body?.innerText || '').substring(0, 500));
    console.log(text.substring(0, 300));
    await page.screenshot({ path: `vehicle-data-debug.png` });
    throw new Error('Kon geen voertuiggegevens extraheren');
  }

  return vehicleData;
}

async function extractVehicleData(page, kenteken) {
  console.log('[Vehicle] Extracting voertuiggegevens...');

  const frames = page.frames();
  let data = null;

  for (const frame of frames) {
    try {
      data = await frame.evaluate((searchKenteken) => {
        const result = {};
        const bodyText = document.body?.innerText || '';

        // Helper: clean whitespace
        function clean(text) {
          return (text || '').replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }

        // Check of dit frame de voertuigdata bevat
        if (!bodyText.includes('Kenteken') && !bodyText.includes('VIN')) return null;
        // Normaliseer: verwijder streepjes/spaties voor vergelijking (JSN-02-D → JSN02D)
        const normalizedBody = bodyText.replace(/[-\s]/g, '');
        if (!normalizedBody.includes(searchKenteken)) return null;

        // === METHODE 1: Zoek de hoofdtabel (class="data large center") ===
        const allThs = Array.from(document.querySelectorAll('th'));
        for (const th of allThs) {
          if (clean(th.textContent) === 'Kenteken' || clean(th.textContent) === 'Immatriculation') {
            const headerRow = th.closest('tr');
            if (!headerRow) continue;

            const headers = Array.from(headerRow.querySelectorAll('th')).map(h => clean(h.textContent));
            const dataRow = headerRow.nextElementSibling;
            if (!dataRow) continue;

            const values = Array.from(dataRow.querySelectorAll('td')).map(d => clean(d.textContent));

            for (let j = 0; j < headers.length && j < values.length; j++) {
              const h = headers[j].toLowerCase();
              const v = values[j];
              if (!v) continue;
              if (h === 'kenteken' || h === 'immatriculation') result.kenteken = v;
              else if (h === 'vin') result.vin = v;
              else if (h === 'merk' || h === 'marque') result.merk = v;
              else if (h === 'model' || h === 'modèle') result.model = v;
              else if (h.includes('after sales') || h.includes('onderdelen')) result.after_sales_nr = v;
              else if (h.includes('opb')) result.opb_code = v;
            }
            break;
          }
        }

        // === METHODE 2: Extract detail-velden (AFLDAT, EINDDAT, DFA, dealers) ===
        const allTds = Array.from(document.querySelectorAll('td'));
        for (const td of allTds) {
          const text = clean(td.textContent);

          if (text === 'AFLDAT :') {
            const nextTd = td.nextElementSibling;
            if (nextTd) result.afleverdatum = clean(nextTd.textContent);
          }
          if (text.startsWith('EINDDAT')) {
            const nextTd = td.nextElementSibling;
            if (nextTd) result.garantie_einde = clean(nextTd.textContent);
          }
          if (text.includes('DFA') || text.includes('doorroesten')) {
            const nextTd = td.nextElementSibling;
            if (nextTd) result.garantie_dfa = clean(nextTd.textContent);
          }
          if (text === 'Verkopende dealer :') {
            const nextTd = td.nextElementSibling;
            if (nextTd) result.dealer_code = clean(nextTd.textContent);
          }
        }

        if (Object.keys(result).length > 2) return result;
        return null;
      }, kenteken);

      if (data) {
        console.log(`[Vehicle] Data gevonden:`, JSON.stringify(data));
        break;
      }
    } catch (e) { continue; }
  }

  if (!data) {
    console.log('[Vehicle] Geen data gevonden in deze poging');
    return null;
  }

  // Zorg dat kenteken altijd aanwezig is
  if (!data.kenteken) data.kenteken = kenteken;
  return data;
}

// =========================================
// RECALLS / TERUGROEPACTIES
// =========================================
async function extractRecalls(page) {
  console.log('[Recalls] Klikken op Terugroepacties tab...');

  const frames = page.frames();

  // Klik op het "Terugroepacties" tab-label
  for (const frame of frames) {
    try {
      // Zoek specifiek de tab-link (niet "Beheer terugroepacties" in het menu)
      const elements = await frame.$$('a, span, td');
      for (const el of elements) {
        const text = (await el.textContent()).trim();
        // Match "Terugroepacties (0)" of "Terugroepacties (1)" etc.
        if (/^Terugroepacties\s*\(\d+\)$/i.test(text)) {
          console.log(`[Recalls] Klik op tab: "${text}"`);
          await el.click();
          await page.waitForTimeout(3000);
          break;
        }
      }
    } catch (e) { continue; }
  }

  // Extract recall-tabel
  // Headers: Code | Omschrijving | Type | Status | Startdatum | Items van terugroepacties
  const recalls = [];

  for (const frame of page.frames()) {
    try {
      const frameRecalls = await frame.evaluate(() => {
        const results = [];

        // Helper: clean whitespace
        function clean(text) {
          return (text || '').replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }

        // Vind de header "Code" in TH-cellen van de recalls tabel
        const allThs = Array.from(document.querySelectorAll('th'));
        let headerRow = null;
        for (const th of allThs) {
          if (clean(th.textContent) === 'Code') {
            const row = th.closest('tr');
            if (row && row.textContent.includes('Omschrijving')) {
              headerRow = row;
              break;
            }
          }
        }

        if (!headerRow) return results;

        // Loop door alle volgende rijen
        let currentRow = headerRow.nextElementSibling;
        while (currentRow) {
          const cells = Array.from(currentRow.querySelectorAll('td'));
          if (cells.length >= 5) {
            const code = clean(cells[0]?.textContent);
            const omschrijving = clean(cells[1]?.textContent);
            const type = clean(cells[2]?.textContent);
            // Status is cel 3 — bevat mogelijk afbeeldingen/icons
            const statusCell = cells[3];
            const statusImages = statusCell?.querySelectorAll('img') || [];
            let status = 'open'; // default
            for (const img of statusImages) {
              const src = img.getAttribute('src') || '';
              const alt = img.getAttribute('alt') || '';
              if (src.includes('green') || alt.toLowerCase().includes('ok') || alt.toLowerCase().includes('closed')) {
                status = 'resolved';
              }
            }
            const startdatum = clean(cells[4]?.textContent);
            const items = clean(cells[5]?.textContent);

            // Filter lege/ongeldige rijen
            if (code && code.length <= 10 && omschrijving) {
              results.push({
                code,
                description: omschrijving,
                type,
                status,
                start_date: startdatum,
                items
              });
            }
          }
          currentRow = currentRow.nextElementSibling;
        }

        return results;
      });

      if (frameRecalls.length > 0) {
        recalls.push(...frameRecalls);
        console.log(`[Recalls] ${frameRecalls.length} recall(s) gevonden`);
        break;
      }
    } catch (e) { continue; }
  }

  if (recalls.length === 0) {
    console.log('[Recalls] Geen recalls gevonden (of allemaal afgehandeld)');
  }

  return recalls;
}

// =========================================
// MENU PRICING / ONDERHOUD
// =========================================
async function extractMaintenance(page, context, kmStand, vin) {
  console.log('[Maintenance] Start onderhoud extractie...');

  // ── PRIMAIRE METHODE: Documentatie route (PDF met exact schema) ──
  let serviceFrequencyFromDoc = null;
  if (vin) {
    serviceFrequencyFromDoc = await extractFrequencyFromDocumentation(page, context, vin);
    if (serviceFrequencyFromDoc) {
      console.log(`[Maintenance] Frequentie via Documentatie: ${serviceFrequencyFromDoc.km} km / ${serviceFrequencyFromDoc.months} maanden`);
      console.log('[Maintenance] PDF gevonden — skip Menu Pricing (niet nodig)');
      return { intervals: [], interval_pricing: [], prices: [], service_frequency: serviceFrequencyFromDoc };
    } else {
      console.log('[Maintenance] Documentatie route leverde geen frequentie op, probeer Menu Pricing...');
    }
  }

  console.log('[Maintenance] Zoeken naar Menu pricing link...');

  // Eerst terug naar Auto tab
  for (const frame of page.frames()) {
    try {
      const autoTab = await frame.$('a:has-text("Auto"), span:has-text("Auto")');
      if (autoTab) {
        const text = (await autoTab.textContent()).trim();
        if (text === 'Auto') {
          await autoTab.click();
          await page.waitForTimeout(2000);
          break;
        }
      }
    } catch (e) { continue; }
  }

  // Log alle huidige pages vóór de klik
  const pagesBefore = context.pages().map(p => p.url());
  console.log(`[Maintenance] Pages voor klik: ${pagesBefore.join(', ')}`);

  // Roep goTo('/mp/') aan, of open Menu pricing URL direct als fallback
  let executed = false;

  // Methode 1: goTo() functie beschikbaar in pagina of frames
  for (const frame of page.frames()) {
    try {
      const hasGoTo = await frame.evaluate(() => typeof goTo === 'function');
      if (hasGoTo) {
        console.log(`[Maintenance] goTo('/mp/') uitvoeren in frame: ${frame.url()}`);
        await frame.evaluate(() => goTo('/mp/'));
        executed = true;
        break;
      }
    } catch (e) {
      console.log(`[Maintenance] Frame error: ${e.message.substring(0, 100)}`);
      continue;
    }
  }

  // Methode 2: Zoek de Menu pricing link en haal URL op
  if (!executed) {
    console.log('[Maintenance] goTo niet beschikbaar, zoeken naar Menu pricing link...');
    const mpUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const link of links) {
        const text = (link.textContent || '').trim();
        if (text.includes('Menu pricing') || text.includes('Quotelink') || text.includes('menu pricing')) {
          const href = link.getAttribute('href') || '';
          if (href && !href.startsWith('javascript:')) return href;
          // Extract URL from onclick handler
          const onclick = link.getAttribute('onclick') || href;
          const goToMatch = onclick.match(/goTo\(['"]([^'"]+)['"]\)/);
          if (goToMatch) return goToMatch[1];
          const openMatch = onclick.match(/window\.open\(['"]([^'"]+)['"]/);
          if (openMatch) return openMatch[1];
        }
      }
      return null;
    });

    if (mpUrl) {
      console.log(`[Maintenance] Menu pricing URL gevonden: ${mpUrl}`);
      const fullUrl = mpUrl.startsWith('http') ? mpUrl : `${SERVICEBOX_URL}${mpUrl}`;
      const mpPage = await context.newPage();
      await mpPage.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      executed = true;
    }
  }

  // Methode 3: Probeer /mp/ direct te openen
  if (!executed) {
    console.log('[Maintenance] Geen link gevonden, probeer /mp/ direct...');
    try {
      const mpPage = await context.newPage();
      await mpPage.goto(`${SERVICEBOX_URL}/mp/`, { waitUntil: 'networkidle', timeout: 15000 });
      executed = true;
    } catch (e) {
      console.log(`[Maintenance] /mp/ direct openen mislukt: ${e.message.substring(0, 100)}`);
      const freq = serviceFrequencyFromDoc || await extractFromESA(page, context);
      return { intervals: [], prices: [], interval_pricing: [], service_frequency: freq };
    }
  }

  // Wacht tot de goTo() functie het popup-venster navigeert
  await page.waitForTimeout(5000);

  // Zoek de menupricing pagina in alle open pages
  // goTo() hergebruikt het bestaande about:blank venster
  const allPages = context.pages();
  console.log(`[Maintenance] Pages na klik: ${allPages.map(p => p.url()).join(', ')}`);

  let menuPricingPage = null;
  for (const p of allPages) {
    const url = p.url();
    if (url.includes('menupricing') || url.includes('quotelink') || url.includes('opel-vauxhall')) {
      menuPricingPage = p;
      break;
    }
  }

  // Als geen specifieke menupricing pagina gevonden, check of about:blank genavigeerd is
  if (!menuPricingPage) {
    for (const p of allPages) {
      if (p !== page && p.url() !== 'about:blank') {
        menuPricingPage = p;
        break;
      }
    }
  }

  if (!menuPricingPage) {
    console.log('[Maintenance] Geen Menu pricing pagina gevonden');
    // Gebruik Documentatie-resultaat, of probeer ESA als fallback
    const freq = serviceFrequencyFromDoc || await extractFromESA(page, context);
    return { intervals: [], prices: [], interval_pricing: [], service_frequency: freq };
  }

  console.log(`[Maintenance] Menu pricing gevonden: ${menuPricingPage.url()}`);
  await menuPricingPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await menuPricingPage.waitForTimeout(3000);

  // Gebruik Documentatie-resultaat als primaire bron; anders probeer Menu Pricing
  let serviceFrequency = serviceFrequencyFromDoc || null;

  if (!serviceFrequency) {
    // ── Probeer frequentie VÓÓR "GA VERDER" te extraheren ──
    // Op sommige systemen (Opel/Vauxhall) staat de frequentie op de Vehicle-pagina
    console.log('[Maintenance] Frequentie zoeken VOOR GA VERDER...');
    serviceFrequency = await extractServiceFrequency(menuPricingPage);
    if (serviceFrequency) {
      console.log('[Maintenance] Frequentie gevonden op Vehicle-pagina (voor GA VERDER)!');
    }
  } else {
    console.log('[Maintenance] Frequentie al via Documentatie gevonden, skip Menu Pricing frequentie');
  }

  // We landen op de Prijsopgave/Vehicle-pagina. Klik "GA VERDER" om naar
  // de interval/prijzen-selectie te gaan.
  console.log('[Maintenance] Klikken op GA VERDER...');
  try {
    await menuPricingPage.click('text=GA VERDER', { timeout: 5000 });
    await menuPricingPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await menuPricingPage.waitForTimeout(3000);
    console.log(`[Maintenance] Volgende pagina: ${menuPricingPage.url()}`);
  } catch (e) {
    console.log(`[Maintenance] GA VERDER niet gevonden, probeer input/button...`);
    try {
      // Fallback: zoek op input value
      await menuPricingPage.click('input[value*="GA VERDER"], input[value*="VERDER"], button:has-text("VERDER")', { timeout: 5000 });
      await menuPricingPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await menuPricingPage.waitForTimeout(3000);
    } catch (e2) {
      console.log(`[Maintenance] GA VERDER klik mislukt: ${e2.message.substring(0, 100)}`);
    }
  }

  // Wacht tot de pagina echt content heeft (niet alleen "Nieuwsbrief")
  // Opel/Vauxhall pages laden async na GA VERDER
  console.log('[Maintenance] Wachten op content laden...');
  for (let waitAttempt = 0; waitAttempt < 5; waitAttempt++) {
    const contentCheck = await menuPricingPage.evaluate(() => {
      const text = (document.body?.innerText || '').trim();
      // Check ook frames
      let frameText = '';
      try {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try { frameText += (iframe.contentDocument?.body?.innerText || ''); } catch(e) {}
        }
      } catch(e) {}
      const allText = text + frameText;
      // Als er km-waarden, frequentie-tekst of intervallen op de pagina staan, is content geladen
      return {
        length: allText.length,
        hasKm: /\d{2,3}[.\s]?000\s*(km|KM)/i.test(allText),
        hasFreq: /[Ee]lk|[Tt]ous|[Ee]very|frequen/i.test(allText),
        preview: allText.substring(0, 200)
      };
    });
    console.log(`[Maintenance] Content check #${waitAttempt + 1}: ${contentCheck.length} chars, hasKm=${contentCheck.hasKm}, hasFreq=${contentCheck.hasFreq}, preview: ${contentCheck.preview.substring(0, 100)}`);
    if (contentCheck.hasKm || contentCheck.hasFreq || contentCheck.length > 500) {
      break;
    }
    // Check ook Playwright frames (cross-origin iframes niet via DOM bereikbaar)
    const frameTexts = [];
    for (const frame of menuPricingPage.frames()) {
      try {
        const ft = await frame.evaluate(() => (document.body?.innerText || '').substring(0, 200));
        if (ft.length > 10) frameTexts.push({ url: frame.url().substring(0, 80), len: ft.length, preview: ft.substring(0, 100) });
      } catch(e) {}
    }
    if (frameTexts.length > 0) {
      console.log(`[Maintenance] Playwright frames met content: ${JSON.stringify(frameTexts)}`);
      const totalFrameLen = frameTexts.reduce((sum, f) => sum + f.len, 0);
      if (totalFrameLen > 500) break;
    }
    await menuPricingPage.waitForTimeout(2000);
  }

  // Screenshot voor debugging
  await menuPricingPage.screenshot({ path: 'menupricing-debug.png' });
  console.log('[Maintenance] Screenshot opgeslagen: menupricing-debug.png');

  // Log pagina-inhoud voor debugging (clean whitespace) — inclusief alle frames
  const pageText = await menuPricingPage.evaluate(() => {
    return (document.body?.innerText || '').replace(/[\t]+/g, ' ').replace(/\n{3,}/g, '\n\n').substring(0, 3000);
  });
  console.log('[Maintenance] Main frame tekst (eerste 1500 chars):', pageText.substring(0, 1500));

  // Log alle Playwright frames
  const allFrames = menuPricingPage.frames();
  console.log(`[Maintenance] Aantal Playwright frames: ${allFrames.length}`);
  for (let i = 0; i < allFrames.length; i++) {
    try {
      const frameUrl = allFrames[i].url();
      const frameText = await allFrames[i].evaluate(() => (document.body?.innerText || '').substring(0, 500));
      console.log(`[Maintenance] Frame ${i}: URL=${frameUrl.substring(0, 100)}, tekst (${frameText.length} chars): ${frameText.substring(0, 200)}`);
    } catch(e) {
      console.log(`[Maintenance] Frame ${i}: niet bereikbaar (${e.message.substring(0, 60)})`);
    }
  }

  // ── Frequentie extraheren NA "GA VERDER" (als niet eerder gevonden) ──
  if (!serviceFrequency) {
    console.log('[Maintenance] Frequentie zoeken NA GA VERDER...');
    serviceFrequency = await extractServiceFrequency(menuPricingPage);
  }

  // Extract intervallen
  const intervals = await extractIntervals(menuPricingPage);

  // Extract prijzen PER INTERVAL (klik elk interval, lees offerte-tabel)
  const interval_pricing = await extractPricesPerInterval(menuPricingPage, intervals);

  // Extract de volledige servicecatalogus (alle beschikbare items)
  const prices = await extractPricesByCategory(menuPricingPage);

  // Sluit popup
  await menuPricingPage.close();

  // Als geen frequentie via Menu pricing, probeer ESA als fallback
  if (!serviceFrequency) {
    console.log('[Maintenance] Geen frequentie via Menu pricing — probeer ESA route...');
    serviceFrequency = await extractFromESA(page, context);
  }

  // Laatste fallback: leid frequentie af uit de intervallenlijst
  // Bijv. intervallen [30000, 60000, 90000, ...] → frequentie = 30000 km
  // "Jaarlijkse onderhoudsbeurt" → 12 maanden
  if (!serviceFrequency && intervals.length > 0) {
    console.log('[Maintenance] Frequentie afleiden uit intervallen...');
    const kmIntervals = intervals
      .filter(i => i.type === 'km')
      .map(i => i.sort * 1000)
      .sort((a, b) => a - b);

    const hasYearly = intervals.some(i => i.type === 'yearly');

    if (kmIntervals.length >= 2) {
      // Bereken kleinste verschil (GCD-achtig) tussen opeenvolgende intervallen
      let minDiff = kmIntervals[1] - kmIntervals[0];
      for (let i = 2; i < kmIntervals.length; i++) {
        const diff = kmIntervals[i] - kmIntervals[i - 1];
        if (diff > 0 && diff < minDiff) minDiff = diff;
      }
      // Controleer of het eerste interval gelijk is aan de stap (30k, 60k, 90k → stap=30k, eerste=30k ✓)
      if (kmIntervals[0] === minDiff) {
        const months = hasYearly ? 12 : null;
        console.log(`[Maintenance] Afgeleid uit intervallen: ${minDiff} km / ${months || '?'} maanden`);
        serviceFrequency = {
          km: minDiff,
          months: months,
          condition: 'normaal',
          km_heavy: null, months_heavy: null,
          source: 'afgeleid_uit_intervallen',
          raw: `Intervallen: ${kmIntervals.join(', ')} km${hasYearly ? ' + Jaarlijks' : ''}`
        };
      }
    } else if (kmIntervals.length === 1) {
      // Slechts 1 km-interval: gebruik dat als frequentie
      const months = hasYearly ? 12 : null;
      console.log(`[Maintenance] Enkel interval: ${kmIntervals[0]} km / ${months || '?'} maanden`);
      serviceFrequency = {
        km: kmIntervals[0],
        months: months,
        condition: 'normaal',
        km_heavy: null, months_heavy: null,
        source: 'afgeleid_uit_intervallen',
        raw: `Enkel interval: ${kmIntervals[0]} km${hasYearly ? ' + Jaarlijks' : ''}`
      };
    }
  }

  return { intervals, interval_pricing, prices, service_frequency: serviceFrequency };
}

// =========================================
// DOCUMENTATIE ROUTE — onderhoudsschema PDF uit Servicebox
// =========================================
/**
 * Navigeert via DOCUMENTATIE → Technische documentatie → Onderhoudsschema's → PDF
 * om de exacte onderhoudsfrequentie uit de "Normale gebruiksomstandigheden" kolom te halen.
 *
 * Stappen:
 * 1. Hover over DOCUMENTATIE tab → klik Technische documentatie
 * 2. VIN invoeren, OK klikken
 * 3. Klik Onderhoudsschema's
 * 4. Selecteer tab "Overzicht onderhoud"
 * 5. Dropdown Gebruiksomstandigheden → Normaal, klik Zoeken
 * 6. PDF opent → download/intercept → parse tabel
 *
 * @param {Page} page - De Servicebox hoofdpagina (ingelogd, voertuig al opgezocht)
 * @param {BrowserContext} context - Browser context voor nieuwe pagina's
 * @param {string} vin - Chassisnummer
 * @returns {Object|null} { km, months, condition, source, raw } of null
 */
async function extractFrequencyFromDocumentation(page, context, vin, debugLog = null) {
  const dbg = (msg) => { console.log(msg); if (debugLog) debugLog.push(msg); };
  dbg('[Documentatie] Start frequentie-extractie via Onderhoudsschema PDF...');

  try {
    // Gebruik de hoofdpagina — documentatie opent in een frame, niet een apart venster
    const docPage = page;

    // ── STAP 1: Navigeer naar Technische documentatie ──
    let techDocClicked = false;
    for (const frame of docPage.frames()) {
      try {
        const docTab = await frame.$('a:has-text("DOCUMENTATIE"), a:has-text("Documentatie")');
        if (docTab) {
          dbg('[Documentatie] DOCUMENTATIE tab gevonden, hover...');
          await docTab.hover();
          await frame.waitForTimeout(1500);

          // Zoek submenu in alle frames (submenu kan in ander frame zitten)
          for (const f2 of docPage.frames()) {
            const techDoc = await f2.$('a:has-text("Technische documentatie")');
            if (techDoc) {
              dbg('[Documentatie] Technische documentatie gevonden, klikken...');
              await techDoc.click();
              techDocClicked = true;
              break;
            }
          }
          if (techDocClicked) break;
        }
      } catch (e) { continue; }
    }

    if (!techDocClicked) {
      dbg('[Documentatie] Kon Technische documentatie niet bereiken');
      // Log alle menu-items voor debug
      for (const frame of docPage.frames()) {
        try {
          const menuItems = await frame.evaluate(() =>
            Array.from(document.querySelectorAll('a')).map(el => el.textContent?.trim()).filter(t => t && t.length > 2).slice(0, 30)
          );
          if (menuItems.length > 0) dbg(`[Documentatie] Menu-items in frame: ${menuItems.join(', ')}`);
        } catch (e) { continue; }
      }
      return null;
    }

    await docPage.waitForTimeout(3000);
    await docPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    dbg('[Documentatie] Technische documentatie geladen');

    // ── STAP 2: VIN invoeren en OK klikken ──
    // Het VIN veld is input#short-vin (type="search") en de OK knop is input[type="image"][name="VIN_OK_BUTTON"]
    let vinEntered = false;
    for (const frame of docPage.frames()) {
      try {
        const vinInput = await frame.$('input#short-vin, input[name="shortvin"]');
        if (vinInput) {
          // Veld leegmaken en VIN invullen
          await vinInput.click();
          await vinInput.fill('');
          await vinInput.fill(vin);
          dbg(`[Documentatie] VIN ingevuld in short-vin: ${vin}`);

          // OK knop is input[type="image"] met name="VIN_OK_BUTTON"
          const okBtn = await frame.$('input[name="VIN_OK_BUTTON"], input[type="image"]');
          if (okBtn) {
            dbg('[Documentatie] VIN_OK_BUTTON gevonden, klikken...');
            await okBtn.click();
            vinEntered = true;
          } else {
            // Fallback: Enter toets
            dbg('[Documentatie] Geen image button, probeer Enter...');
            await vinInput.press('Enter');
            vinEntered = true;
          }

          if (vinEntered) {
            dbg('[Documentatie] VIN verstuurd, wachten op laden...');
            await docPage.waitForTimeout(5000);
            await docPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          }
          break;
        }
      } catch (e) { continue; }
    }

    if (!vinEntered) {
      dbg('[Documentatie] VIN veld niet gevonden');
      return null;
    }

    // ── STAP 3: Klik Onderhoudsschema's ──
    let schemaClicked = false;
    for (const frame of docPage.frames()) {
      try {
        const schemaLink = await frame.$('a:has-text("Onderhoudsschema")');
        if (schemaLink) {
          const linkText = await schemaLink.evaluate(el => el.textContent?.trim()?.substring(0, 50));
          dbg(`[Documentatie] Onderhoudsschema's link gevonden: "${linkText}"`);
          await schemaLink.click();
          schemaClicked = true;
          dbg('[Documentatie] Onderhoudsschema\'s geklikt, wachten...');
          await docPage.waitForTimeout(5000);
          await docPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          break;
        }
      } catch (e) { continue; }
    }

    if (!schemaClicked) {
      dbg('[Documentatie] Onderhoudsschema\'s link niet gevonden');
      // Log beschikbare links
      for (const frame of docPage.frames()) {
        try {
          const links = await frame.evaluate(() =>
            Array.from(document.querySelectorAll('a')).map(el => el.textContent?.trim()).filter(t => t && t.length > 2).slice(0, 20)
          );
          if (links.length > 0) dbg(`[Documentatie] Beschikbare links: ${links.join(', ')}`);
        } catch (e) { continue; }
      }
      return null;
    }

    // ── STAP 4: Selecteer tab "Overzicht onderhoud" ──
    let overzichtClicked = false;
    for (const frame of docPage.frames()) {
      try {
        // De tab kan elk element-type zijn (a, td, div, span, etc.)
        const overzichtTab = await frame.$('a:has-text("Overzicht onderhoud"), td:has-text("Overzicht onderhoud"), div:has-text("Overzicht onderhoud"), span:has-text("Overzicht onderhoud"), *:has-text("Overzicht onderhoud")');
        if (overzichtTab) {
          dbg('[Documentatie] Tab "Overzicht onderhoud" gevonden, klikken...');
          await overzichtTab.click();
          overzichtClicked = true;
          await docPage.waitForTimeout(3000);
          await docPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          break;
        }
      } catch (e) { continue; }
    }
    // Fallback: zoek via JavaScript in alle frames
    if (!overzichtClicked) {
      for (const frame of docPage.frames()) {
        try {
          const clicked = await frame.evaluate(() => {
            const els = document.querySelectorAll('a, td, div, span, li, button');
            for (const el of els) {
              if (el.textContent?.trim() === 'Overzicht onderhoud' || el.innerText?.trim() === 'Overzicht onderhoud') {
                el.click();
                return true;
              }
            }
            return false;
          });
          if (clicked) {
            dbg('[Documentatie] Tab "Overzicht onderhoud" geklikt via JS');
            overzichtClicked = true;
            await docPage.waitForTimeout(3000);
            await docPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            break;
          }
        } catch (e) { continue; }
      }
    }
    if (!overzichtClicked) {
      dbg('[Documentatie] Tab "Overzicht onderhoud" niet gevonden');
    }

    // ── STAP 5: Extract dropdown values → construct synthesePE URL → GET PDF ──
    // De dropdown option values zijn precies de condutil parameters voor synthesePE.do.
    // Dus we hoeven geen form te POSTen — we bouwen de URL rechtstreeks.
    for (const frame of docPage.frames()) {
      try {
        // Zoek dropdown met "Normaal" optie
        const selects = await frame.$$('select');
        let condutil = null;
        let condutilsevere = null;

        for (const select of selects) {
          const options = await select.evaluate(el =>
            Array.from(el.options).map(o => ({ value: o.value, text: o.textContent?.trim() }))
          );
          dbg(`[Documentatie] Dropdown opties: ${JSON.stringify(options)}`);

          for (const opt of options) {
            if (/normaa?l/i.test(opt.text) && opt.value) {
              condutil = opt.value;
              dbg(`[Documentatie] condutil (Normaal): ${condutil}`);
            }
            if (/zwa[ar]|sévère|severe/i.test(opt.text) && opt.value) {
              condutilsevere = opt.value;
              dbg(`[Documentatie] condutilsevere (Zwaar): ${condutilsevere}`);
            }
          }
          if (condutil) break;
        }

        if (!condutil) {
          dbg('[Documentatie] Geen condutil waarde gevonden in dropdown');
          continue;
        }

        // Bouw synthesePE URL
        const baseUrl = 'https://servicebox.mpsa.com/docapvpr/synthesePE.do';
        const params = new URLSearchParams();
        params.set('condutil', condutil);
        if (condutilsevere) params.set('condutilsevere', condutilsevere);
        const syntheseUrl = `${baseUrl}?${params.toString()}`;
        dbg(`[Documentatie] Directe synthesePE URL: ${syntheseUrl}`);

        // GET de PDF
        let pdfBuffer = null;
        try {
          const resp = await context.request.get(syntheseUrl, { timeout: 60000 });
          const ct = resp.headers()['content-type'] || '';
          const body = await resp.body();
          const status = resp.status();
          dbg(`[Documentatie] synthesePE response: status=${status}, type=${ct}, size=${body.length}`);

          if (ct.includes('pdf') && body.length > 500) {
            pdfBuffer = body;
            dbg(`[Documentatie] PDF ontvangen: ${pdfBuffer.length} bytes`);
          } else {
            // Log wat we wel kregen
            const preview = body.toString('utf-8').substring(0, 500);
            dbg(`[Documentatie] Geen PDF, response preview: ${preview}`);

            // Fallback: probeer ook zonder condutilsevere
            if (condutilsevere) {
              const fallbackUrl = `${baseUrl}?condutil=${encodeURIComponent(condutil)}`;
              dbg(`[Documentatie] Fallback URL (alleen condutil): ${fallbackUrl}`);
              const resp2 = await context.request.get(fallbackUrl, { timeout: 60000 });
              const ct2 = resp2.headers()['content-type'] || '';
              const body2 = await resp2.body();
              dbg(`[Documentatie] Fallback response: type=${ct2}, size=${body2.length}`);
              if (ct2.includes('pdf') && body2.length > 500) {
                pdfBuffer = body2;
              }
            }
          }
        } catch (e) {
          dbg(`[Documentatie] HTTP GET fout: ${e.message.substring(0, 150)}`);
        }

        // Sluit eventuele popups
        for (const p of context.pages()) {
          if (p !== docPage && (p.url().includes('formSubmitForward') || p.url().includes('synthesePE'))) {
            await p.close().catch(() => {});
          }
        }

        if (!pdfBuffer) {
          dbg('[Documentatie] Geen PDF ontvangen');
          return null;
        }

        // Parse PDF
        try {
          const pdfData = await pdfParse(pdfBuffer);
          dbg(`[Documentatie] PDF geparsed: ${pdfData.numpages} pagina's, ${pdfData.text.length} chars`);
          dbg(`[Documentatie] PDF tekst (eerste 500): ${pdfData.text.substring(0, 500)}`);
          return parsePdfText(pdfData.text);
        } catch (parseErr) {
          dbg(`[Documentatie] PDF parse fout: ${parseErr.message.substring(0, 100)}`);
          return null;
        }
      } catch (e) {
        dbg(`[Documentatie] Frame error: ${e.message.substring(0, 100)}`);
        continue;
      }
    }

    dbg('[Documentatie] Kon geen PDF genereren');
    return null;

  } catch (error) {
    dbg(`[Documentatie] Error: ${error.message.substring(0, 150)}`);
    return null;
  }
}

/**
 * Parse de tekst uit de onderhoudsschema PDF.
 * Zoekt de rij "systematische controles" onder "Normale gebruiksomstandigheden"
 * en extraheert "Elk 25000 Km / 1 jaar" → { km: 25000, months: 12 }
 */
function parsePdfText(text) {
  console.log('[Documentatie] Parsen van PDF tekst...');

  // De PDF tekst heeft typisch deze structuur (kolommen lopen door als tekst):
  // ONDERHOUD  Normale gebruiksomstandigheden  Zware gebruiksomstandigheden
  // SYSTEMATISCHE WERKZAAMHEDEN
  // Onderhoudsbeurten: systematische controles  Elk 25000 Km / 1 jaar  Elk 15000 Km / 1 jaar

  // Strategie 1: Zoek expliciet "systematische controles" gevolgd door "Elk XX Km / Y jaar"
  const systematicPattern = /systemat\w+\s+controles?\s+(Elk[e]?\s+\d[\d.\s]*\s*[Kk][Mm]\s*\/\s*\d+\s*(?:jaar|maand(?:en)?))/i;
  const match1 = text.match(systematicPattern);
  if (match1) {
    console.log(`[Documentatie] Systematische controles match: "${match1[1]}"`);
    const parsed = parseFreqString(match1[1]);
    if (parsed) return { ...parsed, condition: 'normaal', source: 'servicebox_documentatie', raw: match1[1] };
  }

  // Strategie 2: Zoek alle "Elk X Km / Y jaar" patronen — het eerste na "SYSTEMATISCHE" is de juiste
  const sysIdx = text.search(/SYSTEMAT/i);
  if (sysIdx > -1) {
    const afterSys = text.substring(sysIdx);
    const elkPattern = /Elk[e]?\s+(\d[\d.\s]*)\s*[Kk][Mm]\s*\/\s*(\d+)\s*(jaar|jaren|maand(?:en)?)/i;
    const match2 = afterSys.match(elkPattern);
    if (match2) {
      const raw = match2[0];
      console.log(`[Documentatie] Eerste Elk-match na SYSTEMATISCHE: "${raw}"`);
      const parsed = parseFreqString(raw);
      if (parsed) return { ...parsed, condition: 'normaal', source: 'servicebox_documentatie', raw };
    }
  }

  // Strategie 3: Breed zoeken — eerste "Elk X Km / Y jaar" in hele tekst
  const elkBroad = /Elk[e]?\s+(\d[\d.\s]*)\s*[Kk][Mm]\s*\/\s*(\d+)\s*(jaar|jaren|maand(?:en)?)/i;
  const match3 = text.match(elkBroad);
  if (match3) {
    const raw = match3[0];
    console.log(`[Documentatie] Brede Elk-match: "${raw}"`);
    const parsed = parseFreqString(raw);
    if (parsed) return { ...parsed, condition: 'normaal', source: 'servicebox_documentatie', raw };
  }

  console.log('[Documentatie] Geen frequentie gevonden in PDF tekst');
  return null;
}

/**
 * Parse "Elk 25000 Km / 1 jaar" of "Elk 25.000 Km / 1 jaar" → { km: 25000, months: 12 }
 */
function parseFreqString(str) {
  const kmMatch = str.match(/(\d[\d.\s]*)\s*[Kk][Mm]/);
  const periodMatch = str.match(/(\d+)\s*(jaar|jaren|maand|maanden)/i);
  if (!kmMatch || !periodMatch) return null;

  const km = parseInt(kmMatch[1].replace(/[.\s]/g, ''));
  const period = parseInt(periodMatch[1]);
  const unit = periodMatch[2].toLowerCase();
  const months = (unit.startsWith('jaar') || unit.startsWith('jaren')) ? period * 12 : period;

  if (isNaN(km) || isNaN(months) || km < 1000) return null;
  return { km, months, km_heavy: null, months_heavy: null };
}

// =========================================
// ESA FALLBACK — voor voertuigen zonder Menu pricing (bijv. oudere Opels)
// =========================================
/**
 * Open ESA binnen Servicebox, ga naar Details tab → Voorspelling blok.
 * Parse rij "Onderhoudsbeurt (1 Jaren | 30000 km)" → { km: 30000, months: 12 }
 *
 * ESA link staat onderaan de Servicebox voertuigpagina (naast Menu pricing).
 * Navigatie: klik ESA link → ESA opent in popup/frame → Details tab → Voorspelling
 */
async function extractFromESA(page, context) {
  console.log('[ESA] Probeer frequentie via ESA route...');

  try {
    // Zoek en klik ESA link in de Servicebox pagina
    let esaClicked = false;

    // Methode 1: goTo('/esa/') via JS functie
    for (const frame of page.frames()) {
      try {
        const hasGoTo = await frame.evaluate(() => typeof goTo === 'function');
        if (hasGoTo) {
          console.log(`[ESA] goTo('/esa/') uitvoeren in frame: ${frame.url().substring(0, 80)}`);
          await frame.evaluate(() => goTo('/esa/'));
          esaClicked = true;
          break;
        }
      } catch (e) { continue; }
    }

    // Methode 2: Zoek ESA link direct
    if (!esaClicked) {
      for (const frame of page.frames()) {
        try {
          const esaLink = await frame.$('a:has-text("ESA"), a[href*="/esa/"], a[href*="esa"]');
          if (esaLink) {
            const text = (await esaLink.textContent()).trim();
            if (/^ESA$/i.test(text) || text.includes('ESA')) {
              console.log(`[ESA] ESA link gevonden: "${text}"`);
              await esaLink.click();
              esaClicked = true;
              break;
            }
          }
        } catch (e) { continue; }
      }
    }

    if (!esaClicked) {
      console.log('[ESA] Geen ESA link gevonden in Servicebox');
      return null;
    }

    await page.waitForTimeout(5000);

    // Zoek de ESA pagina in alle open pages
    const allPages = context.pages();
    console.log(`[ESA] Pages na ESA klik: ${allPages.map(p => p.url().substring(0, 80)).join(', ')}`);

    let esaPage = null;
    for (const p of allPages) {
      const url = p.url().toLowerCase();
      if (url.includes('esa') && !url.includes('about:blank')) {
        esaPage = p;
        break;
      }
    }

    // Fallback: nieuwste pagina die niet de hoofdpagina is
    if (!esaPage) {
      for (const p of allPages) {
        if (p !== page && p.url() !== 'about:blank') {
          esaPage = p;
        }
      }
    }

    if (!esaPage) {
      console.log('[ESA] Geen ESA pagina gevonden');
      return null;
    }

    console.log(`[ESA] ESA pagina: ${esaPage.url().substring(0, 100)}`);
    await esaPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await esaPage.waitForTimeout(3000);

    // Zoek en klik "Details" tab
    let detailsClicked = false;
    const detailsSelectors = [
      'a:has-text("Details")', 'button:has-text("Details")',
      'span:has-text("Details")', '[role="tab"]:has-text("Details")',
      'li:has-text("Details") a', '.nav-link:has-text("Details")',
      'mat-tab-header :has-text("Details")'
    ];

    // Check ook frames binnen ESA pagina
    const esaFrames = esaPage.frames();
    for (const frame of esaFrames) {
      if (detailsClicked) break;
      for (const sel of detailsSelectors) {
        try {
          const detailsTab = await frame.$(sel);
          if (detailsTab) {
            const txt = (await detailsTab.textContent()).trim();
            console.log(`[ESA] Details tab gevonden: "${txt}"`);
            await detailsTab.click();
            detailsClicked = true;
            await esaPage.waitForTimeout(3000);
            break;
          }
        } catch (e) { continue; }
      }
    }

    if (!detailsClicked) {
      console.log('[ESA] Details tab niet gevonden, probeer direct op pagina...');
    }

    // Zoek "Voorspelling" blok en parse "Onderhoudsbeurt (1 Jaren | 30000 km)"
    const esaFreq = await (async () => {
      for (const frame of esaPage.frames()) {
        try {
          const result = await frame.evaluate(() => {
            const bodyText = document.body?.innerText || '';
            if (bodyText.trim().length < 20) return { error: 'empty' };

            // Zoek "Onderhoudsbeurt (X Jaren | YYYYY km)" patroon
            // Varianten: "Onderhoudsbeurt (1 Jaren | 30000 km)"
            //            "Onderhoudsbeurt (2 Jaren | 40000 km)"
            const patterns = [
              /[Oo]nderhoudsbeurt\s*\(\s*(\d+)\s*[Jj]a(?:ren|ar)\s*\|\s*(\d[\d.\s]*)\s*km\s*\)/gi,
              /[Mm]aintenance\s*\(\s*(\d+)\s*[Yy]ear[s]?\s*\|\s*(\d[\d.\s]*)\s*km\s*\)/gi,
              /[Ee]ntretien\s*\(\s*(\d+)\s*[Aa]n[s]?\s*\|\s*(\d[\d.\s]*)\s*km\s*\)/gi,
            ];

            for (const pattern of patterns) {
              const matches = [...bodyText.matchAll(pattern)];
              if (matches.length > 0) {
                const m = matches[0];
                return { found: true, years: m[1], km: m[2], full: m[0] };
              }
            }

            // Breder: zoek "Voorspelling" sectie en lees km/jaren waarden
            const voorspellingIdx = bodyText.toLowerCase().indexOf('voorspelling');
            if (voorspellingIdx > -1) {
              const section = bodyText.substring(voorspellingIdx, voorspellingIdx + 500);
              return { error: 'no_pattern_in_voorspelling', text: section.substring(0, 300) };
            }

            return { error: 'no_voorspelling', text: bodyText.substring(0, 500) };
          });

          if (result && result.found) return result;
          if (result && result.error && result.error !== 'empty') {
            console.log(`[ESA] ${result.error}: ${(result.text || '').substring(0, 200)}`);
          }
        } catch (e) {
          console.log(`[ESA] Frame error: ${e.message.substring(0, 80)}`);
        }
      }
      return null;
    })();

    // Sluit ESA pagina
    if (esaPage !== page) {
      await esaPage.close().catch(() => {});
    }

    if (esaFreq && esaFreq.found) {
      const km = parseInt(esaFreq.km.replace(/[.\s]/g, ''));
      const years = parseInt(esaFreq.years);
      const months = years * 12;
      console.log(`[ESA] Frequentie gevonden: ${km} km / ${months} maanden (uit "${esaFreq.full}")`);
      return {
        km, months, condition: 'normaal',
        km_heavy: null, months_heavy: null,
        source: 'esa_voorspelling',
        raw: esaFreq.full
      };
    }

    console.log('[ESA] Geen frequentie gevonden via ESA');
    return null;

  } catch (e) {
    console.log(`[ESA] Error: ${e.message.substring(0, 150)}`);
    return null;
  }
}

// =========================================
// SERVICE FREQUENTIE (km + maanden)
// =========================================
/**
 * Extraheert de onderhoudsfrequentie uit de Quotelink/Menu pricing tabel.
 *
 * Tabelstructuur:
 *   ONDERHOUD | Normale gebruiksomstandigheden | Zware gebruiksomstandigheden
 *   ...       | Elk 25000 Km / 1 jaar          | Elk 15000 Km / 1 jaar
 *
 * Strategie:
 * 1. Zoek de tabel met header "Normale gebruiksomstandigheden" (kolomindex dynamisch)
 * 2. Zoek de rij met "systematische" onderhoud
 * 3. Lees de cel op kruispunt kolom normaal + rij systematisch
 * 4. Fallback: regex op hele pagina als geen tabel gevonden
 *
 * Returns: { km: 25000, months: 12, condition: "normaal", source: "servicebox_schema",
 *            km_heavy: 15000, months_heavy: 12, raw: "..." }
 */
async function extractServiceFrequency(page) {
  console.log('[Frequency] Extracting service frequentie...');

  const allFrames = page.frames();
  const framesToCheck = allFrames.length > 0 ? allFrames : [page.mainFrame()];
  console.log(`[Frequency] ${framesToCheck.length} frames te checken`);

  // Helper: parse "Elk 25.000 Km / 1 jaar" → { km: 25000, months: 12 }
  function parseFreqValue(text) {
    if (!text) return null;
    const kmMatch = text.match(/(\d[\d.\s]*)\s*km/i);
    const periodMatch = text.match(/(\d+)\s*(jaar|jaren|maand|maanden|an[s]?|year[s]?|moi[s]?|month[s]?)/i);
    if (!kmMatch || !periodMatch) return null;
    const km = parseInt(kmMatch[1].replace(/[.\s]/g, ''));
    const period = parseInt(periodMatch[1]);
    const unit = periodMatch[2].toLowerCase();
    const months = (unit.startsWith('jaar') || unit.startsWith('jaren') || unit.startsWith('year') || unit.startsWith('an')) ? period * 12 : period;
    if (isNaN(km) || isNaN(months) || km < 1000) return null;
    return { km, months };
  }

  for (let fi = 0; fi < framesToCheck.length; fi++) {
    const frame = framesToCheck[fi];
    try {
      const frameUrl = frame.url();
      const freq = await frame.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        if (bodyText.trim().length < 20) {
          return { error: 'empty_frame', text: bodyText.trim() };
        }

        // ── METHODE 1: Tabel met kolom "Normale gebruiksomstandigheden" ──
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
          const headerRow = table.querySelector('tr, thead tr');
          if (!headerRow) continue;
          const headerCells = headerRow.querySelectorAll('th, td');
          let normaalIdx = -1;
          let zwaarIdx = -1;

          for (let i = 0; i < headerCells.length; i++) {
            const ht = (headerCells[i].textContent || '').trim().toLowerCase();
            if (/normale/i.test(ht)) normaalIdx = i;
            if (/zware/i.test(ht)) zwaarIdx = i;
          }

          if (normaalIdx === -1) continue; // niet de juiste tabel

          // Zoek rij met "systematische" onderhoud
          const rows = table.querySelectorAll('tr');
          let systematicRow = null;
          const rowDebug = [];
          for (const row of rows) {
            const firstCell = (row.querySelector('td, th')?.textContent || '').trim();
            rowDebug.push(firstCell.substring(0, 80));
            if (/systemat/i.test(firstCell)) {
              systematicRow = row;
              break;
            }
          }

          if (!systematicRow) {
            return { error: 'no_systematic_row', normaalIdx, zwaarIdx,
              rows: rowDebug, headerTexts: Array.from(headerCells).map(c => c.textContent?.trim()) };
          }

          const cells = systematicRow.querySelectorAll('td, th');
          const normaalText = normaalIdx < cells.length ? (cells[normaalIdx].textContent || '').trim() : '';
          const zwaarText = zwaarIdx >= 0 && zwaarIdx < cells.length ? (cells[zwaarIdx].textContent || '').trim() : '';

          return { method: 'table', normaalText, zwaarText, normaalIdx, zwaarIdx };
        }

        // ── METHODE 2: Regex fallback (voor pagina's zonder tabel) ──
        const patterns = [
          /Elk[e]?\s+(\d[\d.\s]*)\s*[Kk][Mm]?\s*\/\s*(\d+)\s*(jaar|jaren|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          /[Tt]ous\s+les\s+(\d[\d.\s]*)\s*[Kk][Mm]?\s*\/\s*(\d+)\s*(jaar|jaren|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          /[Ee]very\s+(\d[\d.\s]*)\s*[Kk][Mm]?\s*\/\s*(\d+)\s*(jaar|jaren|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          /(\d[\d.\s]{3,})\s*[Kk][Mm]\s*(?:of|ou|or)\s*(\d+)\s*(jaar|jaren|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          /(\d[\d.\s]{3,})\s*[Kk][Mm]\s*\/\s*(\d+)\s*(jaar|jaren|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          /(\d{2,3}[.\s]?000)\s*[Kk][Mm][\s\S]{0,20}?(\d{1,2})\s*(jaar|jaren|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi
        ];

        for (const pattern of patterns) {
          const matches = [...bodyText.matchAll(pattern)];
          if (matches.length > 0) {
            return { method: 'regex', matches: matches.map(m => ({ full: m[0], g1: m[1], g2: m[2], g3: m[3] })) };
          }
        }

        return { error: 'no_match', text: bodyText.substring(0, 800) };
      });

      if (freq && freq.error === 'empty_frame') {
        console.log(`[Frequency] Frame ${fi} (${frameUrl.substring(0, 80)}): leeg`);
        continue;
      }

      if (freq && freq.error === 'no_systematic_row') {
        console.log(`[Frequency] Frame ${fi}: tabel gevonden (normaalIdx=${freq.normaalIdx}) maar geen systematische rij. Headers: ${JSON.stringify(freq.headerTexts)}. Rijen: ${freq.rows.join(' | ')}`);
        continue;
      }

      if (freq && freq.error === 'no_match') {
        console.log(`[Frequency] Frame ${fi} (${frameUrl.substring(0, 80)}): geen match. Tekst: ${freq.text.substring(0, 300)}`);
        continue;
      }

      // ── Verwerk tabel-resultaat ──
      if (freq && freq.method === 'table') {
        console.log(`[Frequency] Tabel gevonden! normaalIdx=${freq.normaalIdx}, zwaarIdx=${freq.zwaarIdx}`);
        console.log(`[Frequency] Normaal cel: "${freq.normaalText}"`);
        console.log(`[Frequency] Zwaar cel: "${freq.zwaarText}"`);

        const normal = parseFreqValue(freq.normaalText);
        const heavy = parseFreqValue(freq.zwaarText);

        if (normal) {
          console.log(`[Frequency] Normaal: ${normal.km} km / ${normal.months} maanden`);
          return {
            km: normal.km, months: normal.months, condition: 'normaal',
            km_heavy: heavy ? heavy.km : null, months_heavy: heavy ? heavy.months : null,
            source: 'servicebox_schema',
            raw: `Normaal: ${freq.normaalText} | Zwaar: ${freq.zwaarText}`
          };
        } else {
          console.log(`[Frequency] Kon normaal-cel niet parsen: "${freq.normaalText}"`);
          // Niet terugvallen op zwaar — liever null zodat duidelijk is dat het ontbreekt
        }
        continue;
      }

      // ── Verwerk regex-resultaat ──
      if (freq && freq.method === 'regex') {
        const first = freq.matches[0];
        const normal = parseFreqValue(first.full);
        const heavy = freq.matches.length > 1 ? parseFreqValue(freq.matches[1].full) : null;

        if (normal) {
          console.log(`[Frequency] Regex match: ${normal.km} km / ${normal.months} maanden (uit "${first.full}")`);
          return {
            km: normal.km, months: normal.months, condition: 'normaal',
            km_heavy: heavy ? heavy.km : null, months_heavy: heavy ? heavy.months : null,
            source: 'servicebox_schema',
            raw: freq.matches.map(m => m.full).join(' | ')
          };
        }
      }
    } catch (e) {
      console.log(`[Frequency] Frame ${fi}: error - ${e.message.substring(0, 100)}`);
      continue;
    }
  }

  console.log('[Frequency] Geen frequentie gevonden in enig frame');
  return null;
}

async function extractIntervals(page) {
  console.log('[Intervals] Extracting beschikbare intervallen...');

  const intervals = [];
  const framesToCheck = page.frames().length > 1 ? page.frames() : [page.mainFrame()];

  for (const frame of framesToCheck) {
    try {
      const frameIntervals = await frame.evaluate(() => {
        const results = [];
        const bodyText = document.body?.innerText || '';

        // Helper: clean whitespace
        function clean(text) {
          return (text || '').replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }

        // Zoek alle elementen die km-waarden bevatten
        const allElements = document.querySelectorAll('a, button, span, td, option, label, div, li, select option');

        for (const el of allElements) {
          const text = clean(el.textContent);

          // Match "30.000 KM", "30 000 km", "30000 KM", etc.
          const kmMatch = text.match(/^(\d{2,3})[.\s]?000\s*(km|KM)?$/i);
          if (kmMatch) {
            results.push({
              type: 'km',
              label: `${kmMatch[1]}.000 KM`,
              sort: parseInt(kmMatch[1])
            });
          }

          // Match jaarlijkse beurt
          if (/^jaarlijks/i.test(text) || /^annuel/i.test(text) || /^annual/i.test(text)) {
            results.push({ type: 'yearly', label: text, sort: 999 });
          }
        }

        // Ook zoeken in select/dropdown opties
        const selects = document.querySelectorAll('select');
        for (const select of selects) {
          for (const option of select.options) {
            const text = option.textContent.trim();
            const kmMatch = text.match(/(\d{2,3})[.\s]?000/);
            if (kmMatch) {
              results.push({
                type: 'km',
                label: `${kmMatch[1]}.000 KM`,
                sort: parseInt(kmMatch[1])
              });
            }
          }
        }

        // Dedupliceer
        const seen = new Set();
        return results.filter(item => {
          if (seen.has(item.label)) return false;
          seen.add(item.label);
          return true;
        });
      });

      if (frameIntervals.length > 0) {
        intervals.push(...frameIntervals);
        break;
      }
    } catch (e) { continue; }
  }

  intervals.sort((a, b) => a.sort - b.sort);
  console.log(`[Intervals] ${intervals.length} intervallen gevonden`);
  return intervals;
}

// =========================================
// PRIJZEN PER INTERVAL
// =========================================
/**
 * Klikt elk interval (30K, 60K, etc.) aan en leest de resulterende
 * offerte/prijstabel uit. In Quotelink worden prijzen server-side berekend
 * nadat je een interval selecteert.
 *
 * Returns: [{ interval: "30.000 KM", items: [...], total_labor, total_parts, total_price }]
 */
async function extractPricesPerInterval(page, intervals) {
  console.log(`[IntervalPricing] Prijzen ophalen voor ${intervals.length} intervallen...`);

  const results = [];
  const framesToUse = page.frames().length > 1 ? page.frames() : [page.mainFrame()];

  for (const interval of intervals) {
    console.log(`[IntervalPricing] Klik interval: ${interval.label}`);

    // Klik op het interval-element in de tree (links)
    let clicked = false;
    for (const frame of framesToUse) {
      try {
        const elements = await frame.$$('a, button, span, td, div, li');
        for (const el of elements) {
          const text = (await el.textContent()).trim();
          const kmNum = interval.label.replace(/[.\s]?000\s*KM$/i, '');
          if (text === interval.label ||
              text === kmNum + '.000 KM' ||
              text === kmNum + '.000' ||
              (interval.type === 'yearly' && /^jaarlijks/i.test(text))) {
            await el.click();
            clicked = true;
            break;
          }
        }
        if (clicked) break;
      } catch (e) { continue; }
    }

    if (!clicked) {
      console.log(`[IntervalPricing] Kon interval ${interval.label} niet aanklikken`);
      continue;
    }

    // Wacht op popup: "Select menu om aan de prijsopgave toe te voegen"
    await page.waitForTimeout(2000);

    // Extract pakketten uit de popup-tabel
    // Popup structuur: tabel met rijen als:
    //   NSC Menu | 30.000 KM 4711 (OEM) | € 257,44 | € 311,50 | Voeg toe aan prijsopgave
    //   Eurorepar Parts | Eurorepar onderdelen aanbod | € 252,53 | € 305,56 | Voeg toe aan prijsopgave
    let packages = null;
    for (const frame of framesToUse) {
      try {
        packages = await frame.evaluate(() => {
          function clean(t) { return (t || '').replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim(); }

          const bodyText = document.body?.innerText || '';

          // Check of popup zichtbaar is
          const hasPopup = bodyText.includes('Select menu') || bodyText.includes('prijsopgave toe te voegen');
          // Check of er überhaupt prijzen geconfigureerd zijn
          const notPriced = bodyText.includes('NIET geprijsd') || bodyText.includes('niet geprijsd');

          const items = [];

          // Zoek de popup-tabel: bevat "Voeg toe aan prijsopgave" links
          const tables = document.querySelectorAll('table');
          for (const table of tables) {
            const tableText = table.textContent || '';
            if (!tableText.includes('Voeg toe') && !tableText.includes('voeg toe') && !tableText.includes('prijsopgave')) continue;

            const rows = table.querySelectorAll('tr');
            for (const row of rows) {
              const cells = Array.from(row.querySelectorAll('td'));
              if (cells.length < 3) continue;

              const texts = cells.map(c => clean(c.textContent));
              // Zoek rijen met € prijzen
              const pricePattern = /€\s*[\d.,]+/;
              const priceTexts = texts.filter(t => pricePattern.test(t));

              if (priceTexts.length >= 1) {
                // Extract pakket info
                const name = texts[0]; // bijv. "NSC Menu" of "Eurorepar Parts"
                const description = texts[1]; // bijv. "30.000 KM 4711 (OEM)"

                // Extract alle € bedragen uit de rij
                const allPrices = [];
                for (const t of texts) {
                  const matches = t.matchAll(/€\s*([\d.,]+)/g);
                  for (const m of matches) {
                    const val = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                    if (val > 0) allPrices.push(val);
                  }
                }

                if (name && allPrices.length >= 1) {
                  items.push({
                    package_name: name,
                    description: description || '',
                    price_excl_btw: allPrices[0] || null,
                    price_incl_btw: allPrices[1] || allPrices[0] || null
                  });
                }
              }
            }
          }

          // Fallback: als geen popup-tabel gevonden, zoek losse € bedragen bij "Select menu" tekst
          if (items.length === 0 && hasPopup) {
            const allEls = document.querySelectorAll('td, div, span, tr');
            for (const el of allEls) {
              const text = clean(el.textContent);
              if (text.includes('NSC Menu') || text.includes('Eurorepar') || text.includes('OEM')) {
                const prices = [];
                const matches = text.matchAll(/€\s*([\d.,]+)/g);
                for (const m of matches) {
                  const val = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                  if (val > 0) prices.push(val);
                }
                if (prices.length > 0) {
                  // Extract naam: alles voor het eerste € teken
                  const nameMatch = text.match(/^(.+?)€/);
                  items.push({
                    package_name: nameMatch ? clean(nameMatch[1]) : text.substring(0, 60),
                    description: '',
                    price_excl_btw: prices[0] || null,
                    price_incl_btw: prices[1] || prices[0] || null
                  });
                }
              }
            }
          }

          return {
            items,
            not_priced: notPriced,
            has_popup: hasPopup,
            _debug: {
              items_found: items.length,
              has_popup: hasPopup,
              not_priced: notPriced,
              page_text_preview: bodyText.substring(0, 500)
            }
          };
        });

        if (packages && (packages.items.length > 0 || packages.not_priced)) break;
      } catch (e) { continue; }
    }

    // Sluit de popup door op "Sluiten" te klikken
    for (const frame of framesToUse) {
      try {
        const sluitenBtn = await frame.$('a:has-text("Sluiten"), button:has-text("Sluiten"), td:has-text("Sluiten")');
        if (sluitenBtn) {
          await sluitenBtn.click();
          await page.waitForTimeout(1000);
          break;
        }
      } catch (e) { continue; }
    }

    if (packages) {
      if (packages.not_priced && packages.items.length === 0) {
        console.log(`[IntervalPricing] ${interval.label}: NIET GEPRIJSD`);
      } else if (packages.items.length > 0) {
        console.log(`[IntervalPricing] ${interval.label}: ${packages.items.length} pakket(ten) gevonden`);
        for (const pkg of packages.items) {
          console.log(`[IntervalPricing]   - ${pkg.package_name}: ${pkg.description} => excl €${pkg.price_excl_btw}, incl €${pkg.price_incl_btw}`);
        }
      } else {
        console.log(`[IntervalPricing] ${interval.label}: geen pakketten gevonden (popup: ${packages.has_popup})`);
        console.log(`[IntervalPricing] Debug: ${(packages._debug?.page_text_preview || '').substring(0, 200)}`);
      }
      results.push({
        interval: interval.label,
        interval_type: interval.type,
        packages: packages.items,
        not_priced: packages.not_priced || false
      });
    } else {
      console.log(`[IntervalPricing] ${interval.label}: geen data`);
      results.push({
        interval: interval.label,
        interval_type: interval.type,
        packages: [],
        not_priced: false
      });
    }
  }

  console.log(`[IntervalPricing] Klaar: ${results.length} intervallen verwerkt`);
  return results;
}

/**
 * Leest de volledige service-catalogus uit de tree-widget (#joblist-inner).
 * Structuur: div.l1 (categorie) → div.l2 (sub-categorie) → div.l3+ (items/varianten)
 * Prijzen worden opgehaald door leaf-items aan te klikken (server-side berekend).
 */
async function extractPricesByCategory(page) {
  console.log('[Prices] Extracting servicecatalogus uit DOM...');

  // Stap 1: Parse de volledige tree-structuur
  const catalog = await page.evaluate(() => {
    function clean(t) { return (t || '').replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim(); }

    // Haal directe tekst op (zonder tekst van child-elementen)
    function ownText(el) {
      return Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .filter(t => t.length > 0)
        .join(' ');
    }

    const container = document.getElementById('joblist-inner');
    if (!container) return [];

    const categories = [];
    const children = Array.from(container.children);

    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      if (child.classList?.contains('l1')) {
        const catName = clean(ownText(child)) || clean(child.textContent);
        const catId = child.id?.replace('l_', '') || '';

        // De volgende sibling div bevat de verborgen sub-items
        const contentDiv = children[i + 1];
        if (!contentDiv || contentDiv.classList?.contains('l1')) {
          categories.push({ name: catName, subcategories: [] });
          continue;
        }

        const subcategories = [];

        // Zoek l2-divs (sub-categorieën)
        const l2Divs = contentDiv.querySelectorAll('div.l2');
        for (const l2 of l2Divs) {
          const subName = clean(ownText(l2)) || clean(l2.textContent);
          const subId = l2.id?.replace('l_', '') || '';

          // De verborgen content div voor deze l2 heeft id = subId (zonder 'l_')
          const subContentDiv = document.getElementById(subId);
          const leafItems = [];

          if (subContentDiv) {
            // Zoek leaf items: l3-divs of dieper
            const l3Divs = subContentDiv.querySelectorAll('div.l3, div.l4, div.l5');

            if (l3Divs.length > 0) {
              for (const l3 of l3Divs) {
                const itemName = clean(ownText(l3)) || clean(l3.textContent);
                const itemId = l3.id?.replace('l_', '') || '';
                if (itemName && itemName.length > 1) {
                  leafItems.push({ name: itemName, id: itemId });
                }
              }
            }

            // Fallback: geen l3+ divs gevonden — zoek andere structuren
            if (leafItems.length === 0) {
              // Strategie A: zoek alle child-divs met een id (tree-nodes)
              const childDivs = Array.from(subContentDiv.children).filter(
                el => el.tagName === 'DIV' && el.id
              );
              if (childDivs.length > 0) {
                for (const div of childDivs) {
                  const txt = clean(ownText(div)) || clean(div.textContent);
                  const divId = div.id?.replace('l_', '') || '';
                  if (txt && txt.length > 1 && txt.length < 200) {
                    leafItems.push({ name: txt, id: divId });
                  }
                }
              }

              // Strategie B: zoek klikbare elementen (spans/links met onclick)
              if (leafItems.length === 0) {
                const clickables = subContentDiv.querySelectorAll('[onclick], a[href*="javascript"]');
                for (const el of clickables) {
                  const txt = clean(el.textContent);
                  if (txt && txt.length > 1 && txt.length < 200) {
                    leafItems.push({ name: txt, id: el.id || '' });
                  }
                }
              }

              // Strategie C: splits op herkenbare patronen (fallback)
              if (leafItems.length === 0) {
                const rawText = clean(subContentDiv.textContent);
                if (rawText.length > 2) {
                  // Probeer te splitsen op herhalende patronen
                  // bijv. "Demonteren en vernieuwe ... Demonteren en vernieuwe ..."
                  // of "Alleen arbeidstijd ... Alleen arbeidstijd ..."
                  const splitPatterns = [
                    /(?=Demonteren en vernieuwe\b)/g,
                    /(?=Uitsluitend Levering\b)/g,
                    /(?=Alleen arbeidstijd\b)/g,
                    /(?=Verversen\b)/g,
                    /(?=Controleren en )/g,
                    /(?=Monteren\b)/g,
                  ];

                  let parts = [rawText];
                  for (const pattern of splitPatterns) {
                    if (rawText.match(pattern)?.length > 1) {
                      parts = rawText.split(pattern).map(s => clean(s)).filter(s => s.length > 1);
                      break;
                    }
                  }

                  // Als geen split-patroon werkte, gebruik de hele tekst
                  for (const part of parts) {
                    leafItems.push({ name: part.substring(0, 200), id: '' });
                  }
                }
              }
            }
          }

          subcategories.push({
            name: subName,
            id: subId,
            items: leafItems
          });
        }

        categories.push({ name: catName, subcategories });
        i++; // skip de content-div
      }
    }

    return categories;
  });

  console.log(`[Prices] ${catalog.length} categorieën geparsed`);

  // Log de catalogus samenvatting
  let totalWithId = 0;
  let totalWithoutId = 0;
  for (const cat of catalog) {
    const totalItems = cat.subcategories.reduce((sum, sub) => sum + sub.items.length, 0);
    const withId = cat.subcategories.reduce((sum, sub) => sum + sub.items.filter(i => i.id).length, 0);
    totalWithId += withId;
    totalWithoutId += (totalItems - withId);
    console.log(`[Prices]   ${cat.name}: ${cat.subcategories.length} sub-cats, ${totalItems} items (${withId} met ID, ${totalItems - withId} zonder)`);
  }
  console.log(`[Prices] Totalen: ${totalWithId} items met ID, ${totalWithoutId} items zonder ID`);

  // Flatten de catalogus naar een platte lijst van items
  const items = [];
  for (const cat of catalog) {
    for (const sub of cat.subcategories) {
      for (const item of sub.items) {
        items.push({
          category: cat.name,
          subcategory: sub.name,
          package_name: item.name,
          item_id: item.id
        });
      }
    }
  }

  console.log(`[Prices] Totaal ${items.length} service-items geëxtraheerd`);
  return items;
}

// Prijzen ophalen per item (v2 — vereist diepere tree-interactie)
// TODO: Leaf items aanklikken om prijzen uit offerte-tabel te lezen

// =========================================
// VIN-ONLY QUOTELINK LOOKUP
// =========================================
/**
 * Zoekt alleen service-intervallen + prijzen op via VIN (chassisnummer).
 * Slaat recalls over en geeft alleen Quotelink/maintenance data terug.
 *
 * Flow:
 * 1. Login op Servicebox (sessie nodig voor Quotelink)
 * 2. Zoek op VIN via hetzelfde shortvin-veld
 * 3. Extract basisvoertuigdata (indien beschikbaar)
 * 4. Open Menu pricing / Quotelink
 * 5. Extract intervallen + prijzen
 */
async function scrapeQuotelink(vin, kmStand, credentials = {}) {
  const headless = process.env.HEADLESS !== 'false';
  const slowMo = parseInt(process.env.SLOW_MO || '0');
  const USERNAME = credentials.username;
  const PASSWORD = credentials.password;

  if (!USERNAME || !PASSWORD) {
    throw new Error('Servicebox credentials zijn verplicht. Stel deze in via Instellingen.');
  }

  console.log(`[Quotelink] Start VIN lookup: ${vin}, km: ${kmStand || 'n.v.t.'}`);
  console.log(`[Quotelink] Headless: ${headless}, SlowMo: ${slowMo}`);
  console.log(`[Quotelink] Credentials: ${USERNAME}`);

  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    httpCredentials: {
      username: USERNAME,
      password: PASSWORD
    }
  });

  const page = await context.newPage();

  try {
    // STAP 1: Login
    await login(page, USERNAME, PASSWORD);

    // STAP 2: Zoek voertuig op VIN (zelfde flow als kenteken)
    const vehicleData = await searchAndExtractVehicle(page, vin);

    // STAP 3: Skip recalls — ga direct naar Menu pricing
    const { intervals, interval_pricing, prices, service_frequency } = await extractMaintenance(page, context, kmStand, vin);

    console.log('[Quotelink] VIN lookup voltooid!');
    return {
      vehicle: vehicleData,
      recalls: [],  // Niet opgehaald bij VIN-only lookup
      intervals,
      interval_pricing,
      prices,
      service_frequency,
      // Top-level convenience velden voor directe mapping in Supabase
      service_frequency_km: service_frequency?.km || null,
      service_frequency_months: service_frequency?.months || null,
      service_frequency_source: service_frequency?.source || null
    };

  } catch (error) {
    console.error('[Quotelink] Error:', error.message);
    console.error('[Quotelink] Stack:', error.stack?.substring(0, 500));
    try {
      await page.screenshot({ path: `error-vin-${Date.now()}.png` });
    } catch (e) { /* ignore */ }
    throw new Error(sanitizeErrorMessage(error.message));
  } finally {
    await browser.close();
  }
}

// =========================================
// 2+6 GARANTIE ACTIVATIE
// =========================================
/**
 * Activeert de 2+6 jaar speciale garantie voor een voertuig.
 *
 * Flow:
 * 1. Login op Servicebox
 * 2. Zoek voertuig op VIN
 * 3. Detecteer het groene "8" pictogram (= voertuig komt in aanmerking)
 * 4. Klik op het pictogram → extern formulier opent (allucare-dmbr.stellantis.com)
 * 5. Handle SSO auth (idfed.mpsa.com)
 * 6. Vul formulier in: kilometerstand + e-mailadres klant
 * 7. Vink beide bevestigingscheckboxes aan
 * 8. Klik "Indienen"
 *
 * Returns: { status, vin, message, vehicle, contract_info }
 */
async function activateWarranty(vin, kmStand, customerEmail, credentials = {}) {
  const headless = process.env.HEADLESS !== 'false';
  const slowMo = parseInt(process.env.SLOW_MO || '250');
  const USERNAME = credentials.username;
  const PASSWORD = credentials.password;

  if (!USERNAME || !PASSWORD) {
    throw new Error('Servicebox credentials zijn verplicht. Stel deze in via Instellingen.');
  }

  console.log(`[Warranty] Start 2+6 activatie: ${vin}, km: ${kmStand}, email: ${customerEmail ? '***' : 'GEEN'}`);
  console.log(`[Warranty] Credentials: ${USERNAME}`);

  if (!customerEmail) {
    return { status: 'skipped', vin, message: 'Geen e-mailadres opgegeven (verplicht veld)' };
  }

  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    httpCredentials: {
      username: USERNAME,
      password: PASSWORD
    }
  });

  // Luister naar nieuwe pagina's (het 2+6 formulier opent in nieuw venster)
  let warrantyPage = null;
  context.on('page', (newPage) => {
    console.log(`[Warranty] Nieuw venster geopend: ${newPage.url()}`);
    warrantyPage = newPage;
  });

  const page = await context.newPage();

  try {
    // STAP 1: Login
    await login(page, USERNAME, PASSWORD);

    // STAP 2: Zoek voertuig op VIN
    const vehicleData = await searchAndExtractVehicle(page, vin);
    console.log(`[Warranty] Voertuig gevonden: ${JSON.stringify(vehicleData)}`);

    // STAP 3+4: Navigeer direct naar /stellaCare/ en vind het Allucare formulier
    // Simpele aanpak: open /stellaCare/ als nieuwe pagina in dezelfde browser context.
    // De Servicebox server-sessie (cookies) onthoudt welk voertuig geselecteerd is.
    // De StellaCare pagina toont ofwel:
    //   A) Een redirect naar Allucare/idfed (het formulier)
    //   B) Een tussenpagina met "klik hier" link naar Allucare
    //   C) Een melding dat het voertuig niet in aanmerking komt

    console.log('[Warranty] STAP 3+4 — Open StellaCare pagina direct...');

    // Open /stellaCare/ als nieuwe pagina (deelt cookies/sessie met de vehicle search)
    const stellaCarePage = await context.newPage();
    try {
      await stellaCarePage.goto(`${SERVICEBOX_URL}/stellaCare/`, {
        waitUntil: 'networkidle',
        timeout: 30000
      });
    } catch (e) {
      console.log(`[Warranty] StellaCare navigatie timeout (gaat door): ${e.message.substring(0, 100)}`);
    }

    const scUrl = stellaCarePage.url();
    console.log(`[Warranty] StellaCare pagina URL: ${scUrl}`);

    // Check of we direct op Allucare/idfed terecht zijn gekomen
    if (scUrl.includes('allucare') || scUrl.includes('idfed')) {
      warrantyPage = stellaCarePage;
      console.log('[Warranty] Direct doorgestuurd naar Allucare/idfed');
    } else {
      // We zijn op een Servicebox tussenpagina. Zoek "klik hier" link.
      console.log('[Warranty] Op Servicebox tussenpagina, zoek "klik hier" link...');
      await stellaCarePage.waitForTimeout(3000);

      // Log de pagina-inhoud voor debug
      const scContent = await stellaCarePage.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
      console.log(`[Warranty] StellaCare pagina inhoud: ${scContent.substring(0, 300)}`);

      // Zoek "klik hier" link op de pagina en in frames
      let kliklinkHref = null;
      const pagesToSearch = [stellaCarePage, ...stellaCarePage.frames()];
      for (const searchTarget of pagesToSearch) {
        try {
          kliklinkHref = await searchTarget.evaluate(() => {
            const links = document.querySelectorAll('a');
            for (const link of links) {
              const text = (link.textContent || '').toLowerCase();
              const href = link.href || link.getAttribute('href') || '';
              if ((text.includes('klik hier') || text.includes('click here') || text.includes('cliquez ici')) && href) {
                return href;
              }
              // Zoek ook links die naar allucare/stellacare verwijzen
              if (href.includes('allucare') || href.includes('idfed')) {
                return href;
              }
            }
            return null;
          });
          if (kliklinkHref) break;
        } catch (e) { continue; }
      }

      if (kliklinkHref) {
        console.log(`[Warranty] "Klik hier" link gevonden: ${kliklinkHref.substring(0, 120)}`);
        // Navigeer de stellaCarePage naar de link (in plaats van window.open)
        try {
          await stellaCarePage.goto(kliklinkHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
          warrantyPage = stellaCarePage;
          console.log(`[Warranty] Genavigeerd naar: ${warrantyPage.url().substring(0, 120)}`);
        } catch (e) {
          console.log(`[Warranty] Navigatie naar klik-hier link timeout (gaat door): ${e.message.substring(0, 100)}`);
          warrantyPage = stellaCarePage;
        }
      } else {
        // Geen "klik hier" link → check of de pagina een foutmelding toont
        const lowerContent = scContent.toLowerCase();
        if (lowerContent.includes('niet beschikbaar') || lowerContent.includes('not available') || lowerContent.includes('pas disponible')) {
          await browser.close();
          return {
            status: 'not_eligible',
            vin,
            message: `StellaCare niet beschikbaar voor dit voertuig: ${scContent.substring(0, 200)}`,
            vehicle: vehicleData
          };
        }

        // Check of er toch een Allucare pagina is geopend (via redirect of popup)
        const allPages = context.pages();
        for (const p of allPages) {
          const pUrl = p.url();
          if (pUrl.includes('allucare') || pUrl.includes('idfed')) {
            warrantyPage = p;
            console.log(`[Warranty] Allucare pagina gevonden in open tabs: ${pUrl.substring(0, 120)}`);
            break;
          }
        }

        // Als nog steeds niets: gebruik de stellaCarePage zelf
        if (!warrantyPage) {
          warrantyPage = stellaCarePage;
          console.log(`[Warranty] Geen Allucare link gevonden, gebruik huidige pagina: ${scUrl.substring(0, 120)}`);
        }
      }
    }

    if (!warrantyPage || warrantyPage.url() === 'about:blank') {
      await browser.close();
      return { status: 'error', vin, message: 'Formulier kon niet geopend worden — geen Allucare pagina gevonden', vehicle: vehicleData };
    }

    console.log(`[Warranty] Formulier pagina: ${warrantyPage.url()}`);

    // STAP 5: Handle SSO login (idfed.mpsa.com)
    // De pagina opent op idfed.mpsa.com met OAuth2 redirect naar allucare-dmbr.stellantis.com
    // We moeten inloggen en wachten tot we doorgestuurd worden naar het formulier

    // Wacht eerst tot de pagina geladen is
    await warrantyPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await warrantyPage.waitForTimeout(2000);

    console.log(`[Warranty] STAP 5 - Huidige URL: ${warrantyPage.url()}`);

    // SSO login loop — probeer max 3 keer (username stap, password stap, redirect)
    for (let ssoAttempt = 0; ssoAttempt < 3; ssoAttempt++) {
      const currentUrl = warrantyPage.url();
      console.log(`[Warranty] SSO check ${ssoAttempt + 1}/3, URL: ${currentUrl}`);

      if (!currentUrl.includes('idfed.mpsa.com')) {
        console.log('[Warranty] Niet meer op idfed, SSO login voltooid of niet nodig');
        break;
      }

      // Dump alle velden op de SSO pagina
      const ssoFields = await warrantyPage.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(el => ({
          type: el.type,
          name: el.name,
          id: el.id,
          placeholder: el.placeholder,
          visible: el.offsetParent !== null,
          outerHTML: el.outerHTML?.substring(0, 200)
        }));
      });
      console.log(`[Warranty] SSO pagina: ${ssoFields.length} input velden`);
      ssoFields.forEach(f => console.log(`[Warranty]   SSO INPUT: type=${f.type}, name=${f.name}, id=${f.id}, visible=${f.visible}`));

      // Check of er een password veld is (PingFederate pagina 2: username + password samen)
      const passwordField = await warrantyPage.$('input[type="password"]');
      const passwordVisible = passwordField ? await passwordField.isVisible().catch(() => false) : false;

      if (passwordVisible) {
        // PAGINA 2: Username staat er al in, vul alleen password in
        console.log('[Warranty] Password veld gevonden (PingFederate stap 2)');

        // Check of username al gevuld is, zo niet vul het in
        const usernameOnSamePage = await warrantyPage.$('#username, input[name="pf.username"]');
        if (usernameOnSamePage) {
          const currentVal = await usernameOnSamePage.inputValue().catch(() => '');
          if (!currentVal || currentVal.trim() === '') {
            console.log('[Warranty] Username veld leeg op password pagina, invullen...');
            await usernameOnSamePage.evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, USERNAME);
          } else {
            console.log(`[Warranty] Username al gevuld: ${currentVal.substring(0, 5)}...`);
          }
        }

        // Vul password in
        try {
          await passwordField.click();
          await warrantyPage.waitForTimeout(500);
          await warrantyPage.keyboard.type(PASSWORD, { delay: 50 });
          console.log('[Warranty] Password ingevuld via keyboard');
        } catch (e) {
          console.log(`[Warranty] Password keyboard mislukt, probeer JS: ${e.message.substring(0, 80)}`);
          await passwordField.evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, PASSWORD);
          console.log('[Warranty] Password ingevuld via JS evaluate');
        }

        // Zoek submit knop — PingFederate gebruikt vaak een <a> met class "ping-button"
        await warrantyPage.waitForTimeout(500);
        const submitBtn = await warrantyPage.$('a.ping-button, button[type="submit"], input[type="submit"], button:has-text("Sign"), button:has-text("Log"), button:has-text("Inloggen")');
        if (submitBtn) {
          await submitBtn.click();
          console.log('[Warranty] Login submit geklikt');
        } else {
          await warrantyPage.keyboard.press('Enter');
          console.log('[Warranty] Enter ingedrukt na password');
        }

        // Wacht op redirect naar allucare
        console.log('[Warranty] Wachten op redirect na login...');
        try {
          await warrantyPage.waitForURL(/allucare|stellantis|stellacare/i, { timeout: 30000 });
          console.log(`[Warranty] Redirect geslaagd: ${warrantyPage.url()}`);
        } catch (e) {
          console.log(`[Warranty] Redirect timeout, huidige URL: ${warrantyPage.url()}`);
          await warrantyPage.waitForTimeout(5000);
        }
        break;
      }

      // PAGINA 1: Alleen username veld (identifier stap)
      const usernameField = await warrantyPage.$('#identifierInput, input[name="subject"], input[type="text"]:not([type="hidden"])');
      if (usernameField) {
        const isVisible = await usernameField.isVisible().catch(() => false);
        if (isVisible) {
          console.log('[Warranty] Username/identifier veld gevonden (stap 1)');
          try {
            await usernameField.click();
            await warrantyPage.waitForTimeout(500);
            await usernameField.selectText().catch(() => {});
            await warrantyPage.keyboard.type(USERNAME, { delay: 50 });
            console.log('[Warranty] Username ingevuld via keyboard');
          } catch (e) {
            console.log(`[Warranty] Username keyboard mislukt, probeer JS: ${e.message.substring(0, 80)}`);
            await usernameField.evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, USERNAME);
            console.log('[Warranty] Username ingevuld via JS evaluate');
          }

          // Submit
          await warrantyPage.waitForTimeout(500);
          const submitBtn = await warrantyPage.$('a.ping-button, button[type="submit"], input[type="submit"], button:has-text("Next"), button:has-text("Volgende")');
          if (submitBtn) {
            await submitBtn.click();
            console.log('[Warranty] Identifier submit geklikt');
          } else {
            await warrantyPage.keyboard.press('Enter');
            console.log('[Warranty] Enter ingedrukt na identifier');
          }

          await warrantyPage.waitForTimeout(3000);
          await warrantyPage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          continue;
        }
      }

      // Geen username of password veld gevonden, wacht even
      console.log('[Warranty] Geen login velden gevonden, wacht...');
      await warrantyPage.waitForTimeout(3000);
    }

    // STAP 6: Check of we nu op het formulier zijn
    await warrantyPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await warrantyPage.waitForTimeout(3000);

    const pageUrl = warrantyPage.url();
    console.log(`[Warranty] STAP 6 - Formulier URL: ${pageUrl}`);

    // Als we nog steeds op idfed zitten, is de login mislukt
    if (pageUrl.includes('idfed.mpsa.com')) {
      console.log('[Warranty] Nog steeds op SSO pagina na login pogingen');
      const ssoContent = await warrantyPage.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
      console.log(`[Warranty] SSO pagina content: ${ssoContent}`);
      await browser.close();
      return { status: 'error', vin, message: 'SSO login mislukt — kon niet doorverwijzen naar formulier', vehicle: vehicleData };
    }

    // ── Wacht tot Angular SPA het formulier rendert (max 30s) ──
    // De pagina is op allucare-dmbr.stellantis.com/ maar de Angular form
    // component moet nog bootstrappen, API calls doen, en renderen.
    console.log('[Warranty] Wachten tot Angular formulier rendert...');
    let formRendered = false;
    for (let waitAttempt = 1; waitAttempt <= 15; waitAttempt++) {
      const hasForm = await warrantyPage.evaluate(() => {
        const body = document.body?.innerText || '';
        const hasLabels = body.includes('Gebruiksvoorwaarden') || body.includes('Kilometerstand') || body.includes('kilometerstand');
        const hasToggles = document.querySelectorAll('mat-slide-toggle, .mat-slide-toggle, .mat-mdc-slide-toggle').length > 0;
        const hasInputs = document.querySelectorAll('input[type="number"], input[type="email"]').length > 0;
        return { hasLabels, hasToggles, hasInputs, bodyLength: body.length };
      });

      if (hasForm.hasLabels || hasForm.hasToggles || hasForm.hasInputs) {
        console.log(`[Warranty] Formulier gerenderd na ${waitAttempt * 2}s (labels: ${hasForm.hasLabels}, toggles: ${hasForm.hasToggles}, inputs: ${hasForm.hasInputs})`);
        formRendered = true;
        break;
      }

      console.log(`[Warranty] Formulier nog niet gerenderd (poging ${waitAttempt}/15, body: ${hasForm.bodyLength} chars)`);
      await warrantyPage.waitForTimeout(2000);
    }

    if (!formRendered) {
      console.log('[Warranty] WAARSCHUWING: Formulier niet gerenderd na 30s, ga toch door...');
    }

    const pageContent = await warrantyPage.evaluate(() => document.body?.innerText || '');
    console.log(`[Warranty] Formulier content (eerste 500 chars): ${pageContent.substring(0, 500)}`);

    // Check of we op het juiste formulier zijn
    const contentLower = pageContent.toLowerCase();
    const isCorrectPage = contentLower.includes('warranty') || contentLower.includes('garantie') ||
                          contentLower.includes('kilometerstand') || contentLower.includes('kilometer') ||
                          contentLower.includes('care') || contentLower.includes('indienen') ||
                          contentLower.includes('e-mail') ||
                          pageUrl.includes('allucare') || pageUrl.includes('stellacare');

    if (!isCorrectPage) {
      console.log(`[Warranty] Onverwachte pagina. Content: ${pageContent.substring(0, 1000)}`);
      await browser.close();
      return { status: 'error', vin, message: `Onverwachte pagina na SSO login (URL: ${pageUrl.substring(0, 100)})`, vehicle: vehicleData };
    }

    // Check indieningsgeschiedenis - misschien al geactiveerd
    if (pageContent.includes('contract is aangemaakt') || pageContent.includes('already submitted') || pageContent.includes('reeds ingediend')) {
      await browser.close();
      return { status: 'already_activated', vin, message: '2+6 garantie is al eerder geactiveerd voor dit voertuig', vehicle: vehicleData };
    }

    // Debug: dump alle formulier-elementen op de pagina
    const formDebug = await warrantyPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map(el => ({
        tag: el.tagName,
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        value: el.value,
        visible: el.offsetParent !== null,
        outerHTML: el.outerHTML?.substring(0, 300)
      }));
      const labels = Array.from(document.querySelectorAll('label')).map(el => ({
        text: el.textContent?.trim()?.substring(0, 100),
        for: el.getAttribute('for'),
        outerHTML: el.outerHTML?.substring(0, 300)
      }));
      const iframes = Array.from(document.querySelectorAll('iframe')).map(el => ({
        src: el.src,
        id: el.id,
        name: el.name
      }));
      return { inputs, labels, iframes, bodyHTML: document.body?.innerHTML?.substring(0, 2000) };
    });

    console.log(`[Warranty] Formulier debug: ${formDebug.inputs.length} inputs, ${formDebug.labels.length} labels, ${formDebug.iframes.length} iframes`);
    formDebug.inputs.forEach(inp => console.log(`[Warranty]   INPUT: type=${inp.type}, name=${inp.name}, id=${inp.id}, placeholder=${inp.placeholder}, visible=${inp.visible}`));
    formDebug.labels.forEach(lbl => console.log(`[Warranty]   LABEL: "${lbl.text}" for=${lbl.for}`));
    formDebug.iframes.forEach(ifr => console.log(`[Warranty]   IFRAME: src=${ifr.src}, id=${ifr.id}, name=${ifr.name}`));
    if (formDebug.inputs.length === 0) {
      console.log(`[Warranty] Geen inputs gevonden! Body HTML: ${formDebug.bodyHTML}`);
    }

    // Check of het formulier in een iframe zit
    let formPage = warrantyPage;
    if (formDebug.iframes.length > 0 && formDebug.inputs.length === 0) {
      console.log('[Warranty] Formulier zit mogelijk in een iframe, zoek daar...');
      for (const frame of warrantyPage.frames()) {
        const frameInputs = await frame.$$('input, textarea, select');
        if (frameInputs.length > 0) {
          console.log(`[Warranty] ${frameInputs.length} inputs gevonden in iframe: ${frame.url()}`);
          formPage = frame;
          break;
        }
      }
    }

    // ══════════════════════════════════════════════════════════════
    // STAP 6: Gebruiksvoorwaarden mat-slide-toggle activeren (MOET EERST)
    // Sommige formulieren gebruiken mat-slide-toggle, andere gewone checkboxes.
    // Check eerst of er toggles zijn — zo niet, skip naar STAP 7.
    // ══════════════════════════════════════════════════════════════
    const hasAnyToggleElements = await formPage.evaluate(() => {
      return document.querySelectorAll('mat-slide-toggle, .mat-slide-toggle, .mat-mdc-slide-toggle').length > 0;
    });
    const hasRegularCheckboxes = await formPage.evaluate(() => {
      return document.querySelectorAll('input[type="checkbox"]').length > 0;
    });
    console.log(`[Warranty] STAP 6: toggles=${hasAnyToggleElements}, checkboxes=${hasRegularCheckboxes}`);

    let gebruiksToggled = false;

    // Als er geen toggles maar wél checkboxes zijn, skip STAP 6 (checkboxes worden in STAP 8 afgehandeld)
    if (!hasAnyToggleElements && hasRegularCheckboxes) {
      console.log('[Warranty] Geen mat-slide-toggle op formulier, checkboxes worden in STAP 8 afgehandeld — skip toggle polling');
    }

    // Helper: zoek en klik de toggle in de pagina
    const findAndClickToggle = async () => {
      return await formPage.evaluate(() => {
        // Zoek de span met "Normaal" — de toggle zit als sibling in dezelfde d-flex container
        const spans = Array.from(document.querySelectorAll('span'));
        for (const span of spans) {
          if (span.textContent?.trim() === 'Normaal' || span.textContent?.trim() === 'Normal') {
            const parent = span.parentElement;
            if (!parent) continue;
            const toggle = parent.querySelector('mat-slide-toggle, .mat-slide-toggle, .mat-mdc-slide-toggle');
            if (toggle) {
              const isChecked = toggle.classList.contains('mat-checked') || toggle.classList.contains('mat-mdc-slide-toggle-checked');
              if (!isChecked) {
                const label = toggle.querySelector('.mat-slide-toggle-label, .mdc-switch, label');
                if (label) { label.click(); } else { toggle.click(); }
              }
              return { found: true, clicked: 'sibling-toggle', wasChecked: isChecked };
            }
          }
        }

        // Fallback: zoek toggle in "in-column-value" div met "Gebruiksvoorwaarden"
        const valueDivs = document.querySelectorAll('.in-column-value, [class*="column-value"]');
        for (const div of valueDivs) {
          if (div.textContent?.includes('Gebruiksvoorwaarden')) {
            const toggle = div.querySelector('mat-slide-toggle, .mat-slide-toggle, .mat-mdc-slide-toggle');
            if (toggle) {
              const isChecked = toggle.classList.contains('mat-checked') || toggle.classList.contains('mat-mdc-slide-toggle-checked');
              if (!isChecked) {
                const label = toggle.querySelector('.mat-slide-toggle-label, .mdc-switch, label');
                if (label) { label.click(); } else { toggle.click(); }
              }
              return { found: true, clicked: 'value-div-toggle', wasChecked: isChecked };
            }
          }
        }

        // Laatste fallback: alle mat-slide-toggles
        const allToggles = document.querySelectorAll('mat-slide-toggle, .mat-slide-toggle, .mat-mdc-slide-toggle');
        const toggleInfo = Array.from(allToggles).map((t, i) => ({
          index: i,
          id: t.id,
          checked: t.classList.contains('mat-checked') || t.classList.contains('mat-mdc-slide-toggle-checked'),
          text: t.closest('div')?.textContent?.trim()?.substring(0, 80) || ''
        }));

        return { found: false, allToggles: toggleInfo };
      });
    };

    // Alleen toggle-polling doen als er daadwerkelijk toggle-elementen zijn (of nog geen checkboxes)
    if (hasAnyToggleElements || !hasRegularCheckboxes) {
      // Poll tot de toggle verschijnt (max 15 seconden, elke 2s)
      const maxToggleAttempts = 8;
      for (let attempt = 1; attempt <= maxToggleAttempts; attempt++) {
        try {
          const toggleResult = await findAndClickToggle();

          if (toggleResult.found) {
            gebruiksToggled = true;
            console.log(`[Warranty] Gebruiksvoorwaarden toggle geklikt (${toggleResult.clicked}, was checked: ${toggleResult.wasChecked}, poging ${attempt})`);
            break;
          } else {
            console.log(`[Warranty] Poging ${attempt}/${maxToggleAttempts}: toggle niet gevonden. Alle toggles: ${JSON.stringify(toggleResult.allToggles)}`);
            if (attempt < maxToggleAttempts) {
              await formPage.waitForTimeout(2000);
            }
          }
        } catch (e) {
          console.log(`[Warranty] Toggle poging ${attempt} fout: ${e.message.substring(0, 150)}`);
          if (attempt < maxToggleAttempts) {
            await formPage.waitForTimeout(2000);
          }
        }
      }

      // Wacht tot velden enabled worden na toggle
      if (gebruiksToggled) {
        await formPage.waitForTimeout(2000);

        // Verifieer toggle status — als niet checked, probeer opnieuw te klikken
        for (let verifyAttempt = 1; verifyAttempt <= 3; verifyAttempt++) {
          const toggleVerify = await formPage.evaluate(() => {
            const toggles = document.querySelectorAll('mat-slide-toggle, .mat-slide-toggle, .mat-mdc-slide-toggle');
            return Array.from(toggles).map(t => ({
              id: t.id,
              checked: t.classList.contains('mat-checked') || t.classList.contains('mat-mdc-slide-toggle-checked'),
              text: t.textContent?.trim()?.substring(0, 50)
            }));
          });
          console.log(`[Warranty] Toggle verificatie (poging ${verifyAttempt}): ${JSON.stringify(toggleVerify)}`);

          const anyChecked = toggleVerify.some(t => t.checked);
          if (anyChecked) {
            console.log('[Warranty] Toggle is checked — doorgaan');
            break;
          }

          // Niet checked → opnieuw klikken
          console.log('[Warranty] Toggle NIET checked na klik, opnieuw proberen...');
          await findAndClickToggle();
          await formPage.waitForTimeout(2000);
        }

        // Check of er nu enabled input velden zijn
        const enabledInputs = await formPage.evaluate(() => {
          const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])');
          return Array.from(inputs).map(i => ({
            name: i.name, id: i.id, type: i.type, disabled: i.disabled, readOnly: i.readOnly, visible: i.offsetParent !== null
          }));
        });
        console.log(`[Warranty] Input velden na toggle: ${JSON.stringify(enabledInputs)}`);
      } else {
        console.log('[Warranty] WAARSCHUWING: Gebruiksvoorwaarden toggle niet gevonden na alle pogingen');
      }
    }

    // ══════════════════════════════════════════════════════════════
    // STAP 7: Kilometerstand + e-mailadres invullen
    // Eerst proberen met specifieke selectors, dan fallback op labels
    // ══════════════════════════════════════════════════════════════
    console.log('[Warranty] STAP 7: km + email invullen...');
    let kmFilled = false;
    let emailFilled = false;

    // Specifieke selectors — de "Operatie lijn" formulieren hebben inputs zonder name/id,
    // maar er is precies 1 input[type="number"] (km) en 1 input[type="email"] (email)
    try {
      const kmByType = formPage.locator('input[type="number"]:not([disabled])').first();
      if (await kmByType.count() > 0) {
        await kmByType.fill(String(kmStand));
        kmFilled = true;
        console.log(`[Warranty] Kilometerstand ingevuld via type=number: ${kmStand}`);
      }
    } catch (e) { console.log(`[Warranty] km type=number fout: ${e.message.substring(0, 80)}`); }

    try {
      const emailByType = formPage.locator('input[type="email"]:not([disabled])').first();
      if (await emailByType.count() > 0) {
        await emailByType.fill(customerEmail);
        emailFilled = true;
        console.log('[Warranty] E-mailadres ingevuld via type=email');
      }
    } catch (e) { console.log(`[Warranty] email type=email fout: ${e.message.substring(0, 80)}`); }

    // Fallback: name/id patronen (voor andere formulier-varianten)
    try {
      const kmField = formPage.locator('input[name*="ilomet" i], input[id*="ilomet" i], input[name*="ileage" i], input[id*="km" i]').first();
      if (!kmFilled && await kmField.count() > 0) {
        await kmField.fill(String(kmStand));
        kmFilled = true;
        console.log(`[Warranty] Kilometerstand ingevuld via name/id selector: ${kmStand}`);
      }
    } catch (e) { console.log(`[Warranty] km specifieke selector fout: ${e.message.substring(0, 80)}`); }

    try {
      const emailField = formPage.locator('input[name*="mail" i], input[id*="mail" i]').first();
      if (!emailFilled && await emailField.count() > 0) {
        await emailField.fill(customerEmail);
        emailFilled = true;
        console.log('[Warranty] E-mailadres ingevuld via specifieke selector');
      }
    } catch (e) { console.log(`[Warranty] email specifieke selector fout: ${e.message.substring(0, 80)}`); }

    // Fallback: zoek op label/parent tekst
    if (!kmFilled || !emailFilled) {
      const allInputs = await formPage.$$('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
      console.log(`[Warranty] Fallback: ${allInputs.length} invulbare velden gevonden`);

      for (const input of allInputs) {
        const fieldInfo = await input.evaluate(el => {
          const id = el.id;
          const label = id ? document.querySelector(`label[for="${id}"]`) : null;
          const labelText = label ? label.textContent?.trim() : '';
          const parent = el.closest('div, tr, td, fieldset, .form-group, .field');
          const parentText = parent ? parent.textContent?.trim()?.substring(0, 300) : '';
          return {
            id: el.id, name: el.name, type: el.type, value: el.value,
            placeholder: el.placeholder || '', labelText,
            parentText: parentText.substring(0, 200),
            ariaLabel: el.getAttribute('aria-label') || '',
            disabled: el.disabled, readOnly: el.readOnly
          };
        });

        const searchText = (fieldInfo.labelText + ' ' + fieldInfo.parentText + ' ' + fieldInfo.placeholder + ' ' + fieldInfo.ariaLabel + ' ' + fieldInfo.name + ' ' + fieldInfo.id).toLowerCase();
        console.log(`[Warranty]   Veld: id=${fieldInfo.id}, name=${fieldInfo.name}, type=${fieldInfo.type}, disabled=${fieldInfo.disabled}, label="${fieldInfo.labelText}", placeholder="${fieldInfo.placeholder}"`);

        if (!kmFilled && (searchText.includes('kilometer') || searchText.includes('km') || searchText.includes('mileage') || searchText.includes('odometer'))) {
          await input.fill(String(kmStand));
          kmFilled = true;
          console.log(`[Warranty] Kilometerstand ingevuld: ${kmStand} (veld: ${fieldInfo.id || fieldInfo.name})`);
        } else if (!emailFilled && (searchText.includes('mail') || searchText.includes('e-mail') || searchText.includes('email') || searchText.includes('courriel'))) {
          await input.fill(customerEmail);
          emailFilled = true;
          console.log(`[Warranty] E-mailadres ingevuld (veld: ${fieldInfo.id || fieldInfo.name})`);
        }
      }

      // Laatste fallback: vul lege velden op volgorde
      if (!kmFilled || !emailFilled) {
        console.log('[Warranty] Velden niet gevonden via labels, probeer op volgorde...');
        const emptyInputs = [];
        for (const input of allInputs) {
          const val = await input.inputValue().catch(() => '');
          const isVisible = await input.isVisible().catch(() => false);
          const isDisabled = await input.evaluate(el => el.disabled).catch(() => true);
          if ((!val || val.trim() === '') && isVisible && !isDisabled) {
            emptyInputs.push(input);
          }
        }
        console.log(`[Warranty] ${emptyInputs.length} lege zichtbare enabled velden gevonden`);

        if (!kmFilled && emptyInputs.length >= 1) {
          await emptyInputs[0].fill(String(kmStand));
          kmFilled = true;
          console.log('[Warranty] Kilometerstand ingevuld in eerste lege veld');
        }
        if (!emailFilled && emptyInputs.length >= 2) {
          await emptyInputs[1].fill(customerEmail);
          emailFilled = true;
          console.log('[Warranty] E-mailadres ingevuld in tweede lege veld');
        }
      }
    }

    if (!kmFilled || !emailFilled) {
      console.log(`[Warranty] Formulier incompleet: km=${kmFilled}, email=${emailFilled}`);
      await warrantyPage.screenshot({ path: `warranty-form-debug-${Date.now()}.png` });
      await browser.close();
      return { status: 'error', vin, message: `Kon formulier niet volledig invullen (km: ${kmFilled}, email: ${emailFilled})`, vehicle: vehicleData };
    }

    // ══════════════════════════════════════════════════════════════
    // STAP 8: ALLE toggles/checkboxes aanvinken (agreement velden)
    // Zoek op formPage (kan iframe zijn) EN warrantyPage
    // Typen: mat-slide-toggle, mat-checkbox, input[type="checkbox"]
    // ══════════════════════════════════════════════════════════════
    console.log('[Warranty] STAP 8: Toggles/checkboxes...');

    // Wacht even zodat eventuele dynamische agreement-velden geladen zijn
    await formPage.waitForTimeout(2000);

    // Scroll naar beneden om eventueel verborgen velden zichtbaar te maken
    await formPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await formPage.waitForTimeout(500);

    // Diagnostiek: inventariseer ALLE toggle/checkbox elementen op formPage
    const allToggleElements = await formPage.evaluate(() => {
      const elements = [];
      document.querySelectorAll('mat-slide-toggle, .mat-slide-toggle').forEach(el => {
        elements.push({ type: 'mat-slide-toggle', checked: el.classList.contains('mat-checked'), text: el.textContent?.trim()?.substring(0, 100), id: el.id });
      });
      document.querySelectorAll('mat-checkbox, .mat-checkbox').forEach(el => {
        elements.push({ type: 'mat-checkbox', checked: el.classList.contains('mat-checkbox-checked'), text: el.textContent?.trim()?.substring(0, 100), id: el.id });
      });
      document.querySelectorAll('input[type="checkbox"]').forEach(el => {
        elements.push({ type: 'checkbox', checked: el.checked, text: (el.closest('label')?.textContent || el.parentElement?.textContent || '').trim().substring(0, 100), id: el.id, name: el.name });
      });
      return elements;
    });
    console.log(`[Warranty] Alle toggle/checkbox elementen op formPage: ${JSON.stringify(allToggleElements)}`);

    // 8a: Unchecked mat-slide-toggles aanzetten (behalve Gebruiksvoorwaarden die al aan staat)
    const uncheckedSlideToggles = await formPage.$$('mat-slide-toggle:not(.mat-checked):not(.mat-mdc-slide-toggle-checked), .mat-slide-toggle:not(.mat-checked), .mat-mdc-slide-toggle:not(.mat-mdc-slide-toggle-checked)');
    console.log(`[Warranty] ${uncheckedSlideToggles.length} unchecked slide toggles`);
    for (const toggle of uncheckedSlideToggles) {
      const text = await toggle.evaluate(el => el.textContent?.trim()?.substring(0, 80));
      await toggle.evaluate(el => {
        const label = el.querySelector('.mat-slide-toggle-label, .mdc-switch, label');
        if (label) { label.click(); } else { el.click(); }
      });
      await formPage.waitForTimeout(500);
      console.log(`[Warranty] Slide toggle aangezet: "${text}"`);
    }

    // 8b+8c GECOMBINEERD: Vind ALLE unchecked checkboxes en klik ze correct aan
    // Strategie: voor elke native input[type="checkbox"], check of het in een mat-checkbox zit.
    // Zo ja: klik de mat-checkbox wrapper (triggert Angular change detection).
    // Zo nee: klik het input element direct.
    const allCbInputs = await formPage.$$('input[type="checkbox"]');
    console.log(`[Warranty] Totaal checkbox inputs gevonden: ${allCbInputs.length}`);

    for (const cb of allCbInputs) {
      const cbInfo = await cb.evaluate(el => {
        const matCb = el.closest('mat-checkbox');
        const labelEl = el.closest('label');
        const wrapper = matCb || labelEl || el.parentElement;
        return {
          checked: el.checked,
          hasMatCheckbox: !!matCb,
          matCbCheckedClass: matCb ? (matCb.classList.contains('mat-checkbox-checked') || matCb.classList.contains('mat-mdc-checkbox-checked')) : false,
          labelText: wrapper?.textContent?.trim()?.substring(0, 80) || '',
          wrapperHTML: wrapper?.outerHTML?.substring(0, 400) || '',
          inputId: el.id,
          inputName: el.name
        };
      });
      console.log(`[Warranty] Checkbox: checked=${cbInfo.checked}, matCb=${cbInfo.hasMatCheckbox}, matCbChecked=${cbInfo.matCbCheckedClass}, text="${cbInfo.labelText}"`);
      console.log(`[Warranty] Checkbox DOM: ${cbInfo.wrapperHTML}`);

      // Skip als al aangevinkt (zowel native als Angular-level)
      if (cbInfo.checked && (!cbInfo.hasMatCheckbox || cbInfo.matCbCheckedClass)) {
        console.log(`[Warranty] Checkbox al aangevinkt, skip: "${cbInfo.labelText}"`);
        continue;
      }

      if (cbInfo.hasMatCheckbox) {
        // BELANGRIJK: Klik de mat-checkbox wrapper, NIET de native input!
        // Dit triggert Angular's interne change handler die de FormControl update.
        console.log(`[Warranty] Klik mat-checkbox wrapper voor: "${cbInfo.labelText}"`);
        await cb.evaluate(el => {
          const matCb = el.closest('mat-checkbox');
          // Probeer de label of mdc-form-field te klikken (meest betrouwbaar)
          const clickTarget = matCb.querySelector('.mdc-form-field label, .mdc-form-field, .mat-checkbox-layout, label');
          if (clickTarget) {
            clickTarget.click();
          } else {
            matCb.click();
          }
        });
        await formPage.waitForTimeout(800);

        // Verifieer of Angular het heeft opgepikt
        const afterClick = await cb.evaluate(el => {
          const matCb = el.closest('mat-checkbox');
          return {
            nativeChecked: el.checked,
            matCbChecked: matCb ? (matCb.classList.contains('mat-checkbox-checked') || matCb.classList.contains('mat-mdc-checkbox-checked')) : false,
            ariaChecked: matCb?.getAttribute('aria-checked') || el.getAttribute('aria-checked')
          };
        });
        console.log(`[Warranty] Na mat-checkbox klik: native=${afterClick.nativeChecked}, matCb=${afterClick.matCbChecked}, aria=${afterClick.ariaChecked}`);

        // Als mat-checkbox wrapper-klik niet werkte, probeer Playwright click op wrapper element
        if (!afterClick.nativeChecked || !afterClick.matCbChecked) {
          console.log('[Warranty] Mat-checkbox wrapper klik niet succesvol, probeer Playwright click...');
          const matWrapper = await cb.evaluateHandle(el => el.closest('mat-checkbox'));
          try {
            await matWrapper.asElement().click({ force: true });
            await formPage.waitForTimeout(500);
          } catch (e) {
            console.log(`[Warranty] Playwright mat-checkbox click fout: ${e.message}`);
          }
        }

        // Als het ALSNOG niet werkt, forceer native + dispatch Angular events
        const finalCheck = await cb.evaluate(el => el.checked);
        if (!finalCheck) {
          console.log('[Warranty] Forceer checkbox checked + Angular events...');
          await cb.evaluate(el => {
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            // Probeer ook Angular zone te triggeren
            const matCb = el.closest('mat-checkbox');
            if (matCb) {
              matCb.classList.add('mat-checkbox-checked', 'mat-mdc-checkbox-checked');
              matCb.setAttribute('aria-checked', 'true');
            }
          });
          await formPage.waitForTimeout(300);
        }
      } else {
        // Gewone checkbox (geen mat-checkbox wrapper) — klik direct
        console.log(`[Warranty] Klik gewone checkbox: "${cbInfo.labelText}"`);
        try {
          await cb.click({ force: true });
        } catch (e) {
          await cb.evaluate(el => el.click());
        }
        await formPage.waitForTimeout(500);
        await cb.evaluate(el => {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const isChecked = await cb.evaluate(el => el.checked);
        console.log(`[Warranty] Checkbox result: checked=${isChecked}`);
        if (!isChecked) {
          await cb.evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
        }
      }
    }

    // Als formPage !== warrantyPage, doe hetzelfde op warrantyPage
    if (formPage !== warrantyPage) {
      const wpToggles = await warrantyPage.$$('mat-slide-toggle:not(.mat-checked):not(.mat-mdc-slide-toggle-checked), .mat-slide-toggle:not(.mat-checked), .mat-mdc-slide-toggle:not(.mat-mdc-slide-toggle-checked)');
      const wpCbs = await warrantyPage.$$('input[type="checkbox"]');
      console.log(`[Warranty] warrantyPage extra: ${wpToggles.length} toggles, ${wpCbs.length} checkboxes`);
      for (const t of wpToggles) {
        await t.evaluate(el => { const l = el.querySelector('.mat-slide-toggle-label, label'); if (l) l.click(); else el.click(); });
        await warrantyPage.waitForTimeout(500);
      }
      for (const c of wpCbs) {
        const isChecked = await c.evaluate(el => el.checked);
        if (isChecked) continue;
        // Klik mat-checkbox wrapper als die er is
        await c.evaluate(el => {
          const matCb = el.closest('mat-checkbox');
          if (matCb) {
            const target = matCb.querySelector('.mdc-form-field label, .mdc-form-field, .mat-checkbox-layout, label');
            if (target) target.click(); else matCb.click();
          } else {
            el.click();
          }
        });
        await warrantyPage.waitForTimeout(500);
        await c.evaluate(el => { el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); });
      }
    }

    // ══════════════════════════════════════════════════════════════
    // STAP 8d: Verificatie + Angular form debugging vóór submit
    // ══════════════════════════════════════════════════════════════
    const verifyKm = await formPage.locator('input[type="number"]:not([disabled])').first().inputValue().catch(() => '');
    const verifyEmail = await formPage.locator('input[type="email"]:not([disabled])').first().inputValue().catch(() => '');
    console.log(`[Warranty] Pre-submit verificatie: km="${verifyKm}", email="${verifyEmail ? 'filled' : 'empty'}"`);

    // Hercheck alle toggle/checkbox states na aanvinken
    const postToggleState = await formPage.evaluate(() => {
      const items = [];
      document.querySelectorAll('mat-slide-toggle, .mat-slide-toggle, .mat-mdc-slide-toggle').forEach(el => {
        items.push({ type: 'slide', checked: el.classList.contains('mat-checked') || el.classList.contains('mat-mdc-slide-toggle-checked'), text: el.textContent?.trim()?.substring(0, 60) });
      });
      document.querySelectorAll('mat-checkbox, .mat-checkbox, .mat-mdc-checkbox').forEach(el => {
        items.push({ type: 'matcb', checked: el.classList.contains('mat-checkbox-checked') || el.classList.contains('mat-mdc-checkbox-checked'), text: el.textContent?.trim()?.substring(0, 60) });
      });
      document.querySelectorAll('input[type="checkbox"]').forEach(el => {
        items.push({ type: 'cb', checked: el.checked, text: (el.closest('label') || el.closest('mat-checkbox') || el.parentElement)?.textContent?.trim()?.substring(0, 60) || '' });
      });
      return items;
    });
    console.log(`[Warranty] Post-toggle state: ${JSON.stringify(postToggleState)}`);

    // Als er nog unchecked checkboxes zijn, forceer ze
    const stillUnchecked = postToggleState.filter(t => t.type === 'cb' && !t.checked);
    if (stillUnchecked.length > 0) {
      console.log(`[Warranty] WAARSCHUWING: ${stillUnchecked.length} checkbox(es) nog steeds unchecked, forceer...`);
      await formPage.evaluate(() => {
        document.querySelectorAll('input[type="checkbox"]:not(:checked)').forEach(el => {
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
      await formPage.waitForTimeout(500);
    }

    // ══════════════════════════════════════════════════════════════
    // STAP 8e: Angular form validatie debugging
    // ══════════════════════════════════════════════════════════════
    const angularDebug = await formPage.evaluate(() => {
      const result = {};

      // 1. Zoek alle ng-invalid elementen (= Angular form controls die niet valid zijn)
      const invalids = [];
      document.querySelectorAll('.ng-invalid:not(form):not(fieldset)').forEach(el => {
        invalids.push({
          tag: el.tagName?.toLowerCase(),
          type: el.type || '',
          name: el.name || '',
          id: el.id || '',
          classes: el.className?.substring(0, 150),
          text: el.textContent?.trim()?.substring(0, 60) || '',
          value: el.value !== undefined ? String(el.value).substring(0, 50) : '',
          checked: el.checked,
          hidden: el.hidden || el.offsetParent === null,
          required: el.required || el.hasAttribute('required')
        });
      });
      result.invalidControls = invalids;

      // 2. Check of het hele form valid is
      const form = document.querySelector('form');
      if (form) {
        result.formValid = form.checkValidity();
        result.formClasses = form.className?.substring(0, 100);
        result.formNgInvalid = form.classList.contains('ng-invalid');
      }

      // 3. Check submit button state
      const submitBtns = Array.from(document.querySelectorAll('button'));
      result.buttons = submitBtns.map(b => ({
        text: b.textContent?.trim()?.substring(0, 40),
        disabled: b.disabled,
        type: b.type,
        classes: b.className?.substring(0, 100)
      }));

      // 4. Zoek Angular error messages (mat-error, mat-hint met error)
      const errors = [];
      document.querySelectorAll('mat-error, .mat-error, .mat-mdc-form-field-error, [role="alert"]').forEach(el => {
        errors.push(el.textContent?.trim()?.substring(0, 100));
      });
      result.errorMessages = errors;

      // 5. Probeer Angular form controls te inspecteren via ng.getComponent
      try {
        if (typeof ng !== 'undefined' && ng.getComponent) {
          const formEl = document.querySelector('form');
          if (formEl) {
            const comp = ng.getComponent(formEl) || ng.getOwningComponent(formEl);
            if (comp) {
              // Zoek reactive form properties
              for (const key of Object.keys(comp)) {
                const val = comp[key];
                if (val && val.controls) {
                  const controls = {};
                  for (const [name, ctrl] of Object.entries(val.controls)) {
                    controls[name] = { valid: ctrl.valid, value: ctrl.value, errors: ctrl.errors };
                  }
                  result.angularFormControls = controls;
                  break;
                }
              }
            }
          }
        }
      } catch (e) {
        result.ngError = e.message;
      }

      // 6. Zoek alle form-field wrappers met error state
      const matFormFields = [];
      document.querySelectorAll('mat-form-field').forEach(el => {
        const hasError = el.classList.contains('mat-form-field-invalid') || el.classList.contains('mat-mdc-form-field-error');
        if (hasError) {
          matFormFields.push({
            label: el.querySelector('mat-label, label')?.textContent?.trim()?.substring(0, 60),
            error: el.querySelector('mat-error')?.textContent?.trim()
          });
        }
      });
      result.invalidFormFields = matFormFields;

      return result;
    });
    console.log(`[Warranty] ANGULAR FORM DEBUG: ${JSON.stringify(angularDebug)}`);

    // Als er ng-invalid controls zijn, probeer ze te fixen
    if (angularDebug.invalidControls && angularDebug.invalidControls.length > 0) {
      console.log(`[Warranty] ${angularDebug.invalidControls.length} ongeldige Angular form controls gevonden!`);

      // Probeer Angular form controls programmatisch te zetten via ng API
      const fixResult = await formPage.evaluate(() => {
        try {
          if (typeof ng === 'undefined' || !ng.getComponent) return 'ng API niet beschikbaar';

          const formEl = document.querySelector('form');
          if (!formEl) return 'geen form element';

          const comp = ng.getComponent(formEl) || ng.getOwningComponent(formEl);
          if (!comp) return 'geen Angular component gevonden';

          // Zoek het FormGroup object
          let formGroup = null;
          for (const key of Object.keys(comp)) {
            const val = comp[key];
            if (val && val.controls && typeof val.markAllAsTouched === 'function') {
              formGroup = val;
              break;
            }
          }
          if (!formGroup) return 'geen FormGroup gevonden';

          // Zet alle boolean controls op true (voor checkboxes/toggles)
          const fixed = [];
          for (const [name, ctrl] of Object.entries(formGroup.controls)) {
            if (!ctrl.valid && (ctrl.value === false || ctrl.value === null || ctrl.value === '')) {
              if (typeof ctrl.value === 'boolean' || ctrl.value === null) {
                ctrl.setValue(true);
                fixed.push(name);
              }
            }
          }
          return fixed.length > 0 ? `Fixed controls: ${fixed.join(', ')}` : 'geen fixbare controls';
        } catch (e) {
          return `fix error: ${e.message}`;
        }
      });
      console.log(`[Warranty] Angular form fix poging: ${fixResult}`);
      await formPage.waitForTimeout(500);
    }

    // ══════════════════════════════════════════════════════════════
    // STAP 9: Submit met retry (CEM backend kan timeout geven)
    // ══════════════════════════════════════════════════════════════
    const MAX_SUBMIT_ATTEMPTS = 5;
    const RETRY_DELAYS = [30000, 60000, 120000, 180000]; // Exponential backoff: 30s, 60s, 2min, 3min
    let submitResult = null;

    for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
      console.log(`[Warranty] Submit poging ${attempt}/${MAX_SUBMIT_ATTEMPTS}...`);

      // Zoek submit knop
      let submitBtn = await formPage.$('button:has-text("Indienen"), input[value*="Indienen"], button:has-text("Submit"), input[type="submit"]');
      if (!submitBtn && formPage !== warrantyPage) {
        submitBtn = await warrantyPage.$('button:has-text("Indienen"), input[value*="Indienen"], button:has-text("Submit"), input[type="submit"]');
      }
      if (!submitBtn) {
        const allBtns = await formPage.$$('button');
        for (const btn of allBtns) {
          const txt = await btn.evaluate(el => el.textContent?.trim()?.toLowerCase());
          if (txt && (txt.includes('indienen') || txt.includes('submit') || txt.includes('bevestig'))) {
            submitBtn = btn;
            break;
          }
        }
      }
      if (!submitBtn) {
        console.log('[Warranty] Indienen-knop niet gevonden');
        submitResult = { status: 'error', message: 'Indienen-knop niet gevonden' };
        break;
      }

      // Klik submit
      await submitBtn.click();
      console.log('[Warranty] Indienen geklikt, wachten op resultaat...');

      // Wacht op response (snackbar/dialog of pagina-wijziging)
      await warrantyPage.waitForTimeout(5000);

      // Check voor overlay/dialog/snackbar
      const overlayText = await warrantyPage.evaluate(() => {
        const overlay = document.querySelector('.cdk-overlay-container');
        return overlay?.textContent?.trim()?.substring(0, 300) || '';
      }).catch(() => '');
      console.log(`[Warranty] Overlay tekst na submit: "${overlayText}"`);

      // ── CEM TIMEOUT: "CEM reageert niet" → klik OK en retry ──
      if (/CEM reageert niet|CEM ne répond pas|CEM is not responding/i.test(overlayText)) {
        console.log(`[Warranty] CEM backend timeout (poging ${attempt}) — klik OK en probeer opnieuw`);

        // Klik de OK knop in de dialog
        const okBtn = await warrantyPage.$('.cdk-overlay-container button, .cdk-overlay-container [role="button"]');
        if (okBtn) {
          await okBtn.click();
          console.log('[Warranty] OK knop geklikt, dialog gesloten');
        } else {
          // Probeer via tekst
          await warrantyPage.evaluate(() => {
            const btns = document.querySelectorAll('.cdk-overlay-container button, .cdk-overlay-container a');
            for (const b of btns) {
              if (b.textContent?.trim() === 'OK') { b.click(); break; }
            }
          });
        }
        await warrantyPage.waitForTimeout(2000);

        if (attempt < MAX_SUBMIT_ATTEMPTS) {
          const delay = RETRY_DELAYS[attempt - 1] || 60000;
          console.log(`[Warranty] Wacht ${delay / 1000}s voor retry ${attempt + 1}...`);
          await warrantyPage.waitForTimeout(delay);
          continue; // Retry
        } else {
          submitResult = { status: 'error', message: `CEM backend reageert niet na ${MAX_SUBMIT_ATTEMPTS} pogingen` };
          break;
        }
      }

      // ── Wacht extra op networkidle ──
      await warrantyPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await warrantyPage.waitForTimeout(2000);

      // Re-check overlay (kan alsnog verschijnen na networkidle)
      const overlayText2 = await warrantyPage.evaluate(() => {
        const overlay = document.querySelector('.cdk-overlay-container');
        return overlay?.textContent?.trim()?.substring(0, 300) || '';
      }).catch(() => '');

      if (/CEM reageert niet|CEM ne répond pas|CEM is not responding/i.test(overlayText2)) {
        console.log(`[Warranty] CEM timeout na wachten (poging ${attempt})`);
        const okBtn = await warrantyPage.$('.cdk-overlay-container button');
        if (okBtn) await okBtn.click();
        await warrantyPage.waitForTimeout(2000);
        if (attempt < MAX_SUBMIT_ATTEMPTS) {
          const delay = RETRY_DELAYS[attempt - 1] || 60000;
          console.log(`[Warranty] Wacht ${delay / 1000}s voor retry ${attempt + 1}...`);
          await warrantyPage.waitForTimeout(delay);
          continue;
        }
        submitResult = { status: 'error', message: `CEM backend reageert niet na ${MAX_SUBMIT_ATTEMPTS} pogingen` };
        break;
      }

      // ── Check resultaat ──
      const resultText = await warrantyPage.evaluate(() => document.body?.innerText || '');
      console.log(`[Warranty] Resultaat (poging ${attempt}): ${resultText.substring(0, 500)}`);

      // Contract-ID extraheren
      let contractId = null;
      const contractMatch = resultText.match(/contract aangemaakt met ID[:\s]*([A-Z0-9\-]+)/i)
        || resultText.match(/contract[:\s]+ID[:\s]*([A-Z0-9\-]+)/i)
        || resultText.match(/contract(?:\s+is)?\s+(?:aangemaakt|created)[^]*?(?:ID|nummer)[:\s]*([A-Z0-9\-]+)/i);
      if (contractMatch) contractId = contractMatch[1];

      // Succes via pagina tekst
      if (/contract aangemaakt met ID|contract has been created|contract is aangemaakt|succesvol geactiveerd|successfully activated/i.test(resultText)) {
        console.log(`[Warranty] 2+6 activatie GELUKT voor ${vin}`);
        submitResult = {
          status: 'activated',
          message: '2+6 garantie succesvol geactiveerd',
          contract_id: contractId,
          result_text: resultText.substring(0, 500)
        };
        break;
      }

      // Succes via snackbar (bijv. toast met bevestiging)
      if (overlayText && /succes|gelukt|aangemaakt|created|contract|activat/i.test(overlayText) && !/fout|error|mislukt|failed|reageert niet/i.test(overlayText)) {
        console.log(`[Warranty] 2+6 activatie GELUKT via overlay voor ${vin}`);
        submitResult = {
          status: 'activated',
          message: '2+6 garantie succesvol geactiveerd',
          contract_id: contractId,
          result_text: resultText.substring(0, 500)
        };
        break;
      }

      // Al eerder geactiveerd
      if (/al geactiveerd|already activated|bestaat al|reeds ingediend|already submitted/i.test(resultText)) {
        console.log(`[Warranty] Was al geactiveerd voor ${vin}`);
        submitResult = {
          status: 'already_activated',
          message: 'Garantie was al geactiveerd',
          contract_id: contractId,
          result_text: resultText.substring(0, 500)
        };
        break;
      }

      // Form state check
      const formState = await formPage.evaluate(() => {
        const form = document.querySelector('form');
        if (!form) return {};
        return {
          ngPristine: form.classList.contains('ng-pristine'),
          ngValid: form.classList.contains('ng-valid'),
          ngInvalid: form.classList.contains('ng-invalid'),
          ngDirty: form.classList.contains('ng-dirty')
        };
      }).catch(() => ({}));

      // Form reset naar pristine + VIN weg = succesvol ingediend
      const vinStillOnPage = resultText.includes(vin);
      if (formState.ngPristine && formState.ngValid && !vinStillOnPage) {
        console.log(`[Warranty] 2+6 activatie GELUKT (form reset) voor ${vin}`);
        submitResult = {
          status: 'activated',
          message: '2+6 garantie succesvol geactiveerd (form reset na submit)',
          contract_id: contractId,
          result_text: resultText.substring(0, 500)
        };
        break;
      }

      // Form is ng-invalid = verplicht veld niet gevuld
      if (formState.ngInvalid) {
        console.log(`[Warranty] Formulier ng-invalid na submit`);
        submitResult = {
          status: 'error',
          message: 'Formulier niet ingediend (verplicht veld niet gevuld)',
          result_text: resultText.substring(0, 500)
        };
        break;
      }

      // Andere fout via overlay
      if (overlayText && /fout|error|mislukt|failed|ongeldig|invalid/i.test(overlayText)) {
        console.log(`[Warranty] Fout via overlay: "${overlayText}"`);
        // Klik OK als er een knop is
        const okBtn2 = await warrantyPage.$('.cdk-overlay-container button');
        if (okBtn2) await okBtn2.click();
        await warrantyPage.waitForTimeout(1000);
        if (attempt < MAX_SUBMIT_ATTEMPTS) continue;
        submitResult = {
          status: 'error',
          message: `Formulier fout: ${overlayText.substring(0, 100)}`,
          result_text: resultText.substring(0, 500)
        };
        break;
      }

      // Geen duidelijk resultaat — als we nog retries hebben, probeer opnieuw
      if (attempt < MAX_SUBMIT_ATTEMPTS) {
        console.log(`[Warranty] Geen duidelijk resultaat, retry ${attempt + 1}...`);
        await warrantyPage.waitForTimeout(3000);
        continue;
      }

      // Laatste poging zonder resultaat
      submitResult = {
        status: 'error',
        message: 'Geen bevestiging van contract aangemaakt gevonden',
        result_text: resultText.substring(0, 500)
      };
    }

    // Return het resultaat
    await browser.close();
    return {
      ...submitResult,
      vin,
      vehicle: vehicleData,
      km_stand: kmStand
    };

  } catch (error) {
    console.error(`[Warranty] Error: ${error.message}`);
    console.error(`[Warranty] Stack: ${error.stack?.substring(0, 500)}`);
    try {
      await page.screenshot({ path: `error-warranty-${Date.now()}.png` });
    } catch (e) { /* ignore */ }
    await browser.close();
    throw new Error(sanitizeErrorMessage(error.message));
  }
}

/**
 * Alleen service-frequentie ophalen via Documentatie PDF.
 * Snelle modus voor bulk lookups: login → kenteken zoeken → Documentatie PDF → km/maanden.
 * Skipt: recalls, Menu Pricing, ESA, interval extractie.
 */
async function scrapeFrequencyOnly(kenteken, credentials = {}) {
  const headless = process.env.HEADLESS !== 'false';
  const slowMo = parseInt(process.env.SLOW_MO || '0');
  const debugLog = [];
  const USERNAME = credentials.username;
  const PASSWORD = credentials.password;

  if (!USERNAME || !PASSWORD) {
    throw new Error('Servicebox credentials zijn verplicht. Stel deze in via Instellingen.');
  }

  console.log(`[FrequencyOnly] Start frequentie-only scrape voor kenteken: ${kenteken}`);
  console.log(`[FrequencyOnly] Headless: ${headless}, SlowMo: ${slowMo}`);
  console.log(`[FrequencyOnly] Credentials: ${USERNAME}`);

  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    httpCredentials: {
      username: USERNAME,
      password: PASSWORD
    }
  });

  const page = await context.newPage();

  try {
    // STAP 1: Login
    await login(page, USERNAME, PASSWORD);

    // STAP 2: Zoek voertuig (nodig om VIN te krijgen + DOCUMENTATIE tab beschikbaar te maken)
    const vehicleData = await searchAndExtractVehicle(page, kenteken);
    const vin = vehicleData?.vin || null;

    if (!vin) {
      console.log('[FrequencyOnly] Geen VIN gevonden, kan Documentatie niet openen');
      return {
        service_frequency: null,
        service_frequency_km: null,
        service_frequency_months: null,
        service_frequency_source: null,
        vin: null,
        error: 'Geen VIN gevonden voor dit kenteken',
        debug_log: debugLog
      };
    }

    console.log(`[FrequencyOnly] VIN gevonden: ${vin}, start Documentatie extractie...`);

    // STAP 3: Alleen Documentatie PDF extractie — pass debugLog for diagnostics
    const freq = await extractFrequencyFromDocumentation(page, context, vin, debugLog);

    console.log(`[FrequencyOnly] Resultaat: ${freq ? `${freq.km} km / ${freq.months} maanden` : 'geen frequentie gevonden'}`);

    return {
      service_frequency: freq,
      service_frequency_km: freq?.km || null,
      service_frequency_months: freq?.months || null,
      service_frequency_source: freq?.source || null,
      vin,
      debug_log: debugLog
    };

  } catch (error) {
    console.error('[FrequencyOnly] Error:', error.message);
    throw new Error(sanitizeErrorMessage(error.message));
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeServicebox, scrapeQuotelink, activateWarranty, scrapeFrequencyOnly };
