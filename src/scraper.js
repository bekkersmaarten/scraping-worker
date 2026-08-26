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
    const { intervals, interval_pricing, prices, service_frequency } = await extractMaintenance(page, context, kmStand);

    console.log('[Scraper] Scrape voltooid!');
    return { vehicle: vehicleData, recalls, intervals, interval_pricing, prices, service_frequency };

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
      return { intervals: [], prices: [], interval_pricing: [], service_frequency: null };
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
    return { intervals: [], prices: [], interval_pricing: [], service_frequency: null };
  }

  console.log(`[Maintenance] Menu pricing gevonden: ${menuPricingPage.url()}`);
  await menuPricingPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await menuPricingPage.waitForTimeout(3000);

  // ── Probeer frequentie VÓÓR "GA VERDER" te extraheren ──
  // Op sommige systemen (Opel/Vauxhall) staat de frequentie op de Vehicle-pagina
  console.log('[Maintenance] Frequentie zoeken VOOR GA VERDER...');
  let serviceFrequency = await extractServiceFrequency(menuPricingPage);
  if (serviceFrequency) {
    console.log('[Maintenance] Frequentie gevonden op Vehicle-pagina (voor GA VERDER)!');
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

  return { intervals, interval_pricing, prices, service_frequency: serviceFrequency };
}

// =========================================
// SERVICE FREQUENTIE (km + maanden)
// =========================================
/**
 * Extraheert de "Gebruikelijke frequentie" uit de Quotelink pagina.
 * Formaat op pagina: "Elk 25000 Km / 1 jaar" of "Elk 15000 Km / 1 jaar"
 *
 * De pagina toont twee kolommen:
 *   - "Normale gebruiksomstandigheden" → bijv. Elk 25000 Km / 1 jaar
 *   - "Zware gebruiksomstandigheden" → bijv. Elk 15000 Km / 1 jaar
 *
 * Returns: { km: 25000, months: 12, km_heavy: 15000, months_heavy: 12, raw: "..." }
 */
