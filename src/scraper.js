const { chromium } = require('playwright');

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
const USERNAME = process.env.SERVICEBOX_USERNAME;
const PASSWORD = process.env.SERVICEBOX_PASSWORD;

async function scrapeServicebox(kenteken, kmStand) {
  const headless = process.env.HEADLESS !== 'false';
  const slowMo = parseInt(process.env.SLOW_MO || '0');

  console.log(`[Scraper] Start scrape voor kenteken: ${kenteken}, km: ${kmStand || 'n.v.t.'}`);
  console.log(`[Scraper] Headless: ${headless}, SlowMo: ${slowMo}`);

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
    await login(page);

    // STAP 2: Zoek voertuig op kenteken
    const vehicleData = await searchAndExtractVehicle(page, kenteken);

    // STAP 3: Extract recalls (klik op Terugroepacties tab)
    const recalls = await extractRecalls(page);

    // STAP 4: Ga terug naar Auto tab, klik Menu pricing → extract onderhoud
    const { intervals, interval_pricing, prices } = await extractMaintenance(page, context, kmStand);

    console.log('[Scraper] Scrape voltooid!');
    return { vehicle: vehicleData, recalls, intervals, interval_pricing, prices };

  } catch (error) {
    console.error('[Scraper] Error:', error.message);
    try {
      await page.screenshot({ path: `error-${Date.now()}.png` });
      console.log('[Scraper] Error screenshot opgeslagen');
    } catch (e) { /* ignore */ }
    throw error;
  } finally {
    await browser.close();
  }
}

