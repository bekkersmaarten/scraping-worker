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
    const { intervals, prices } = await extractMaintenance(page, context, kmStand);

    console.log('[Scraper] Scrape voltooid!');
    return { vehicle: vehicleData, recalls, intervals, prices };

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

  // Check of we ingelogd zijn (frames = Servicebox is geladen)
  if (currentUrl.includes('loadPage.jsp') || currentUrl.includes('referer.jsp')) {
    const hasFrames = await page.evaluate(() => {
      return document.querySelectorAll('frame, iframe').length > 0 || document.title.includes('Service Box');
    });
    if (hasFrames) {
      console.log('[Login] Al ingelogd (HTTP credentials werkten)');

      // Log de frameset HTML zodat we zien welke frames er zouden moeten zijn
      const framesetInfo = await page.evaluate(() => {
        const frames = document.querySelectorAll('frame, iframe');
        return Array.from(frames).map(f => ({
          name: f.name || f.id || '(unnamed)',
          src: f.src || '(no src)',
          tagName: f.tagName
        }));
      });
      console.log('[Login] Frameset structuur:', JSON.stringify(framesetInfo));

      // Wacht tot ALLE frames geladen zijn
      console.log('[Login] Wachten tot alle frames geladen zijn...');
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);

      // Log welke frames er daadwerkelijk geladen zijn
      const loadedFrames = page.frames().map(f => f.url());
      console.log(`[Login] Geladen frames (${loadedFrames.length}): ${loadedFrames.join(', ')}`);

      // Het hub-frame (frameHub) laadt soms niet maar overlapt wel de UI.
      // We verbergen het via JavaScript zodat het de klikken niet blokkeert.
      const hubFrameAboutBlank = page.frames().find(f => f.url() === 'about:blank' || f.url() === '');
      if (hubFrameAboutBlank) {
        console.log('[Login] Hub-frame is about:blank — verbergen zodat het kliks niet blokkeert');
        await page.evaluate(() => {
          const hub = document.querySelector('frame[name="frameHub"], frame#frameHub');
          if (hub) {
            hub.style.visibility = 'hidden';
            hub.style.position = 'absolute';
            hub.style.width = '0';
            hub.style.height = '0';
            console.log('Hub frame verborgen');
          }
        });
      }

      return;
    }
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

  const frames = page.frames();
  console.log(`[Vehicle] Aantal frames: ${frames.length}`);

  // Vind het zoekveld: input#short-vin[name="shortvin"][type="search"]
  // Dit zit in het hub-frame (niet het socle frame)
  let searchInput = null;
  let targetFrame = null;

  for (const frame of frames) {
    try {
      // Zoek specifiek het shortvin veld (type="search")
      searchInput = await frame.$('input#short-vin, input[name="shortvin"]');
      if (searchInput) {
        targetFrame = frame;
        break;
      }
    } catch (e) { continue; }
  }

  if (!searchInput) {
    await page.screenshot({ path: 'search-field-debug.png' });
    throw new Error('Zoekveld (input#short-vin) niet gevonden in frames');
  }

  console.log(`[Vehicle] Zoekveld gevonden in frame: ${targetFrame.url()}`);

  // Vul kenteken in en submit via JavaScript (bypassed frameset pointer interception)
  console.log('[Vehicle] Kenteken invullen en submitten via JS...');
  await targetFrame.evaluate((kent) => {
    const input = document.querySelector('input#short-vin, input[name="shortvin"]');
    if (!input) throw new Error('Zoekveld niet gevonden in frame');
    input.value = kent;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Klik de OK button via JS (bypassed pointer event checks)
    const okBtn = document.querySelector('input[name="VIN_OK_BUTTON"]');
    if (okBtn) {
      okBtn.click();
    } else {
      // Fallback: submit het formulier
      const form = input.closest('form');
      if (form) form.submit();
    }
  }, cleanKenteken);
  console.log(`[Vehicle] Kenteken ${cleanKenteken} ingevoerd en gesubmit via JS`);

  // Wacht op resultaten — de frameset herlaadt na de zoekopdracht
  console.log('[Vehicle] Wachten op resultaten (10s)...');
  await page.waitForTimeout(10000);

  // Log huidige frame-staat
  for (const f of page.frames()) {
    const url = f.url();
    if (url !== 'about:blank') {
      console.log(`[Vehicle] Frame: ${url.substring(0, 120)}`);
    }
  }

  // Probeer data te extraheren — 4 pogingen met 8s tussenpozen
  let vehicleData = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`[Vehicle] Poging ${attempt}/4 om voertuigdata te extraheren...`);
    vehicleData = await extractVehicleData(page, cleanKenteken);
    if (vehicleData) break;

    console.log(`[Vehicle] Nog geen data, wacht 8s...`);
    await page.waitForTimeout(8000);
  }

  if (!vehicleData) {
    // Debug: log inhoud van alle frames
    console.log('[Vehicle] === MISLUKT — frame-inhouden: ===');
    for (const f of page.frames()) {
      try {
        const url = f.url();
        const text = await f.evaluate(() => (document.body?.innerText || '').substring(0, 500));
        if (text.length > 10) {
          console.log(`[Vehicle] [${url.substring(0, 80)}]:`);
          console.log(text.substring(0, 250));
        }
      } catch {}
    }
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

  // Roep goTo('/mp/') direct aan in het frame via JavaScript
  // (de Quotelink link is een javascript: link die niet goed werkt met Playwright click)
  let executed = false;
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

  if (!executed) {
    console.log('[Maintenance] goTo functie niet gevonden in frames');
    return { intervals: [], prices: [] };
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

  // Extract prijzen door categorieën door te klikken
  const prices = await extractPricesByCategory(menuPricingPage);

  // Sluit popup
  await menuPricingPage.close();

  return { intervals, prices };
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

module.exports = { scrapeServicebox };