async function extractServiceFrequency(page) {
  console.log('[Frequency] Extracting service frequentie...');

  // Check ALLE frames (inclusief cross-origin via Playwright)
  const allFrames = page.frames();
  const framesToCheck = allFrames.length > 0 ? allFrames : [page.mainFrame()];
  console.log(`[Frequency] ${framesToCheck.length} frames te checken`);

  for (let fi = 0; fi < framesToCheck.length; fi++) {
    const frame = framesToCheck[fi];
    try {
      const frameUrl = frame.url();
      const freq = await frame.evaluate(() => {
        const bodyText = document.body?.innerText || '';

        if (bodyText.trim().length < 20) {
          return { error: 'empty_frame', text: bodyText.trim() };
        }

        // Zoek het patroon — meerdere varianten:
        // "Elk 25000 Km / 1 jaar"
        // "Elke 30.000 km / 12 maanden"
        // "Tous les 30000 Km / 1 an" (Frans)
        // "Every 30000 Km / 1 year"
        // Opel/Vauxhall varianten:
        // "30 000 km of 12 maanden" / "30.000 km of 12 maanden"
        // "30000 km / 12 months" / "30 000 km ou 12 mois"
        const patterns = [
          /Elk[e]?\s+(\d[\d. ]*)\s*[Kk][Mm]?\s*\/\s*(\d+)\s*(jaar|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          /[Tt]ous\s+les\s+(\d[\d. ]*)\s*[Kk][Mm]?\s*\/\s*(\d+)\s*(jaar|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          /[Ee]very\s+(\d[\d. ]*)\s*[Kk][Mm]?\s*\/\s*(\d+)\s*(jaar|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          // Opel-style: "30.000 km of 12 maanden" / "30 000 km ou 12 mois"
          /(\d[\d. ]{3,})\s*[Kk][Mm]\s*(?:of|ou|or)\s*(\d+)\s*(jaar|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          // Fallback: gewoon een getal gevolgd door km / getal gevolgd door jaar/maand
          /(\d[\d. ]{3,})\s*[Kk][Mm]\s*\/\s*(\d+)\s*(jaar|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          // "Gebruikelijke frequentie" sectie met los km-getal
          /[Ff]req[a-z]*[.:]\s*(\d[\d. ]*)\s*[Kk][Mm]\s*[\/\-–]\s*(\d+)\s*(jaar|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi,
          // Nog breder: km-getal gevolgd door interval op zelfde of volgende regel
          /(\d{2,3}[.\s]?000)\s*[Kk][Mm][\s\S]{0,20}?(\d{1,2})\s*(jaar|maand(?:en)?|an[s]?|year[s]?|moi[s]?|month[s]?)/gi
        ];

        let allMatches = [];
        for (const pattern of patterns) {
          const matches = [...bodyText.matchAll(pattern)];
          if (matches.length > 0) {
            allMatches = matches;
            break;
          }
        }

        if (allMatches.length === 0) {
          // Geef de eerste 800 chars terug voor debugging
          return { error: 'no_match', text: bodyText.substring(0, 800) };
        }

        const parseMatch = (m) => {
          const km = parseInt(m[1].replace(/[. ]/g, ''));
          const period = parseInt(m[2]);
          const unit = m[3].toLowerCase();
          const months = (unit.startsWith('jaar') || unit.startsWith('year') || unit.startsWith('an')) ? period * 12 : period;
          return { km, months };
        };

        const normal = parseMatch(allMatches[0]);
        const heavy = allMatches.length > 1 ? parseMatch(allMatches[1]) : null;

        return {
          km: normal.km,
          months: normal.months,
          km_heavy: heavy ? heavy.km : null,
          months_heavy: heavy ? heavy.months : null,
          raw: allMatches.map(m => m[0]).join(' | ')
        };
      });

      if (freq && freq.error === 'empty_frame') {
        console.log(`[Frequency] Frame ${fi} (${frameUrl.substring(0, 80)}): leeg/te kort (${freq.text.length} chars)`);
        continue;
      }

      if (freq && freq.error === 'no_match') {
        console.log(`[Frequency] Frame ${fi} (${frameUrl.substring(0, 80)}): geen match. Tekst: ${freq.text.substring(0, 300)}`);
        continue;
      }

      if (freq) {
        console.log(`[Frequency] GEVONDEN in frame ${fi} (${frameUrl.substring(0, 80)})`);
        console.log(`[Frequency] Normaal: ${freq.km} km / ${freq.months} maanden`);
        if (freq.km_heavy) {
          console.log(`[Frequency] Zwaar: ${freq.km_heavy} km / ${freq.months_heavy} maanden`);
        }
        return freq;
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
    const { intervals, interval_pricing, prices, service_frequency } = await extractMaintenance(page, context, kmStand);

    console.log('[Quotelink] VIN lookup voltooid!');
    return {
      vehicle: vehicleData,
      recalls: [],  // Niet opgehaald bij VIN-only lookup
      intervals,
      interval_pricing,
      prices,
      service_frequency
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
async function activateWarranty(vin, kmStand, customerEmail) {
  const headless = process.env.HEADLESS !== 'false';
  const slowMo = parseInt(process.env.SLOW_MO || '250');

  console.log(`[Warranty] Start 2+6 activatie: ${vin}, km: ${kmStand}, email: ${customerEmail ? '***' : 'GEEN'}`);

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
    await login(page);

    // STAP 2: Zoek voertuig op VIN
    const vehicleData = await searchAndExtractVehicle(page, vin);
    console.log(`[Warranty] Voertuig gevonden: ${JSON.stringify(vehicleData)}`);

    // STAP 3: Detecteer het StellaCare / Peugeot Care "8" pictogram
    // HTML structuur in Servicebox:
    //   <li id="ico-hub-stellaCare-grey" class="stellaCare-icons" style="display: none|list-item">
    //   <li id="ico-hub-stellaCare-green" class="stellaCare-icons" style="display: none|list-item">
    //     <a href="javascript:goTo('/stellaCare/')">
    //       <img src="/static/8.6.2/images/stellaCare-green-icon.png" title="PEUGEOT CARE">
    //     </a>
    //   </li>
    // Groen + display:list-item = klikbaar, kan geactiveerd worden
    // Grijs + display:list-item = ander land, niet klikbaar
    // Beide display:none = niet in aanmerking

    let iconFound = false;
    let iconStatus = 'not_found'; // not_found, grey, green
    let iconFrame = null;

    for (const frame of page.frames()) {
      try {
        const iconInfo = await frame.evaluate(() => {
          // Zoek de exacte StellaCare icoon-elementen
          const greenLi = document.getElementById('ico-hub-stellaCare-green');
          const greyLi = document.getElementById('ico-hub-stellaCare-grey');

          if (!greenLi && !greyLi) {
            return { found: false, reason: 'geen stellaCare elementen in dit frame' };
          }

          // Check display style om te bepalen welke zichtbaar is
          const greenDisplay = greenLi ? window.getComputedStyle(greenLi).display : 'none';
          const greyDisplay = greyLi ? window.getComputedStyle(greyLi).display : 'none';
          const greenVisible = greenDisplay !== 'none';
          const greyVisible = greyDisplay !== 'none';

          console.log(`StellaCare: green=${greenDisplay}, grey=${greyDisplay}`);

          if (greenVisible) {
            // Groen icoon zichtbaar → kan geactiveerd worden
            const link = greenLi.querySelector('a');
            const img = greenLi.querySelector('img');
            return {
              found: true,
              status: 'green',
              href: link?.getAttribute('href') || '',
              imgSrc: img?.getAttribute('src') || '',
              title: img?.getAttribute('title') || '',
              outerHTML: greenLi.outerHTML?.substring(0, 500)
            };
          } else if (greyVisible) {
            // Grijs icoon zichtbaar → ander land
            return {
              found: true,
              status: 'grey',
              outerHTML: greyLi.outerHTML?.substring(0, 500)
            };
          } else {
            // Beide aanwezig maar verborgen → niet in aanmerking
            return {
              found: true,
              status: 'hidden',
              greenDisplay,
              greyDisplay
            };
          }
        });

        if (iconInfo.found) {
          iconFound = true;
          iconStatus = iconInfo.status;
          iconFrame = frame;

          console.log(`[Warranty] StellaCare icoon gevonden: status=${iconInfo.status}`);
          if (iconInfo.outerHTML) console.log(`[Warranty] HTML: ${iconInfo.outerHTML}`);
          if (iconInfo.title) console.log(`[Warranty] Title: ${iconInfo.title}`);

          if (iconStatus === 'grey') {
            await browser.close();
            return {
              status: 'other_country',
              vin,
              message: 'Voertuig gekoppeld aan ander land (grijs icoon) — activatie niet mogelijk vanuit NL',
              vehicle: vehicleData
            };
          }

          if (iconStatus === 'hidden') {
            await browser.close();
            return {
              status: 'not_eligible',
              vin,
              message: 'StellaCare iconen aanwezig maar verborgen — voertuig komt niet in aanmerking',
              vehicle: vehicleData
            };
          }

          // GROEN → klik op het icoon
          if (iconStatus === 'green') {
            console.log(`[Warranty] Groen icoon, navigeren naar StellaCare...`);
            // De link is javascript:goTo('/stellaCare/') — dit navigeert binnen het frame
            // We moeten het klikken via het frame
            await frame.evaluate(() => {
              const link = document.querySelector('#ico-hub-stellaCare-green a');
              if (link) link.click();
            });
            console.log('[Warranty] StellaCare link aangeklikt');
          }

          break;
        }
      } catch (e) {
        // Frame niet bereikbaar, ga door naar volgende
        continue;
      }
    }

    if (!iconFound) {
      console.log('[Warranty] Geen StellaCare elementen gevonden in enig frame');
      await browser.close();
      return {
        status: 'not_eligible',
        vin,
        message: 'Geen 2+6 garantie-icoon gevonden — voertuig komt niet in aanmerking',
        vehicle: vehicleData
      };
    }

    // STAP 4: Wacht op het warranty formulier (nieuw venster of navigatie)
    console.log('[Warranty] Wachten op formulier...');
    await page.waitForTimeout(5000);

    // Als er geen nieuw venster is geopend, check of de pagina een melding toont
    if (!warrantyPage) {
      // Check of er een nieuw venster verschenen is
      const allPages = context.pages();
      for (const p of allPages) {
        const url = p.url();
        if (url.includes('allucare') || url.includes('stellacare') || url.includes('idfed')) {
          warrantyPage = p;
          break;
        }
      }
    }

    // Als er een "klik hier" link verscheen (zoals in het screenshot)
    if (!warrantyPage) {
      for (const frame of page.frames()) {
        try {
          const kliklinkClicked = await frame.evaluate(() => {
            const links = document.querySelectorAll('a');
            for (const link of links) {
              const text = (link.textContent || '').toLowerCase();
              if (text.includes('klik hier') && link.href) {
                window.open(link.href, '_blank');
                return link.href;
              }
            }
            return null;
          });
          if (kliklinkClicked) {
            console.log(`[Warranty] "Klik hier" link gevonden: ${kliklinkClicked.substring(0, 100)}`);
            await page.waitForTimeout(3000);
            const allPages = context.pages();
            warrantyPage = allPages[allPages.length - 1];
            break;
          }
        } catch (e) { continue; }
      }
    }

    if (!warrantyPage || warrantyPage.url() === 'about:blank') {
      await browser.close();
      return { status: 'error', vin, message: 'Formulier kon niet geopend worden na klik op 8-icoon', vehicle: vehicleData };
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
    // De keuze Normaal/Verzwaard is een mat-slide-toggle naast <span class="mr-1">Normaal</span>.
    // Structuur: <div class="in-column-value"><label>Gebruiksvoorwaarden</label>
    //   <div class="d-flex"><span class="mr-1">Normaal</span><mat-slide-toggle ...></div></div>
    // km/email velden zijn disabled totdat deze toggle geactiveerd is.
    // ══════════════════════════════════════════════════════════════
    console.log('[Warranty] STAP 6: Gebruiksvoorwaarden toggle activeren...');
    let gebruiksToggled = false;

    try {
      // Zoek de mat-slide-toggle die bij "Gebruiksvoorwaarden" / "Normaal" hoort
      const toggleResult = await formPage.evaluate(() => {
        // Zoek de span met "Normaal" — de toggle zit als sibling in dezelfde d-flex container
        const spans = Array.from(document.querySelectorAll('span'));
        for (const span of spans) {
          if (span.textContent?.trim() === 'Normaal' || span.textContent?.trim() === 'Normal') {
            // De mat-slide-toggle is een sibling van deze span in de d-flex parent
            const parent = span.parentElement;
            if (!parent) continue;
            const toggle = parent.querySelector('mat-slide-toggle, .mat-slide-toggle');
            if (toggle) {
              const isChecked = toggle.classList.contains('mat-checked');
              // Klik de toggle-label om te activeren (= "Normaal" kiezen)
              const label = toggle.querySelector('.mat-slide-toggle-label, label');
              if (label) { label.click(); } else { toggle.click(); }
              return { found: true, clicked: 'sibling-toggle', wasChecked: isChecked };
            }
          }
        }

        // Fallback: zoek de toggle in de "in-column-value" div die ook "Gebruiksvoorwaarden" bevat
        const valueDivs = document.querySelectorAll('.in-column-value, [class*="column-value"]');
        for (const div of valueDivs) {
          if (div.textContent?.includes('Gebruiksvoorwaarden')) {
            const toggle = div.querySelector('mat-slide-toggle, .mat-slide-toggle');
            if (toggle) {
              const isChecked = toggle.classList.contains('mat-checked');
              const label = toggle.querySelector('.mat-slide-toggle-label, label');
              if (label) { label.click(); } else { toggle.click(); }
              return { found: true, clicked: 'value-div-toggle', wasChecked: isChecked };
            }
          }
        }

        // Laatste fallback: zoek alle mat-slide-toggles en neem de eerste die niet gecheckt is
        const allToggles = document.querySelectorAll('mat-slide-toggle, .mat-slide-toggle');
        const toggleInfo = Array.from(allToggles).map((t, i) => ({
          index: i,
          id: t.id,
          checked: t.classList.contains('mat-checked'),
          text: t.closest('div')?.textContent?.trim()?.substring(0, 80) || ''
        }));

        return { found: false, allToggles: toggleInfo };
      });

      if (toggleResult.found) {
        gebruiksToggled = true;
        console.log(`[Warranty] Gebruiksvoorwaarden toggle geklikt (${toggleResult.clicked}, was checked: ${toggleResult.wasChecked})`);
      } else {
        console.log(`[Warranty] Geen Gebruiksvoorwaarden toggle gevonden. Alle toggles: ${JSON.stringify(toggleResult.allToggles)}`);
      }
    } catch (e) {
      console.log(`[Warranty] Gebruiksvoorwaarden toggle fout: ${e.message.substring(0, 200)}`);
    }

    // Wacht tot velden enabled worden na toggle
    if (gebruiksToggled) {
      await formPage.waitForTimeout(2000);

      // Verifieer toggle status
      const toggleVerify = await formPage.evaluate(() => {
        const toggles = document.querySelectorAll('mat-slide-toggle, .mat-slide-toggle');
        return Array.from(toggles).map(t => ({
          id: t.id,
          checked: t.classList.contains('mat-checked'),
          text: t.textContent?.trim()?.substring(0, 50)
        }));
      });
      console.log(`[Warranty] Toggle verificatie na wacht: ${JSON.stringify(toggleVerify)}`);

      // Check of er nu enabled input velden zijn
      const enabledInputs = await formPage.evaluate(() => {
        const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])');
        return Array.from(inputs).map(i => ({
          name: i.name, id: i.id, type: i.type, disabled: i.disabled, readOnly: i.readOnly, visible: i.offsetParent !== null
        }));
      });
      console.log(`[Warranty] Input velden na toggle: ${JSON.stringify(enabledInputs)}`);
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
    // STAP 8: Toggles/checkboxes aanvinken
    // ══════════════════════════════════════════════════════════════
    console.log('[Warranty] STAP 8: Toggles/checkboxes...');
    const slideToggles = await warrantyPage.$$('mat-slide-toggle, .mat-slide-toggle');
    console.log(`[Warranty] ${slideToggles.length} slide toggles gevonden`);

    if (slideToggles.length > 0) {
      for (const toggle of slideToggles) {
        const isChecked = await toggle.evaluate(el => el.classList.contains('mat-checked'));
        if (!isChecked) {
          await toggle.evaluate(el => {
            const label = el.querySelector('.mat-slide-toggle-label, label');
            if (label) { label.click(); } else { el.click(); }
          });
          await warrantyPage.waitForTimeout(300);
          console.log('[Warranty] Slide toggle aangezet');
        } else {
          console.log('[Warranty] Slide toggle stond al aan');
        }
      }
    } else {
      const checkboxes = await warrantyPage.$$('input[type="checkbox"]');
      console.log(`[Warranty] ${checkboxes.length} gewone checkboxes gevonden`);
      for (const cb of checkboxes) {
        const isChecked = await cb.isChecked();
        if (!isChecked) {
          const clicked = await cb.evaluate(el => {
            const label = el.closest('label') || el.parentElement;
            if (label && label !== el) { label.click(); return 'label'; }
            el.click(); return 'direct';
          });
          console.log(`[Warranty] Checkbox aangevinkt via ${clicked}`);
          await warrantyPage.waitForTimeout(300);
        }
      }
    }

    // ══════════════════════════════════════════════════════════════
    // STAP 8b: Verificatie vóór submit
    // ══════════════════════════════════════════════════════════════
    const verifyKm = await formPage.locator('input[name*="ilomet" i], input[id*="ilomet" i]').first().inputValue().catch(() => '');
    const verifyRadio = await formPage.locator('input[type="radio"]:checked').count().catch(() => 0);
    console.log(`[Warranty] Pre-submit verificatie: km="${verifyKm}", radio_checked=${verifyRadio}`);

    const missingRequired = await warrantyPage.evaluate(() => {
      const required = document.querySelectorAll('input[required], select[required]');
      const empty = [];
      for (const el of required) {
        if (el.type === 'radio') {
          const name = el.name;
          if (name && !document.querySelector(`input[type="radio"][name="${name}"]:checked`)) {
            empty.push(`radio:${name}`);
          }
        } else if (!el.value) {
          empty.push(`${el.type || 'input'}:${el.name || el.id || '?'}`);
        }
      }
      return [...new Set(empty)];
    });
    if (missingRequired.length > 0) {
      console.log(`[Warranty] WAARSCHUWING: ${missingRequired.length} verplichte velden nog leeg: ${missingRequired.join(', ')}`);
    }

    // STAP 9: Klik "Indienen"
    console.log('[Warranty] Klikken op Indienen...');
    const submitBtn = await warrantyPage.$('button:has-text("Indienen"), input[value*="Indienen"], button:has-text("Submit"), input[type="submit"]');
    if (!submitBtn) {
      await warrantyPage.screenshot({ path: `warranty-submit-debug-${Date.now()}.png` });
      await browser.close();
      return { status: 'error', vin, message: 'Indienen-knop niet gevonden', vehicle: vehicleData };
    }

    await submitBtn.click();
    await warrantyPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await warrantyPage.waitForTimeout(3000);

    // Check resultaat — alleen `activated` bij echte contractbevestiging
    const resultText = await warrantyPage.evaluate(() => document.body?.innerText || '');
    console.log(`[Warranty] Resultaat pagina: ${resultText.substring(0, 500)}`);

    // Contract-ID extraheren als beschikbaar
    let contractId = null;
    const contractMatch = resultText.match(/contract aangemaakt met ID[:\s]*([A-Z0-9\-]+)/i)
      || resultText.match(/contract[:\s]+ID[:\s]*([A-Z0-9\-]+)/i)
      || resultText.match(/contract(?:\s+is)?\s+(?:aangemaakt|created)[^]*?(?:ID|nummer)[:\s]*([A-Z0-9\-]+)/i);
    if (contractMatch) {
      contractId = contractMatch[1];
      console.log(`[Warranty] Contract ID: ${contractId}`);
    }

    // 1. Succes: contract echt aangemaakt
    if (/contract aangemaakt met ID|contract has been created|contract is aangemaakt/i.test(resultText)) {
      console.log(`[Warranty] 2+6 activatie GELUKT voor ${vin}`);
      await browser.close();
      return {
        status: 'activated',
        vin,
        message: '2+6 garantie succesvol geactiveerd',
        vehicle: vehicleData,
        km_stand: kmStand,
        contract_id: contractId,
        result_text: resultText.substring(0, 500)
      };
    }

    // 2. Al eerder geactiveerd
    if (/al geactiveerd|already activated|bestaat al|reeds ingediend|already submitted/i.test(resultText)) {
      console.log(`[Warranty] Was al geactiveerd voor ${vin}`);
      await browser.close();
      return {
        status: 'already_activated',
        vin,
        message: 'Garantie was al geactiveerd',
        vehicle: vehicleData,
        contract_id: contractId,
        result_text: resultText.substring(0, 500)
      };
    }

    // 3. Formulier nog zichtbaar → niet ingediend (bijv. Gebruiksvoorwaarden niet gevuld)
    if (/Gebruiksvoorwaarden/i.test(resultText) || /Formulier indienen/i.test(resultText)) {
      console.log(`[Warranty] Formulier niet ingediend — verplicht veld niet gevuld`);
      await warrantyPage.screenshot({ path: `warranty-form-stuck-${Date.now()}.png` });
      await browser.close();
      return {
        status: 'error',
        vin,
        message: 'Formulier niet ingediend (verplicht veld Gebruiksvoorwaarden niet gevuld)',
        vehicle: vehicleData,
        result_text: resultText.substring(0, 500)
      };
    }

    // 4. Onbekend resultaat → nooit als succes doorgeven
    console.log(`[Warranty] Geen bevestiging van contract aangemaakt gevonden`);
    await warrantyPage.screenshot({ path: `warranty-result-debug-${Date.now()}.png` });
    await browser.close();
    return {
      status: 'error',
      vin,
      message: 'Geen bevestiging van contract aangemaakt gevonden',
      vehicle: vehicleData,
      result_text: resultText.substring(0, 500)
    };

  } catch (error) {
    console.error(`[Warranty] Error: ${error.message}`);
    try {
      await page.screenshot({ path: `error-warranty-${Date.now()}.png` });
    } catch (e) { /* ignore */ }
    await browser.close();
    throw error;
  }
}

module.exports = { scrapeServicebox, scrapeQuotelink, activateWarranty };