// =========================================
// LOGIN (HTTP credentials + SSO fallback)
// =========================================
async function login(page) {
  console.log('[Login] Navigeren naar Servicebox...');
  await page.goto(SERVICEBOX_URL, { waitUntil: 'networkidle', timeout: 30000 });
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
  await usernameField.fill(USERNAME);

  // Password
  const passwordField = await page.$('input[type="password"]');
  if (passwordField) {
    await passwordField.fill(PASSWORD);
  } else {
    // Multi-step: submit username, dan password
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const pwField = await page.$('input[type="password"]');
    if (pwField) await pwField.fill(PASSWORD);
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
  await page.waitForTimeout(5000);

  // Extract vehicle data — 4 attempts
  let vehicleData = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`[Vehicle] Poging ${attempt}/4 om voertuigdata te extraheren...`);
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
        if (!bodyText.includes(searchKenteken)) return null;

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
async function extractMaintenance(page, context, kmStand) {
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
      return { intervals: [], prices: [] };
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
    console.log('[Maintenance] Geen Menu pricing pagina gevonden in open vensters');
    return { intervals: [], prices: [] };
  }

  console.log(`[Maintenance] Menu pricing gevonden: ${menuPricingPage.url()}`);
  await menuPricingPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await menuPricingPage.waitForTimeout(3000);

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

  // Screenshot voor debugging
  await menuPricingPage.screenshot({ path: 'menupricing-debug.png' });
  console.log('[Maintenance] Screenshot opgeslagen: menupricing-debug.png');

  // Log pagina-inhoud voor debugging (clean whitespace)
  const pageText = await menuPricingPage.evaluate(() => {
    return (document.body?.innerText || '').replace(/[\t]+/g, ' ').replace(/\n{3,}/g, '\n\n').substring(0, 3000);
  });
  console.log('[Maintenance] Pagina tekst (eerste 1500 chars):', pageText.substring(0, 1500));

  // Extract intervallen
  const intervals = await extractIntervals(menuPricingPage);

  // Extract prijzen PER INTERVAL (klik elk interval, lees offerte-tabel)
  const interval_pricing = await extractPricesPerInterval(menuPricingPage, intervals);

  // Extract de volledige servicecatalogus (alle beschikbare items)
  const prices = await extractPricesByCategory(menuPricingPage);

  // Sluit popup
  await menuPricingPage.close();

  return { intervals, interval_pricing, prices };
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

    // Klik op het interval-element
    let clicked = false;
    for (const frame of framesToUse) {
      try {
        // Zoek het klikbare element met de intervaltekst
        const elements = await frame.$$('a, button, span, td, option, label, div, li');
        for (const el of elements) {
          const text = (await el.textContent()).trim();
          // Match exacte interval-label of km-waarde
          const kmNum = interval.label.replace(/[.\s]?000\s*KM$/i, '');
          if (text === interval.label ||
              text.includes(kmNum + '.000') ||
              text.includes(kmNum + ' 000') ||
              (interval.type === 'yearly' && /jaarlijks/i.test(text))) {
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

    // Wacht op server-side berekening (AJAX)
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // Extract de prijsdata uit de offerte-tabel / rechter paneel
    let pricing = null;
    for (const frame of framesToUse) {
      try {
        pricing = await frame.evaluate(() => {
          function clean(t) { return (t || '').replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim(); }

          // Zoek prijzen in tabellen
          const items = [];
          let totalLabor = null;
          let totalParts = null;
          let totalPrice = null;

          // === STRATEGIE 1: Zoek offerte-tabel (table met bedragen) ===
          const tables = document.querySelectorAll('table');
          for (const table of tables) {
            const rows = table.querySelectorAll('tr');
            for (const row of rows) {
              const cells = Array.from(row.querySelectorAll('td, th'));
              const texts = cells.map(c => clean(c.textContent));

              // Zoek rijen met prijzen (€ of decimale bedragen)
              const pricePattern = /(\d+[.,]\d{2})\s*€?|€\s*(\d+[.,]\d{2})/;
              const hasPrices = texts.some(t => pricePattern.test(t));

              if (hasPrices && texts.length >= 2) {
                // Dit is een prijsrij — eerste cel is naam, rest zijn bedragen
                const name = texts[0];
                const prices = texts.slice(1).map(t => {
                  const match = t.match(/(\d+[.,]\d{2})/);
                  return match ? parseFloat(match[1].replace(',', '.')) : null;
                }).filter(p => p !== null);

                if (name && prices.length > 0) {
                  items.push({
                    name: name,
                    prices: prices,
                    labor: prices[0] || 0,
                    parts: prices[1] || 0,
                    total: prices[prices.length - 1] || 0
                  });
                }
              }

              // Zoek totaalrij
              const rowText = clean(row.textContent).toLowerCase();
              if (rowText.includes('totaal') || rowText.includes('total')) {
                const allPrices = texts.map(t => {
                  const m = t.match(/(\d+[.,]\d{2})/);
                  return m ? parseFloat(m[1].replace(',', '.')) : null;
                }).filter(p => p !== null);
                if (allPrices.length > 0) {
                  totalPrice = allPrices[allPrices.length - 1];
                  if (allPrices.length >= 2) {
                    totalLabor = allPrices[0];
                    totalParts = allPrices.length >= 3 ? allPrices[1] : null;
                  }
                }
              }
            }
          }

          // === STRATEGIE 2: Zoek geselecteerde/aangevinkte items ===
          if (items.length === 0) {
            // Zoek checkboxes die aangevinkt zijn + bijbehorende tekst
            const checked = document.querySelectorAll('input[type="checkbox"]:checked');
            for (const cb of checked) {
              const parent = cb.closest('tr, div, li, label');
              if (parent) {
                const text = clean(parent.textContent);
                const priceMatch = text.match(/(\d+[.,]\d{2})/);
                if (text.length > 2) {
                  items.push({
                    name: text.replace(/(\d+[.,]\d{2})/g, '').trim(),
                    total: priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : 0
                  });
                }
              }
            }
          }

          // === STRATEGIE 3: Zoek losse prijs-elementen ===
          if (items.length === 0) {
            // Zoek divs/spans met prijzen
            const allEls = document.querySelectorAll('div, span, td, p');
            for (const el of allEls) {
              const text = clean(el.textContent);
              // Zoek "Totaal: € 123,45" of "Total: 123.45 €"
              if (/totaa?l/i.test(text)) {
                const m = text.match(/(\d+[.,]\d{2})/);
                if (m) totalPrice = parseFloat(m[1].replace(',', '.'));
              }
            }
          }

          // === STRATEGIE 4: Zoek in de offerte/quote samenvatting ===
          if (items.length === 0 && !totalPrice) {
            // Zoek specifieke Quotelink elementen
            const summaryEls = document.querySelectorAll(
              '.quote-summary, .offerte, .pricing-summary, ' +
              '[class*="price"], [class*="total"], [class*="summary"], ' +
              '[id*="price"], [id*="total"], [id*="quote"]'
            );
            for (const el of summaryEls) {
              const text = clean(el.textContent);
              if (text.length > 2 && text.length < 500) {
                const m = text.match(/(\d+[.,]\d{2})/);
                if (m) {
                  items.push({ name: text.substring(0, 100), total: parseFloat(m[1].replace(',', '.')) });
                }
              }
            }
          }

          // Debug: log page state
          const bodyText = (document.body?.innerText || '').substring(0, 2000);
          const hasPriceOnPage = /\d+[.,]\d{2}/.test(bodyText);

          return {
            items,
            total_labor: totalLabor,
            total_parts: totalParts,
            total_price: totalPrice,
            _debug: {
              items_found: items.length,
              has_price_on_page: hasPriceOnPage,
              page_text_preview: bodyText.substring(0, 500)
            }
          };
        });

        if (pricing && (pricing.items.length > 0 || pricing.total_price)) break;
      } catch (e) { continue; }
    }

    if (pricing) {
      console.log(`[IntervalPricing] ${interval.label}: ${pricing.items.length} items, totaal: ${pricing.total_price || 'onbekend'}`);
      if (pricing.items.length === 0 && !pricing.total_price) {
        console.log(`[IntervalPricing] Debug: ${pricing._debug.page_text_preview.substring(0, 200)}`);
      }
      results.push({
        interval: interval.label,
        interval_type: interval.type,
        items: pricing.items,
        total_labor: pricing.total_labor,
        total_parts: pricing.total_parts,
        total_price: pricing.total_price
      });
    } else {
      console.log(`[IntervalPricing] ${interval.label}: geen data gevonden`);
      results.push({
        interval: interval.label,
        interval_type: interval.type,
        items: [],
        total_labor: null,
        total_parts: null,
        total_price: null
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
async function scrapeQuotelink(vin, kmStand) {
  const headless = process.env.HEADLESS !== 'false';
  const slowMo = parseInt(process.env.SLOW_MO || '0');

  console.log(`[Quotelink] Start VIN lookup: ${vin}, km: ${kmStand || 'n.v.t.'}`);
  console.log(`[Quotelink] Headless: ${headless}, SlowMo: ${slowMo}`);

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
    await login(page);

    // STAP 2: Zoek voertuig op VIN (zelfde flow als kenteken)
    const vehicleData = await searchAndExtractVehicle(page, vin);

    // STAP 3: Skip recalls — ga direct naar Menu pricing
    const { intervals, interval_pricing, prices } = await extractMaintenance(page, context, kmStand);

    console.log('[Quotelink] VIN lookup voltooid!');
    return {
      vehicle: vehicleData,
      recalls: [],  // Niet opgehaald bij VIN-only lookup
      intervals,
      interval_pricing,
      prices
    };

  } catch (error) {
    console.error('[Quotelink] Error:', error.message);
    try {
      await page.screenshot({ path: `error-vin-${Date.now()}.png` });
    } catch (e) { /* ignore */ }
    throw error;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeServicebox, scrapeQuotelink };
