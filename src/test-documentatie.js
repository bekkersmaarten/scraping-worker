/**
 * Test script voor de Documentatie route.
 * Draait met zichtbare browser zodat je stap voor stap kunt zien wat er gebeurt.
 *
 * Gebruik:
 *   cd ~/Desktop/scraping-worker
 *   node src/test-documentatie.js VXKUPHPY9S4259523
 *
 * Vereist .env met SERVICEBOX_URL, SERVICEBOX_USERNAME, SERVICEBOX_PASSWORD
 */
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

const SERVICEBOX_URL = process.env.SERVICEBOX_URL || 'https://servicebox.mpsa.com';
const USERNAME = process.env.SERVICEBOX_USERNAME;
const PASSWORD = process.env.SERVICEBOX_PASSWORD;
const VIN = process.argv[2] || 'VXKUPHPY9S4259523';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function screenshotStep(page, name) {
  const path = `debug-${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`📸 Screenshot: ${path}`);
}

async function logFrames(page, label) {
  console.log(`\n=== ${label} ===`);
  console.log(`Hoofd-URL: ${page.url()}`);
  const frames = page.frames();
  console.log(`Aantal frames: ${frames.length}`);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    try {
      const url = f.url();
      const text = await f.evaluate(() => document.body?.innerText?.substring(0, 300) || '(leeg)');
      const inputs = await f.evaluate(() =>
        Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(el => `${el.type}[name=${el.name},id=${el.id},value=${el.value?.substring(0,20)}]`)
      );
      const buttons = await f.evaluate(() =>
        Array.from(document.querySelectorAll('input[type="submit"],input[type="button"],button,a.button')).map(el => `<${el.tagName} type=${el.type} value="${el.value}" text="${el.textContent?.trim()?.substring(0,30)}">`)
      );
      const links = await f.evaluate(() =>
        Array.from(document.querySelectorAll('a')).map(el => el.textContent?.trim()).filter(t => t && t.length > 1).slice(0, 30)
      );
      console.log(`\n  Frame ${i}: ${url.substring(0, 100)}`);
      console.log(`  Tekst: ${text.substring(0, 200)}`);
      if (inputs.length > 0) console.log(`  Inputs: ${inputs.join(', ')}`);
      if (buttons.length > 0) console.log(`  Knoppen: ${buttons.join(', ')}`);
      if (links.length > 0) console.log(`  Links: ${links.join(' | ')}`);
    } catch (e) {
      console.log(`  Frame ${i}: niet bereikbaar (${e.message.substring(0, 60)})`);
    }
  }
  console.log('');
}

(async () => {
  console.log(`\n🚀 Test Documentatie route voor VIN: ${VIN}`);
  console.log(`   Servicebox: ${SERVICEBOX_URL}`);
  console.log(`   Username: ${USERNAME}\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    httpCredentials: { username: USERNAME, password: PASSWORD }
  });

  context.on('page', (p) => console.log(`🔗 Nieuwe pagina: ${p.url()}`));

  const page = await context.newPage();

  try {
    // ── STAP 0: Login ──
    console.log('\n━━━ STAP 0: Login ━━━');
    await page.goto(SERVICEBOX_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    await screenshotStep(page, '00-login');
    await logFrames(page, 'Na login');

    // ── STAP 1: Niet nodig — VIN zoeken doen we in STAP 3 (in docapvpr) ──
    console.log('\n━━━ STAP 1: Overgeslagen (VIN zoeken in docapvpr) ━━━');
    await screenshotStep(page, '01-homepage');
    await logFrames(page, 'Homepage');

    // ── STAP 2: Hover DOCUMENTATIE → klik Technische documentatie ──
    console.log('\n━━━ STAP 2: DOCUMENTATIE → Technische documentatie ━━━');
    let techDocFound = false;
    for (const frame of page.frames()) {
      try {
        const docTab = await frame.$('a:has-text("DOCUMENTATIE"), a:has-text("Documentatie"), span:has-text("DOCUMENTATIE")');
        if (docTab) {
          console.log(`✅ DOCUMENTATIE tab gevonden in frame: ${frame.url().substring(0, 80)}`);
          await docTab.hover();
          await sleep(2000);
          await screenshotStep(page, '02a-doc-hover');

          // Zoek submenu
          for (const f2 of page.frames()) {
            const techDoc = await f2.$('a:has-text("Technische documentatie"), a:has-text("Technical documentation")');
            if (techDoc) {
              console.log('✅ Technische documentatie gevonden');
              await techDoc.click();
              techDocFound = true;
              break;
            }
          }
          if (techDocFound) break;
        }
      } catch (e) { continue; }
    }
    if (!techDocFound) console.log('❌ Technische documentatie niet gevonden');

    await sleep(5000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Zoek docapvpr pagina
    let docPage = page;
    for (const p of context.pages()) {
      if (p.url().includes('docapvpr')) { docPage = p; break; }
    }
    console.log(`Documentatie pagina: ${docPage.url()}`);
    await screenshotStep(docPage, '02b-tech-doc');
    await logFrames(docPage, 'Technische documentatie pagina');

    // ── STAP 3: VIN invoeren in docapvpr en OK klikken ──
    console.log('\n━━━ STAP 3: VIN invoeren in documentatie ━━━');
    let docVinEntered = false;
    for (const frame of docPage.frames()) {
      try {
        // Zoek specifiek het short-vin veld
        const vinInput = await frame.$('input#short-vin, input[name="shortvin"]');
        if (vinInput) {
          const info = await vinInput.evaluate(el => ({ name: el.name, id: el.id, type: el.type, value: el.value }));
          console.log(`  VIN veld gevonden: name="${info.name}" id="${info.id}" value="${info.value}"`);

          // Leegmaken en VIN invullen
          await vinInput.click();
          await vinInput.fill('');
          await vinInput.fill(VIN);
          console.log(`  ✅ VIN ingevuld: ${VIN}`);

          // OK knop is input[type="image"][name="VIN_OK_BUTTON"]
          const okBtn = await frame.$('input[name="VIN_OK_BUTTON"], input[type="image"]');
          if (okBtn) {
            const btnInfo = await okBtn.evaluate(el => ({ name: el.name, type: el.type, src: el.src?.substring(0, 50) }));
            console.log(`  OK knop: name="${btnInfo.name}" type=${btnInfo.type}`);
            await okBtn.click();
            docVinEntered = true;
            console.log('  ✅ VIN_OK_BUTTON geklikt');
          } else {
            await vinInput.press('Enter');
            docVinEntered = true;
            console.log('  ✅ Enter ingedrukt (geen image button)');
          }
          break;
        }
      } catch (e) { continue; }
    }

    await sleep(5000);
    await docPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await screenshotStep(docPage, '03-doc-vin');
    await logFrames(docPage, 'Na VIN invoer in documentatie');

    // ── STAP 4: Klik Onderhoudsschema's ──
    console.log('\n━━━ STAP 4: Onderhoudsschema\'s ━━━');
    let schemaClicked = false;
    for (const frame of docPage.frames()) {
      try {
        const links = await frame.$$('a');
        for (const link of links) {
          const text = await link.evaluate(el => el.textContent?.trim());
          if (text && /onderhoudsschema/i.test(text)) {
            console.log(`✅ Link gevonden: "${text}"`);
            await link.click();
            schemaClicked = true;
            break;
          }
        }
        if (schemaClicked) break;
      } catch (e) { continue; }
    }
    if (!schemaClicked) console.log('❌ Onderhoudsschema\'s link niet gevonden');

    await sleep(5000);
    await docPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await screenshotStep(docPage, '04-schema');
    await logFrames(docPage, 'Na Onderhoudsschema\'s klik');

    // ── STAP 5: Overzicht onderhoud tab ──
    console.log('\n━━━ STAP 5: Overzicht onderhoud tab ━━━');
    let overzichtClicked = false;

    // Eerst loggen welke elementen de tekst "Overzicht" bevatten
    for (const frame of docPage.frames()) {
      try {
        const matches = await frame.evaluate(() => {
          const results = [];
          const allEls = document.querySelectorAll('*');
          for (const el of allEls) {
            if (el.children.length === 0 && el.textContent?.trim().includes('Overzicht')) {
              results.push({ tag: el.tagName, text: el.textContent.trim(), id: el.id, cls: el.className?.substring?.(0, 50) || '' });
            }
          }
          return results;
        });
        if (matches.length > 0) {
          console.log(`  Elementen met "Overzicht" in frame ${frame.url().substring(0, 60)}:`);
          matches.forEach(m => console.log(`    <${m.tag} id="${m.id}" class="${m.cls}"> "${m.text}"`));
        }
      } catch (e) { continue; }
    }

    // Probeer breed te matchen (elk element type)
    for (const frame of docPage.frames()) {
      try {
        const clicked = await frame.evaluate(() => {
          const els = document.querySelectorAll('a, td, div, span, li, button');
          for (const el of els) {
            if (el.textContent?.trim() === 'Overzicht onderhoud' || el.innerText?.trim() === 'Overzicht onderhoud') {
              el.click();
              return el.tagName + ' ' + (el.className || '');
            }
          }
          return null;
        });
        if (clicked) {
          console.log(`✅ Tab geklikt via JS: ${clicked}`);
          overzichtClicked = true;
          await sleep(3000);
          break;
        }
      } catch (e) { continue; }
    }

    if (!overzichtClicked) console.log('❌ Tab "Overzicht onderhoud" niet gevonden');
    await screenshotStep(docPage, '05-overzicht');
    await logFrames(docPage, 'Na Overzicht onderhoud tab');

    // ── STAP 6: Dropdown Normaal + Zoeken ──
    console.log('\n━━━ STAP 6: Dropdown + Zoeken ━━━');
    for (const frame of docPage.frames()) {
      try {
        const selects = await frame.$$('select');
        for (const select of selects) {
          const options = await select.evaluate(el =>
            Array.from(el.options).map(o => ({ value: o.value, text: o.textContent?.trim(), selected: o.selected }))
          );
          console.log(`  Select opties: ${options.map(o => `"${o.text}" (${o.value})${o.selected ? ' ✓' : ''}`).join(', ')}`);
          const normaal = options.find(o => /normaa?l/i.test(o.text));
          if (normaal) {
            await select.selectOption(normaal.value);
            console.log(`  ✅ Normaal geselecteerd`);
          }
        }

        const searchBtn = await frame.$('input#btnRechercher, input[value="Zoeken"][type="button"]');
        if (searchBtn) {
          const btnText = await searchBtn.evaluate(el => el.value || el.textContent?.trim());
          console.log(`  ✅ Zoeken knop: "${btnText}"`);
          await screenshotStep(docPage, '06a-before-search');
          await searchBtn.click();
          console.log('  Geklikt! Wachten op resultaat...');
          await sleep(10000);
          break;
        }
      } catch (e) { continue; }
    }

    // Check alle pagina's
    console.log('\n━━━ Alle open pagina\'s na Zoeken: ━━━');
    for (const p of context.pages()) {
      console.log(`  ${p.url()}`);
    }

    await screenshotStep(docPage, '06b-after-search');

    // Wacht nog even en check opnieuw
    await sleep(10000);
    console.log('\nAlle pagina\'s na 10s extra wachten:');
    for (const p of context.pages()) {
      console.log(`  ${p.url()}`);
      try {
        const ct = await p.evaluate(() => document.contentType);
        console.log(`    Content-type: ${ct}`);
      } catch (e) {}
    }

    console.log('\n✅ Test voltooid! Check de debug-*.png screenshots.');
    console.log('Druk Ctrl+C om af te sluiten.\n');

    // Houd browser open zodat je kunt kijken
    await sleep(300000); // 5 minuten

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    await screenshotStep(page, 'error');
  } finally {
    await browser.close();
  }
})();
