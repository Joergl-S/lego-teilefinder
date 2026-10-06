/**
 * ui.js – Einstiegspunkt und Oberfläche.
 *
 * Schritt 1: Suchliste (Text- oder Fotosuche, Farbe, Menge)
 * Schritt 2: Foto laden, optional Hintergrund antippen
 * Schritt 3: Analyse – Stufe A lokal (Segmentierung, Farbe, Vorfilter),
 *            Stufe B Brickognize nur für vorgefilterte Ausschnitte
 * Schritt 4: Ergebnis – Boxen, Zoom, Trefferliste, Korrektur, PNG-Export
 */

import { loadSettings, saveSettings, resetSettings, loadWishlist, saveWishlist, DEFAULTS } from './settings.js';
import { loadStored, downloadAll, importFiles, fetchRepoVersion } from './data.js';
import { requestPersistence } from './db.js';
import { PartIndex, partImageUrl, PLACEHOLDER_IMG } from './search.js';
import {
  pickerColors, swatchStyle, buildPalette, nearestColors, srgbToLab, hexToRgb, labToRgb, rgbToHex,
  measureLab, whiteBalanceGains, isNeutral,
} from './color.js';
import {
  loadPhoto, releasePhoto, releaseCanvas, makeCanvas, sampleColor, regionPixels, cropRegion,
  canvasToBlob, regionFromRect, borderMedianRgb,
} from './image.js';
import { segmentPhoto, warmup } from './segment.js';
import { predictCached, recognizeMany, testConnection } from './recognize.js';
import { evaluateRegion, passesPrefilter, partMatches, summarize, baseNum } from './match.js';
import { Viewer, drawBoxes } from './overlay.js';

export const APP_VERSION = '1.0.2 · 2026-10-06';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const sleep0 = () => new Promise(r => setTimeout(r, 0));

/** Laufzeitzustand */
const state = {
  settings: loadSettings(),
  wishlist: loadWishlist(),
  data: null, index: null,
  colors: [], colorById: new Map(), colorLab: new Map(), palette: [],
  dialogPart: null, dialogColor: null,
  photo: null,            // aus image.loadPhoto
  bgTap: null,            // {x, y, rgb} angetippter Hintergrund
  bgTapMode: false,
  seg: null,              // Ergebnis der Segmentierung
  regions: [],
  bgRgb: null, bgLab: null, gains: [1, 1, 1],
  abort: null,
  selected: null,         // ausgewählte Region-ID
  manual: false,
  dialogRegion: null,
  debugView: 'overlay',
  exColor: null,
};

/* ================================================================ Allgemein */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showBanner(html, kind = 'info', { sticky = false } = {}) {
  const b = $('#banner');
  b.className = 'banner ' + kind;
  b.innerHTML = html + ' <button class="banner-x" aria-label="Schließen">✕</button>';
  b.hidden = false;
  b.querySelector('.banner-x').onclick = () => { b.hidden = true; };
  clearTimeout(showBanner._t);
  if (!sticky) showBanner._t = setTimeout(() => { b.hidden = true; }, 6000);
}

function colorName(id) {
  if (id == null) return 'Farbe egal';
  const c = state.colorById.get(id);
  return c ? c.name : `Farbe ${id}`;
}

function wishLabel(w) {
  return `${w.partNum} · ${colorName(w.colorId)}`;
}

function wishImg(w) {
  return w.img || partImageUrl(w.partNum, w.colorId);
}

function pct(x) { return Math.round((x || 0) * 100) + ' %'; }

/* ================================================================== Tabs */

function showTab(name) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  window.scrollTo({ top: 0 });
  if (name === 'analyze') updateAnalyzeHint();
}

function initTabs() {
  for (const btn of $$('.tab')) btn.addEventListener('click', () => showTab(btn.dataset.tab));
  for (const btn of $$('[data-goto]')) btn.addEventListener('click', () => showTab(btn.dataset.goto));
}

function updateBadges() {
  $('#badge-search').textContent = state.wishlist.length || '';
  $('#badge-photo').textContent = state.photo ? '✓' : '';
  $('#badge-analyze').textContent = state.regions.length || '';
  const hits = state.regions.filter(r => r.result && r.result.status !== 'none').length;
  $('#badge-result').textContent = hits || '';
}

/* ================================================================= Daten */

function applyData(data) {
  state.data = data;
  state.index = new PartIndex(data.parts, data.part_categories, data.part_relationships);
  state.colors = pickerColors(data.colors);
  state.colorById = new Map(data.colors.map(c => [c.id, c]));
  state.colorLab = new Map(data.colors.map(c => [c.id, srgbToLab(...hexToRgb(c.rgb))]));
  rebuildPalette();
  renderDataStatus();
  renderWishlist();
  $('#search-input').disabled = false;
  $('#search-status').textContent = `${data.parts.length.toLocaleString('de-DE')} Teile, ${state.colors.length} Farben bereit.`;
  runSearch();
}

function rebuildPalette() {
  if (!state.data) return;
  const must = new Set(state.wishlist.map(w => w.colorId).filter(v => v != null));
  state.palette = buildPalette(state.data.colors, must);
}

async function initData() {
  $('#search-input').disabled = true;
  $('#search-status').textContent = 'Lade Teiledaten …';
  let data = null;
  try {
    data = await loadStored();
  } catch (e) {
    showBanner('Lokale Datenbank nicht lesbar: ' + esc(e.message), 'error', { sticky: true });
  }
  if (data) {
    applyData(data);
    checkForDataUpdate(data.meta);
    return;
  }
  await reloadData();
}

async function reloadData() {
  $('#search-input').disabled = true;
  showBanner('Teiledaten werden geladen … (einmalig, ca. 5 MB)', 'info', { sticky: true });
  try {
    const data = await downloadAll(msg => { $('#search-status').textContent = msg; });
    applyData(data);
    showBanner('Teiledaten geladen und gespeichert.', 'ok');
    requestPersistence();
  } catch (e) {
    console.error(e);
    $('#search-status').textContent = 'Keine Teiledaten vorhanden.';
    showBanner(
      '<strong>Teiledaten konnten nicht geladen werden.</strong><br>' + esc(e.message) +
      '<br>Internetverbindung prüfen. Wurde die GitHub-Action „Teiledaten aktualisieren“ schon ausgeführt? ' +
      'Alternativ in den Einstellungen die CSV-Dateien von rebrickable.com/downloads importieren.', 'error', { sticky: true });
  }
}

async function checkForDataUpdate(meta) {
  if (!navigator.onLine) return;
  const v = await fetchRepoVersion();
  if (v && meta && meta.repoVersion !== v && !Object.values(meta.sources || {}).includes('Import')) {
    try {
      const data = await downloadAll(() => {});
      applyData(data);
      showBanner('Teiledaten aktualisiert (Stand ' + esc(v.slice(0, 10)) + ').', 'ok');
    } catch (e) {
      console.warn('Hintergrund-Update fehlgeschlagen', e);
    }
  }
}

function renderDataStatus() {
  const m = (state.data && state.data.meta) || {};
  const c = m.counts || {};
  const src = m.sources || {};
  const when = m.loadedAt ? new Date(m.loadedAt).toLocaleString('de-DE') : '–';
  const repo = m.repoVersion ? ` · Datenstand ${esc(m.repoVersion.slice(0, 10))}` : '';
  $('#data-status').innerHTML = state.data
    ? `Teile: ${c.parts ?? '?'} (${esc(src.parts || '?')}) · Farben: ${c.colors ?? '?'} · ` +
      `Kategorien: ${c.part_categories ?? '?'} · Beziehungen: ${c.part_relationships ?? '?'}<br>` +
      `Geladen: ${when}${repo}`
    : 'Keine Daten geladen.';
}

/* ================================================================ Suche */

let searchTimer = 0;

function runSearch() {
  const ul = $('#search-results');
  const q = $('#search-input').value;
  if (!state.index || !q.trim()) { ul.innerHTML = ''; return; }
  const t0 = performance.now();
  const hits = state.index.search(q, { hidePrints: $('#hide-prints').checked });
  const ms = Math.round(performance.now() - t0);
  $('#search-status').textContent = hits.length
    ? `${hits.length}${hits.length >= 60 ? '+' : ''} Treffer (${ms} ms)`
    : 'Keine Treffer. Tipp: Englische Namen verwenden, z. B. „plate 1 x 2“, „slope“, „technic pin“.';
  ul.innerHTML = hits.map(e => `
    <li class="result" data-num="${esc(e.num)}">
      <img loading="lazy" src="${partImageUrl(e.num)}" alt="" width="56" height="56">
      <div class="result-text">
        <div><span class="mono">${esc(e.num)}</span>${e.isPrint ? ' <span class="tag">Druck</span>' : ''}</div>
        <div class="result-name">${esc(e.name)}</div>
        <div class="muted small">${esc(state.index.categoryName(e.cat))}</div>
      </div>
    </li>`).join('');
}

function initSearch() {
  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  });
  $('#hide-prints').checked = state.settings.hidePrints;
  $('#hide-prints').addEventListener('change', e => {
    state.settings.hidePrints = e.target.checked;
    saveSettings(state.settings);
    runSearch();
  });
  $('#search-results').addEventListener('click', e => {
    const li = e.target.closest('.result');
    if (li) openPartDialog(li.dataset.num);
  });
  // Text- / Fotosuche umschalten
  for (const b of $$('#tab-search .seg-btn')) {
    b.addEventListener('click', () => {
      $$('#tab-search .seg-btn').forEach(x => x.classList.toggle('active', x === b));
      $('#search-text').hidden = b.dataset.mode !== 'text';
      $('#search-photo').hidden = b.dataset.mode !== 'photo';
    });
  }
  // Kaputte Vorschaubilder durch Platzhalter ersetzen
  document.addEventListener('error', e => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.src !== PLACEHOLDER_IMG) img.src = PLACEHOLDER_IMG;
  }, true);
}

/** Sucht zu einer BrickLink-/Brickognize-Nummer das passende Rebrickable-Teil. */
function resolvePart(id) {
  if (!state.index) return null;
  const direct = state.index.get(id) || state.index.get(String(id).toLowerCase());
  if (direct) return direct;
  const b = baseNum(id);
  let best = null;
  for (const e of state.index.entries) {
    if (baseNum(e.numLower) === b && (!best || e.num.length < best.num.length)) best = e;
  }
  return best;
}

/* ===================================================== Suche per Beispielfoto */

async function onExamplePhoto(file) {
  if (!file) return;
  const status = $('#ex-status');
  $('#ex-results').innerHTML = '';
  $('#ex-color').innerHTML = '';
  status.textContent = 'Lade Foto …';
  let photo = null;
  try {
    photo = await loadPhoto(file);
    const s = Math.min(1, 800 / Math.max(photo.width, photo.height));
    const c = makeCanvas(photo.width * s, photo.height * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(photo.orig, 0, 0, c.width, c.height);
    const blob = await canvasToBlob(c, 'image/jpeg', 0.9);
    const img = $('#ex-img');
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(blob);
    img.hidden = false;

    // Farbe schätzen: Pixel, die sich deutlich vom Hintergrund (Bildrand) abheben
    const id = ctx.getImageData(0, 0, c.width, c.height);
    releaseCanvas(c);
    const bg = borderMedianRgb(id);
    const bgLab = srgbToLab(...bg);
    const gains = state.settings.wb === 'auto' && isNeutral(bg) ? whiteBalanceGains(bg) : [1, 1, 1];
    const px = [];
    const d = id.data;
    for (let i = 0; i < d.length; i += 8) {           // jedes 2. Pixel reicht
      const lab = srgbToLab(d[i], d[i + 1], d[i + 2]);
      const dl = lab[0] - bgLab[0];
      const dist = Math.hypot(dl < 0 ? dl * 0.6 : dl, lab[1] - bgLab[1], lab[2] - bgLab[2]);
      if (dist > 15) px.push(d[i], d[i + 1], d[i + 2]);
    }
    state.exColor = null;
    if (px.length > 60 && state.data) {
      const lab = measureLab(Uint8Array.from(px), gains);
      const pal = buildPalette(state.data.colors);
      const near = nearestColors(lab, pal, 3);
      state.exColor = { lab, near };
      $('#ex-color').innerHTML = 'Farbvorschlag: ' + near.map((n, i) => {
        const col = state.colorById.get(n.id);
        return `<span class="chip sm" style="${swatchStyle(col)}"></span> ${i ? '' : '<strong>'}${esc(colorName(n.id))}${i ? '' : '</strong>'} <span class="muted">(ΔE ${n.dE.toFixed(1)})</span>`;
      }).join(' · ');
    }
    releasePhoto(photo); photo = null;

    status.textContent = 'Frage Brickognize …';
    const out = await predictCached(blob, state.settings.apiUrl);
    if (!out.items.length) { status.textContent = 'Brickognize hat kein Teil erkannt. Anderes Foto versuchen (näher, ruhiger Hintergrund).'; return; }
    status.textContent = 'Richtiges Teil antippen:';
    $('#ex-results').innerHTML = out.items.slice(0, 8).map((it, i) => {
      const rb = resolvePart(it.id);
      return `
        <li class="result" data-i="${i}">
          <img loading="lazy" src="${esc(it.img || (rb ? partImageUrl(rb.num) : PLACEHOLDER_IMG))}" alt="" width="56" height="56">
          <div class="result-text">
            <div><span class="mono">${esc(it.id)}</span> <span class="score">${pct(it.score)}</span></div>
            <div class="result-name">${esc(it.name)}</div>
            <div class="muted small">${rb ? (rb.num !== it.id ? 'Rebrickable: ' + esc(rb.num) : 'in Rebrickable-Daten') : 'nicht in den Rebrickable-Daten'}</div>
          </div>
        </li>`;
    }).join('');
    $('#ex-results').onclick = ev => {
      const li = ev.target.closest('.result');
      if (!li) return;
      const it = out.items[Number(li.dataset.i)];
      const rb = resolvePart(it.id);
      const preset = { colorId: state.exColor ? state.exColor.near[0].id : null };
      openPartDialog(rb ? rb.num : { num: it.id, name: it.name, cat: 0, img: it.img }, preset);
    };
  } catch (e) {
    console.error(e);
    status.textContent = 'Fehler: ' + e.message;
  } finally {
    if (photo) releasePhoto(photo);
  }
}

function initExampleSearch() {
  for (const id of ['#ex-camera', '#ex-library']) {
    $(id).addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      onExamplePhoto(f);
    });
  }
}

/* ===================================================== Teil-/Farbdialog */

function openPartDialog(numOrPart, preset = null) {
  const part = typeof numOrPart === 'string' ? state.index && state.index.get(numOrPart) : numOrPart;
  if (!part) return;
  state.dialogPart = part;
  state.dialogColor = preset ? preset.colorId ?? null : null;
  $('#dp-title').textContent = 'Teil hinzufügen';
  $('#dp-num').textContent = part.num;
  $('#dp-name').textContent = part.name;
  $('#dp-cat').textContent = state.index ? state.index.categoryName(part.cat) : '';
  const fam = state.index ? state.index.family(part.num) : [part.num];
  $('#dp-rel').textContent = fam.length > 1
    ? `${fam.length - 1} ${fam.length === 2 ? 'Variante wird' : 'Varianten werden'} mitgezählt (Druck/Muster/Form)` : '';
  $('#dp-qty').value = preset && preset.qty ? preset.qty : '';
  $('#dp-color-filter').value = '';
  renderColorGrid();
  updateDialogColor();
  $('#dlg-part').returnValue = '';
  $('#dlg-part').showModal();
}

function renderColorGrid() {
  const f = $('#dp-color-filter').value.trim().toLowerCase();
  const words = f.split(/\s+/).filter(Boolean);
  const list = state.colors.filter(c => words.every(w => c.name.toLowerCase().includes(w)));
  const any = !words.length || 'farbe egal'.includes(f)
    ? `<button type="button" class="swatch any" data-color="">
         <span class="chip" style="${swatchStyle(null)}"></span><span>Farbe egal</span></button>`
    : '';
  $('#dp-colors').innerHTML = any + list.map(c => `
    <button type="button" class="swatch" data-color="${c.id}" title="${esc(c.name)}">
      <span class="chip" style="${swatchStyle(c)}"></span><span>${esc(c.name)}</span>
    </button>`).join('');
  updateDialogColor();
}

function updateDialogColor() {
  if (!state.dialogPart) return;
  const c = state.dialogColor == null ? null : state.colorById.get(state.dialogColor);
  $('#dp-img').src = state.dialogPart.img || partImageUrl(state.dialogPart.num, c ? c.id : null);
  $('#dp-color-selected').innerHTML =
    `<span class="chip" style="${swatchStyle(c)}"></span> <strong>${c ? esc(c.name) : 'Farbe egal'}</strong>` +
    (c ? ` <span class="muted small">#${c.rgb} · ID ${c.id}</span>` : '');
  $$('#dp-colors .swatch').forEach(b => {
    const id = b.dataset.color === '' ? null : Number(b.dataset.color);
    b.classList.toggle('sel', id === state.dialogColor);
  });
}

function initPartDialog() {
  const dlg = $('#dlg-part');
  $('#dp-color-filter').addEventListener('input', renderColorGrid);
  $('#dp-colors').addEventListener('click', e => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    state.dialogColor = b.dataset.color === '' ? null : Number(b.dataset.color);
    updateDialogColor();
  });
  dlg.querySelectorAll('[data-qty]').forEach(b => b.addEventListener('click', () => {
    const inp = $('#dp-qty');
    const v = Math.max(0, (Number(inp.value) || 0) + Number(b.dataset.qty));
    inp.value = v || '';
  }));
  $('#dp-color-filter').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'add' || !state.dialogPart) return;
    const qty = Math.max(0, Math.round(Number($('#dp-qty').value) || 0)) || null;
    addToWishlist(state.dialogPart, state.dialogColor, qty);
  });
  // Tippen auf den abgedunkelten Hintergrund schließt Dialoge
  for (const d of $$('dialog')) d.addEventListener('click', e => { if (e.target === d) d.close('cancel'); });
}

/* ============================================================ Suchliste */

function addToWishlist(part, colorId, qty) {
  const existing = state.wishlist.find(w => w.partNum === part.num && w.colorId === colorId);
  if (existing) {
    existing.qty = qty == null ? existing.qty : (existing.qty || 0) + qty;
    showBanner(`${esc(part.num)} war schon in der Liste – Menge angepasst.`, 'info');
  } else {
    state.wishlist.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      partNum: part.num,
      partName: part.name,
      colorId,
      qty,
      ...(part.img ? { img: part.img } : {}),
    });
    showBanner(`${esc(part.num)} (${esc(colorName(colorId))}) zur Suchliste hinzugefügt.`, 'ok');
  }
  wishlistChanged();
}

function wishlistChanged() {
  saveWishlist(state.wishlist);
  rebuildPalette();
  renderWishlist();
  if (state.regions.length) {
    for (const r of state.regions) if (r.color) Object.assign(r.color, nearestSplit(r.color.lab));
    evaluateAll();
    renderAll();
  }
  updateBadges();
}

function renderWishlist() {
  const ul = $('#wish-list');
  $('#wish-empty').hidden = state.wishlist.length > 0;
  $('#btn-clear-list').hidden = state.wishlist.length === 0;
  ul.innerHTML = state.wishlist.map(w => {
    const c = w.colorId == null ? null : state.colorById.get(w.colorId);
    return `
      <li class="wish" data-id="${w.id}">
        <img loading="lazy" src="${esc(wishImg(w))}" alt="" width="56" height="56">
        <div class="result-text">
          <div class="mono">${esc(w.partNum)}</div>
          <div class="result-name">${esc(w.partName)}</div>
          <div class="small"><span class="chip sm" style="${swatchStyle(c)}"></span> ${esc(colorName(w.colorId))}</div>
        </div>
        <div class="qty compact">
          <button type="button" class="btn" data-act="dec" aria-label="weniger">−</button>
          <span class="qty-val">${w.qty ?? '∞'}</span>
          <button type="button" class="btn" data-act="inc" aria-label="mehr">+</button>
        </div>
        <button type="button" class="icon-btn danger" data-act="del" aria-label="Entfernen">🗑</button>
      </li>`;
  }).join('');
  updateBadges();
}

function initWishlist() {
  $('#wish-list').addEventListener('click', e => {
    const li = e.target.closest('.wish');
    if (!li) return;
    const w = state.wishlist.find(x => x.id === li.dataset.id);
    if (!w) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'inc') w.qty = (w.qty || 0) + 1;
    else if (act === 'dec') w.qty = w.qty > 1 ? w.qty - 1 : null;
    else if (act === 'del') state.wishlist = state.wishlist.filter(x => x !== w);
    else return;
    wishlistChanged();
  });
  $('#btn-clear-list').addEventListener('click', () => {
    if (!confirm('Suchliste wirklich leeren?')) return;
    state.wishlist = [];
    wishlistChanged();
  });
}

/* ================================================================ Foto */

let photoViewer = null;

async function onPhotoFile(file) {
  if (!file) return;
  showBanner('Lade Foto …', 'info', { sticky: true });
  try {
    resetAnalysis();
    photoViewer.clear();
    if (resultViewer) resultViewer.clear();
    releasePhoto(state.photo);
    state.photo = null;
    state.bgTap = null;
    const p = await loadPhoto(file);
    state.photo = p;
    $('#photo-viewer-wrap').hidden = false;
    $('#photo-tools').hidden = false;
    photoViewer.setImage(p.display, p.width, p.height);
    photoViewer.setMarker(null);
    renderBgInfo();
    const mp = (p.srcWidth * p.srcHeight / 1e6).toFixed(1);
    $('#photo-info').textContent = `${p.srcWidth} × ${p.srcHeight} px (${mp} MP)` +
      (p.reduced ? ` – für Safari auf ${p.width} × ${p.height} verkleinert` : ' – Originalauflösung');
    showBanner('Foto geladen. Weiter mit „Analyse“.', 'ok');
    warmup().catch(() => {});          // OpenCV schon mal laden
    updateBadges();
  } catch (e) {
    showBanner(esc(e.message), 'error', { sticky: true });
  }
}

function renderBgInfo() {
  const t = state.bgTap;
  $('#btn-bg-clear').hidden = !t;
  $('#bg-info').innerHTML = t
    ? `<span class="chip sm" style="background:#${rgbToHex(t.rgb)}"></span> Hintergrund angetippt` +
      (isNeutral(t.rgb) ? ' (neutral → Weißabgleich)' : ' (farbig → kein Weißabgleich)')
    : 'Hintergrund: automatisch';
}

function setBgTapMode(on) {
  state.bgTapMode = on;
  $('#btn-bg-tap').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#btn-bg-tap').classList.toggle('active', on);
  if (on) showBanner('Jetzt auf eine freie Stelle des Hintergrunds tippen.', 'info');
}

function initPhoto() {
  photoViewer = new Viewer($('#photo-canvas'), {
    onTap: (x, y) => {
      if (!state.bgTapMode || !state.photo) return;
      if (x < 0 || y < 0 || x >= state.photo.width || y >= state.photo.height) return;
      const rgb = sampleColor(state.photo, x, y, Math.max(4, Math.round(state.photo.width / 400)));
      state.bgTap = { x, y, rgb };
      photoViewer.setMarker({ x, y });
      setBgTapMode(false);
      renderBgInfo();
      resetAnalysis();
    },
  });
  for (const id of ['#photo-camera', '#photo-library']) {
    $(id).addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      onPhotoFile(f);
    });
  }
  $('#btn-bg-tap').addEventListener('click', () => setBgTapMode(!state.bgTapMode));
  $('#btn-bg-clear').addEventListener('click', () => {
    state.bgTap = null;
    photoViewer.setMarker(null);
    renderBgInfo();
    resetAnalysis();
  });
}

/* ============================================================== Analyse */

let debugViewer = null;
let resultViewer = null;

function resetAnalysis() {
  if (state.abort) state.abort.abort();
  if (debugViewer) debugViewer.clear();
  if (state.seg) { releaseCanvas(state.seg.debug.canvas); releaseCanvas(state.seg.debug.maskCanvas); }
  state.seg = null;
  state.regions = [];
  state.selected = null;
  $('#an-summary').innerHTML = '';
  $('#an-warnings').innerHTML = '';
  $('#btn-recognize').hidden = true;
  $('#debug-card').hidden = true;
  renderAll();
}

function updateAnalyzeHint() {
  const h = [];
  if (!state.photo) h.push('Zuerst ein Foto aufnehmen (Schritt 2).');
  if (!state.data) h.push('Teiledaten fehlen noch.');
  if (!state.wishlist.length) h.push('Die Suchliste ist leer – es wird nur segmentiert (gut zum Testen der Trennung).');
  const s = state.settings;
  h.push(`Modus: ${s.mode === 'small' ? 'Kleine Menge' : 'Normal'}, Kachel-Modus: ${s.tiles > 1 ? s.tiles + '×' + s.tiles : 'aus'}.`);
  $('#an-hint').textContent = h.join(' ');
  $('#btn-analyze').disabled = !state.photo;
}

function setProgress(frac, text) {
  $('#progress').hidden = false;
  const bar = $('#progress-bar');
  if (frac == null) bar.removeAttribute('value'); else bar.value = frac;
  if (text) $('#progress-text').textContent = text;
}

function hideProgress() { $('#progress').hidden = true; }

function nearestSplit(lab) {
  const n = nearestColors(lab, state.palette, 3);
  return { best: n[0], alts: n.slice(1) };
}

function measureRegionColor(r) {
  const px = regionPixels(state.photo, r);
  const lab = measureLab(px, state.gains) || r.labWork || [50, 0, 0];
  r.color = { lab, ...nearestSplit(lab) };
}

function evaluateAll() {
  for (const r of state.regions) {
    r.candidate = state.wishlist.length > 0 && !!r.color && passesPrefilter(r, state.wishlist, state.colorLab, state.settings);
    r.result = evaluateRegion(r, state.wishlist, state.index, state.colorLab, state.settings);
  }
}

const WARN_TEXT = {
  dark: 'Das Foto ist sehr dunkel. Mehr Licht verwenden (gleichmäßig von oben, kein Blitz).',
  noParts: 'Keine Teile gefunden. Hebt sich der Hintergrund deutlich von den Teilen ab? Ggf. im Schritt 2 „Hintergrund antippen“.',
  bgFail: 'Der Hintergrund wurde nicht sicher erkannt (sehr viel „Vordergrund“). Hintergrund antippen oder einen einfarbigen Untergrund verwenden.',
  manyLarge: 'Auffällig viele große Bereiche – vermutlich verschmolzene Teile. Teile weiter auseinanderlegen, Kachel-Modus (Einstellungen) oder „Manuell“ im Ergebnis nutzen.',
  tooMany: 'Sehr viele Regionen – ist der Hintergrund gemustert oder unruhig?',
};

async function runAnalysis() {
  if (!state.photo) { showBanner('Bitte zuerst ein Foto aufnehmen (Schritt 2).', 'warn'); return; }
  if (!state.data) { showBanner('Teiledaten fehlen noch – siehe Hinweis oben.', 'warn'); return; }
  resetAnalysis();
  const ac = new AbortController();
  state.abort = ac;
  $('#btn-analyze').disabled = true;
  try {
    const t0 = performance.now();
    setProgress(null, 'Starte …');
    const seg = await segmentPhoto(state.photo, {
      tiles: state.settings.tiles,
      mode: state.settings.mode,
      bgRgb: state.bgTap ? state.bgTap.rgb : null,
      onProgress: t => setProgress(null, t),
      signal: ac.signal,
    });
    state.seg = seg;
    state.regions = seg.regions;
    state.bgRgb = seg.bgRgb;
    state.bgLab = seg.bgLab;
    state.gains = state.settings.wb === 'auto' && isNeutral(seg.bgRgb) ? whiteBalanceGains(seg.bgRgb) : [1, 1, 1];
    const tSeg = performance.now() - t0;

    // Farben bestimmen (in Häppchen, damit die Oberfläche reagiert)
    const n = state.regions.length;
    for (let i = 0; i < n; i++) {
      if (ac.signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
      measureRegionColor(state.regions[i]);
      if (i % 12 === 0) { setProgress(i / n, `Bestimme Farben … ${i} von ${n}`); await sleep0(); }
    }
    evaluateAll();
    hideProgress();
    renderAnalysisSummary(tSeg, performance.now() - t0);
    renderAll();
    if (state.settings.debug) renderDebug();
  } catch (e) {
    hideProgress();
    if (e.name === 'AbortError') showBanner('Analyse abgebrochen.', 'warn');
    else { console.error(e); showBanner('Analyse fehlgeschlagen: ' + esc(e.message), 'error', { sticky: true }); }
  } finally {
    $('#btn-analyze').disabled = !state.photo;
    if (state.abort === ac) state.abort = null;
  }
}

function renderAnalysisSummary(tSeg, tAll) {
  const st = state.seg.stats;
  const regs = state.regions;
  const nLarge = regs.filter(r => r.large).length;
  const nBorder = regs.filter(r => r.border || r.cut).length;
  const cands = regs.filter(r => r.candidate);
  const anyColorWish = state.wishlist.some(w => w.colorId == null);
  $('#an-summary').innerHTML = `
    <div class="stat-grid">
      <div><strong>${regs.length}</strong><span>Teile erkannt</span></div>
      <div><strong>${nLarge}</strong><span>evtl. mehrere Teile</span></div>
      <div><strong>${nBorder}</strong><span>am Bildrand</span></div>
      <div><strong>${cands.length}</strong><span>passen zur Suchliste</span></div>
    </div>
    <p class="muted small">Dauer: ${(tSeg / 1000).toFixed(1)} s Segmentierung, ${(tAll / 1000).toFixed(1)} s gesamt.
      ${anyColorWish ? 'Hinweis: Bei „Farbe egal“ kommen alle Ausschnitte in Frage.' : ''}</p>`;
  const warns = [...st.warnings];
  const bgL = state.bgLab ? state.bgLab[0] : 50;
  if (bgL > 80 && regs.length) warns.push('light');
  const text = { ...WARN_TEXT, light: 'Heller Hintergrund: weiße und hellgraue Teile heben sich evtl. kaum ab. Für helle Teile besser einen dunklen Untergrund nehmen.' };
  $('#an-warnings').innerHTML = warns.map(w => `<div class="banner warn inline">${esc(text[w] || w)}</div>`).join('');
  if (!regs.length) $('#an-warnings').innerHTML += '';
  const btn = $('#btn-recognize');
  btn.hidden = !cands.length;
  btn.textContent = `Mit Brickognize erkennen (${cands.length} Ausschnitte)`;
  if (!state.wishlist.length && regs.length) {
    $('#an-warnings').innerHTML += '<p class="muted small">Suchliste ist leer – keine Erkennung nötig. Prüfe in der Debug-Ansicht, ob die Teile sauber getrennt sind.</p>';
  }
  updateBadges();
}

async function runRecognition(list, { switchTab = true } = {}) {
  const regs = list || state.regions.filter(r => r.candidate && !r.cands);
  if (!regs.length) { showBanner('Alle Kandidaten wurden bereits geprüft.', 'info'); if (switchTab) showTab('result'); return; }
  if (state.abort) state.abort.abort();
  const ac = new AbortController();
  state.abort = ac;
  const bg = (state.bgRgb || [255, 255, 255]).map(Math.round);
  const jobs = regs.map(r => ({
    makeBlob: async () => {
      const c = cropRegion(state.photo, r, { hideOthers: state.settings.hideOthers, bgRgb: bg, maxSide: 512 });
      const b = await canvasToBlob(c, 'image/jpeg', 0.9);
      releaseCanvas(c);
      return b;
    },
    onResult: out => { r.cands = out.items.slice(0, 3); r.recogError = null; },
    onError: e => { r.recogError = e.message; },
  }));
  $('#btn-recognize').disabled = true;
  setProgress(0, `Erkenne 0 von ${jobs.length} Kandidaten …`);
  try {
    const res = await recognizeMany(jobs, {
      apiUrl: state.settings.apiUrl,
      parallel: state.settings.parallel,
      signal: ac.signal,
      onProgress: (done, total, failed) => {
        setProgress(done / total, `Erkenne ${done} von ${total} Kandidaten …${failed ? ` (${failed} fehlgeschlagen)` : ''}`);
        if (done % 5 === 0) { evaluateAll(); renderAll(); }
      },
    });
    if (res.failed) showBanner(`${res.failed} Ausschnitte konnten nicht geprüft werden: ${esc(res.errors[0].message)}`, 'warn', { sticky: true });
  } catch (e) {
    if (e.name === 'AbortError') showBanner('Erkennung abgebrochen. Bisherige Ergebnisse bleiben erhalten.', 'warn');
    else showBanner(esc(e.message), 'error', { sticky: true });
  } finally {
    hideProgress();
    $('#btn-recognize').disabled = false;
    if (state.abort === ac) state.abort = null;
    evaluateAll();
    renderAll();
    const left = state.regions.filter(r => r.candidate && !r.cands).length;
    $('#btn-recognize').textContent = left ? `Restliche ${left} Ausschnitte erkennen` : 'Erkennung abgeschlossen ✓';
    if (switchTab && !ac.signal.aborted) showTab('result');
  }
}

/* --------------------------------------------------------- Debug-Ansicht */

function renderDebug() {
  const seg = state.seg;
  if (!seg) return;
  $('#debug-card').hidden = false;
  const img = state.debugView === 'mask' ? seg.debug.maskCanvas : state.debugView === 'photo' ? state.photo.display : seg.debug.canvas;
  debugViewer.setImage(img, state.photo.width, state.photo.height);
  debugViewer.setBoxes(state.debugView === 'photo'
    ? state.regions.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h, color: r.large ? '#fb923c' : '#38bdf8', kind: 'other', dashed: r.large, id: r.id }))
    : []);
  const st = seg.stats;
  const f1 = v => (typeof v === 'number' ? (Math.round(v * 10) / 10) : v);
  const tiles = st.tiles.map(t =>
    `Kachel ${t.tile}: ${t.width}×${t.height} px, Regionen ${t.regions} (Komponenten ${t.components}, davon getrennt ${t.splitComponents}, wiedervereint ${t.merges}, Krümel entfernt ${t.removedSmall})\n` +
    `  Hintergrund Lab ${t.bgLab.map(f1).join(' / ')}, Rauschen ΔE ${f1(t.noiseDE)}, Otsu ΔE ${f1(t.otsuDE)} → Schwelle ΔE ${f1(t.thresholdDE)}\n` +
    `  Median-Fläche ${Math.round(t.medianArea)} px, Mindestfläche ${Math.round(t.minArea)} px, Vordergrund ${pct(t.fgFraction)}, mittlere Helligkeit L ${f1(t.meanL)}\n` +
    `  Zeiten ms: ${Object.entries(t.timings).map(([k, v]) => k + ' ' + v).join(', ')}` +
    (t.warnings.length ? `\n  Warnungen: ${t.warnings.join(', ')}` : '')).join('\n');
  $('#debug-stats').textContent =
    `Foto ${state.photo.width}×${state.photo.height} (Original ${state.photo.srcWidth}×${state.photo.srcHeight})\n` +
    `Modus ${st.mode}, Kacheln ${st.tileCount}, Regionen ${st.regions}, Median-Fläche (Original) ${Math.round(st.median)} px², groß ${st.large}\n` +
    `Hintergrund RGB ${state.bgRgb.map(Math.round).join(', ')} (${state.bgTap ? 'angetippt' : 'automatisch'}), ` +
    `Weißabgleich ${state.gains.map(g => g.toFixed(2)).join(' / ')}\n` +
    tiles;
  const rows = state.regions.slice(0, 500).map(r => {
    const c = r.color;
    const cell = n => n ? `<span class="chip sm" style="${swatchStyle(state.colorById.get(n.id))}"></span> ${esc(colorName(n.id))} <span class="muted">${n.dE.toFixed(1)}</span>` : '';
    const meas = c ? `<span class="chip sm" style="background:#${rgbToHex(labToRgb(c.lab))}"></span> ${c.lab.map(v => Math.round(v)).join('/')}` : '';
    const flags = [r.large && 'groß', (r.border || r.cut) && 'Rand', r.split && 'getrennt', r.manual && 'manuell', r.candidate && 'Kandidat'].filter(Boolean).join(', ');
    return `<tr data-id="${r.id}"><td>${r.id}</td><td>${Math.round(r.area)}</td><td>${meas}</td><td>${cell(c && c.best)}</td>` +
      `<td>${cell(c && c.alts[0])}</td><td>${cell(c && c.alts[1])}</td><td>${flags}</td></tr>`;
  }).join('');
  $('#debug-table').innerHTML = '<thead><tr><th>#</th><th>Fläche</th><th>Lab gemessen</th><th>Farbe 1 (ΔE)</th><th>Farbe 2</th><th>Farbe 3</th><th>Hinweise</th></tr></thead><tbody>' + rows + '</tbody>';
}

function initAnalysis() {
  $('#btn-analyze').addEventListener('click', runAnalysis);
  $('#btn-recognize').addEventListener('click', () => runRecognition());
  $('#btn-abort').addEventListener('click', () => { if (state.abort) state.abort.abort(); });
  debugViewer = new Viewer($('#debug-canvas'), {
    onTap: (x, y) => { const r = regionAt(x, y); if (r) openRegionDialog(r); },
  });
  for (const b of $$('#debug-mode .seg-btn')) {
    b.addEventListener('click', () => {
      $$('#debug-mode .seg-btn').forEach(x => x.classList.toggle('active', x === b));
      state.debugView = b.dataset.view;
      const keep = { s: debugViewer.s, tx: debugViewer.tx, ty: debugViewer.ty };
      renderDebug();
      Object.assign(debugViewer, keep);
      debugViewer.redraw();
    });
  }
  $('#debug-table').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    const r = tr && state.regions.find(x => x.id === Number(tr.dataset.id));
    if (r) openRegionDialog(r);
  });
}

/** Region an einer Originalkoordinate (Maske berücksichtigt, kleinste zuerst). */
function regionAt(x, y) {
  const inBox = state.regions.filter(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  const inMask = inBox.filter(r => {
    const mx = Math.floor((x - r.x) / r.mScale), my = Math.floor((y - r.y) / r.mScale);
    return r.mask[my * r.mw + mx];
  });
  const list = inMask.length ? inMask : inBox;
  list.sort((a, b) => a.area - b.area);
  return list[0] || null;
}

/* ============================================================== Ergebnis */

const STATUS_COLOR = { sure: '#22c55e', unsure: '#facc15' };

function resultBoxes() {
  return state.regions.map(r => {
    const res = r.result || { status: 'none' };
    const hit = res.status !== 'none';
    const w = hit ? state.wishlist.find(x => x.id === res.wishId) : null;
    let label = '';
    if (hit) label = `${w ? w.partNum : '?'} · ${w ? colorName(w.colorId) : ''} · ${res.colorFit === 'manual' ? '✔' : pct(res.score)}`;
    else if (r.recogError) label = '⚠ Fehler';
    return {
      id: r.id, x: r.x, y: r.y, w: r.w, h: r.h,
      color: hit ? STATUS_COLOR[res.status] : (r.candidate ? 'rgba(203,213,225,0.95)' : 'rgba(148,163,184,0.7)'),
      kind: r.id === state.selected ? 'selected' : hit ? 'hit' : 'other',
      label,
      dashed: r.large && !hit,
    };
  });
}

function renderAll() {
  renderResults();
  updateBadges();
}

function renderResults() {
  const regs = state.regions;
  const sum = summarize(regs, state.wishlist);
  const recognized = regs.some(r => r.cands || r.override);
  $('#res-summary').textContent = !regs.length ? 'Noch kein Ergebnis'
    : !recognized ? `${regs.length} Teile im Foto – Erkennung noch nicht gestartet`
      : `${sum.found} von ${sum.wanted} gesuchten Teilen gefunden`;
  $('#res-counters').innerHTML = state.wishlist.map(w => {
    const p = sum.per.get(w.id) || { sure: 0, unsure: 0 };
    const n = p.sure + p.unsure;
    const want = w.qty || 1;
    const c = w.colorId == null ? null : state.colorById.get(w.colorId);
    return `<div class="counter ${n >= want ? 'done' : n ? 'part' : ''}">
      <span class="chip sm" style="${swatchStyle(c)}"></span>
      <span class="mono">${esc(w.partNum)}</span> ${esc(colorName(w.colorId))}:
      <strong>${n}${w.qty ? ' / ' + w.qty : ''}</strong>
      ${p.unsure ? `<span class="muted small">(${p.sure} sicher, ${p.unsure} unsicher)</span>` : ''}
    </div>`;
  }).join('');

  if (state.photo && resultViewer) {
    if (resultViewer.img !== state.photo.display) resultViewer.setImage(state.photo.display, state.photo.width, state.photo.height);
    resultViewer.setDim(state.settings.dim);
    resultViewer.setBoxes(resultBoxes());
  }

  // Trefferliste
  const hits = regs.filter(r => r.result && r.result.status !== 'none')
    .sort((a, b) => (b.result.status === 'sure') - (a.result.status === 'sure') || b.result.score - a.result.score);
  $('#hit-empty').hidden = hits.length > 0;
  $('#hit-list').innerHTML = hits.map(r => {
    const w = state.wishlist.find(x => x.id === r.result.wishId);
    const st = r.result.status;
    const thumb = thumbFor(r);
    return `<li class="result hit-${st}" data-id="${r.id}">
      <img src="${thumb}" alt="" width="56" height="56">
      <div class="result-text">
        <div><span class="dot" style="background:${STATUS_COLOR[st]}"></span>
          <span class="mono">${esc(w ? w.partNum : '?')}</span> ${esc(w ? colorName(w.colorId) : '')}</div>
        <div class="small">${st === 'sure' ? 'sicher' : 'unsicher'} · ${r.result.colorFit === 'manual' ? 'manuell bestätigt' : 'Score ' + pct(r.result.score)}
          ${r.result.colorFit === 'alt' ? ' · Farbe nur ähnlich' : ''}</div>
        <div class="muted small">gemessen: ${esc(r.color ? colorName(r.color.best.id) : '?')}</div>
      </div>
    </li>`;
  }).join('');
}

/** Kleines Vorschaubild einer Region (gecacht als Data-URL). */
function thumbFor(r) {
  if (r._thumb) return r._thumb;
  if (!state.photo) return PLACEHOLDER_IMG;
  const c = cropRegion(state.photo, r, { hideOthers: false, maxSide: 112, pad: 0.1 });
  r._thumb = c.toDataURL('image/jpeg', 0.8);
  releaseCanvas(c);
  return r._thumb;
}

function setManual(on) {
  state.manual = on;
  resultViewer.rectMode = on;
  $('#btn-manual').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#btn-manual').classList.toggle('active', on);
  $('#manual-hint').hidden = !on;
}

async function addManualRegion(rect) {
  if (!state.photo) return;
  if (!state.bgLab) {
    const s = state.bgTap ? state.bgTap.rgb : borderMedianRgb(state.photo.display.getContext('2d').getImageData(0, 0, state.photo.display.width, state.photo.display.height));
    state.bgRgb = s; state.bgLab = srgbToLab(...s.map(Math.round));
  }
  const r = regionFromRect(state.photo, rect, state.bgLab, srgbToLab);
  if (!r) return;
  r.id = state.regions.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  measureRegionColor(r);
  state.regions.push(r);
  evaluateAll();
  r.candidate = true;
  state.selected = r.id;
  renderAll();
  openRegionDialog(r);
  if (state.wishlist.length) await recognizeOne(r);
}

async function recognizeOne(r) {
  $('#dr-nocands').textContent = 'Frage Brickognize …';
  await runRecognition([r], { switchTab: false });
  if (state.dialogRegion === r) fillRegionDialog(r);
}

function initResults() {
  resultViewer = new Viewer($('#result-canvas'), {
    onTap: (x, y, info) => {
      if (info.manual) {
        const side = Math.sqrt(state.seg ? state.seg.stats.median || 0 : 0) * 1.6 || Math.max(state.photo.width, state.photo.height) / 15;
        addManualRegion({ x: x - side / 2, y: y - side / 2, w: side, h: side });
        return;
      }
      const b = resultViewer.boxAt(x, y);
      const r = b && state.regions.find(q => q.id === b.id);
      if (r) { state.selected = r.id; renderResults(); openRegionDialog(r); }
    },
    onRect: rect => addManualRegion(rect),
  });
  for (const b of $$('#dim-mode .seg-btn')) {
    b.classList.toggle('active', b.dataset.dim === state.settings.dim);
    b.addEventListener('click', () => {
      $$('#dim-mode .seg-btn').forEach(x => x.classList.toggle('active', x === b));
      state.settings.dim = b.dataset.dim;
      saveSettings(state.settings);
      resultViewer.setDim(state.settings.dim);
    });
  }
  $('#btn-manual').addEventListener('click', () => {
    if (!state.photo) { showBanner('Erst ein Foto laden.', 'warn'); return; }
    setManual(!state.manual);
  });
  $('#btn-fit').addEventListener('click', () => resultViewer.fit());
  $('#btn-export').addEventListener('click', exportPng);
  $('#hit-list').addEventListener('click', e => {
    const li = e.target.closest('[data-id]');
    const r = li && state.regions.find(x => x.id === Number(li.dataset.id));
    if (!r) return;
    state.selected = r.id;
    renderResults();
    $('#result-canvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
    resultViewer.zoomTo(r);
  });
}

async function exportPng() {
  if (!state.photo) { showBanner('Kein Foto vorhanden.', 'warn'); return; }
  const p = state.photo;
  const s = Math.min(1, 3000 / Math.max(p.width, p.height));
  const c = makeCanvas(p.width * s, p.height * s);
  const ctx = c.getContext('2d');
  ctx.drawImage(p.orig, 0, 0, c.width, c.height);
  const boxes = resultBoxes().map(b => (b.kind === 'selected' ? { ...b, kind: state.regions.find(r => r.id === b.id)?.result?.status !== 'none' ? 'hit' : 'other' } : b));
  const ui = Math.max(1, c.width / 1100);
  drawBoxes(ctx, boxes, state.settings.dim, s, 0, 0, p.width, p.height, ui);
  // Zusammenfassung unten links
  const text = $('#res-summary').textContent + ' · LEGO-Teilefinder ' + new Date().toLocaleDateString('de-DE');
  ctx.font = `600 ${16 * ui}px -apple-system, system-ui, sans-serif`;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(15,23,42,0.8)';
  ctx.fillRect(0, c.height - 30 * ui, tw + 20 * ui, 30 * ui);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 10 * ui, c.height - 15 * ui);
  try {
    const blob = await canvasToBlob(c, 'image/png');
    const file = new File([blob], 'lego-treffer.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'LEGO-Treffer' }); } catch (e) { if (e.name !== 'AbortError') throw e; }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lego-treffer.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  } catch (e) {
    showBanner('Export fehlgeschlagen: ' + esc(e.message), 'error');
  } finally {
    releaseCanvas(c);
  }
}

/* ======================================================== Region-Dialog */

function openRegionDialog(r) {
  state.dialogRegion = r;
  fillRegionDialog(r);
  const dlg = $('#dlg-region');
  if (!dlg.open) { dlg.returnValue = ''; dlg.showModal(); }
}

function fillRegionDialog(r) {
  $('#dr-title').textContent = `Teil #${r.id}`;
  const box = $('#dr-crop');
  const old = box.querySelector('canvas');
  if (old) releaseCanvas(old);
  box.innerHTML = '';
  if (state.photo) {
    const c = cropRegion(state.photo, r, { hideOthers: false, maxSide: 360, pad: 0.2 });
    // Umriss einzeichnen: Box
    box.appendChild(c);
  }
  const res = r.result || { status: 'none' };
  const w = res.wishId ? state.wishlist.find(x => x.id === res.wishId) : null;
  $('#dr-status').innerHTML = res.status === 'none'
    ? '<span class="pill">kein Treffer</span>'
    : `<span class="pill ${res.status}">${res.status === 'sure' ? 'sicher' : 'unsicher'}</span> ${esc(w ? wishLabel(w) : '')}` +
      (res.colorFit === 'manual' ? ' <span class="muted small">(manuell)</span>' : ` <span class="muted small">Score ${pct(res.score)}</span>`);
  $('#dr-flags').textContent = [
    `${Math.round(r.w)}×${Math.round(r.h)} px`,
    r.large && 'auffällig groß – evtl. mehrere Teile',
    (r.border || r.cut) && 'am Rand abgeschnitten',
    r.split && 'von Nachbarteil getrennt',
    r.manual && 'manuell markiert',
  ].filter(Boolean).join(' · ');
  const c = r.color;
  $('#dr-color').innerHTML = c ? `
    <div><span class="chip" style="background:#${rgbToHex(labToRgb(c.lab))}"></span> gemessen
      <span class="muted">(Lab ${c.lab.map(v => Math.round(v)).join('/')})</span></div>
    ${[c.best, ...c.alts].map((n, i) => `<div><span class="chip sm" style="${swatchStyle(state.colorById.get(n.id))}"></span>
      ${i ? '' : '<strong>'}${esc(colorName(n.id))}${i ? '' : '</strong>'} <span class="muted">ΔE ${n.dE.toFixed(1)}</span></div>`).join('')}` : '';

  // Kandidaten
  const cands = r.cands || [];
  $('#dr-cands').innerHTML = cands.map(cd => {
    const fit = state.wishlist.filter(x => partMatches(cd.id, x.partNum, state.index));
    return `<li class="result static">
      <img loading="lazy" src="${esc(cd.img || partImageUrl(cd.id))}" alt="" width="56" height="56">
      <div class="result-text">
        <div><span class="mono">${esc(cd.id)}</span> <span class="score">${pct(cd.score)}</span></div>
        <div class="result-name">${esc(cd.name)}</div>
        ${fit.length ? `<div class="small ok-text">passt zu: ${fit.map(x => esc(wishLabel(x))).join(', ')}</div>` : ''}
      </div></li>`;
  }).join('');
  $('#dr-nocands').textContent = r.recogError ? 'Fehler: ' + r.recogError
    : cands.length ? '' : 'Noch nicht mit Brickognize geprüft' + (r.candidate ? '.' : ' (Farbe passt zu keinem Suchteil).');

  // Korrektur
  const sel = $('#dr-wish');
  sel.innerHTML = state.wishlist.map(x => `<option value="${x.id}">${esc(wishLabel(x))} – ${esc(x.partName)}</option>`).join('');
  if (res.wishId) sel.value = res.wishId;
  else {
    // Vorauswahl: Suchteil, zu dem ein Kandidat passt
    const guess = state.wishlist.find(x => cands.some(cd => partMatches(cd.id, x.partNum, state.index)));
    if (guess) sel.value = guess.id;
  }
  $('#dr-confirm').disabled = !state.wishlist.length;
  $('#dr-recog').textContent = cands.length ? '🔍 Erneut prüfen' : '🔍 Brickognize';
}

function initRegionDialog() {
  const after = () => {
    evaluateAll();
    renderAll();
    if (state.settings.debug && state.seg) renderDebug();
    fillRegionDialog(state.dialogRegion);
  };
  $('#dr-confirm').addEventListener('click', () => {
    const r = state.dialogRegion;
    r.override = { status: 'sure', wishId: $('#dr-wish').value };
    after();
  });
  $('#dr-reject').addEventListener('click', () => {
    const r = state.dialogRegion;
    r.override = { status: 'none', wishId: null };
    after();
  });
  $('#dr-reset').addEventListener('click', () => {
    delete state.dialogRegion.override;
    after();
  });
  $('#dr-recog').addEventListener('click', async () => {
    const r = state.dialogRegion;
    r.cands = null;
    r.candidate = true;
    await recognizeOne(r);
    after();
  });
  $('#dlg-region').addEventListener('close', () => {
    const c = $('#dr-crop canvas');
    if (c) releaseCanvas(c);
    $('#dr-crop').innerHTML = '';
  });
}

/* ======================================================== Einstellungen */

function fillSettingsForm(s) {
  $('#set-mode').value = s.mode;
  $('#set-tiles').value = String(s.tiles);
  $('#set-wb').value = s.wb;
  $('#set-tol').value = s.colorTol;
  $('#set-checkall').checked = s.checkAll;
  $('#set-hideothers').checked = s.hideOthers;
  $('#set-debug').checked = s.debug;
  $('#set-api').value = s.apiUrl;
  $('#set-parallel').value = s.parallel;
  $('#set-sure').value = s.scoreSure;
  $('#set-unsure').value = s.scoreUnsure;
  $('#api-test-result').textContent = '';
}

function readSettingsForm() {
  const num = (sel, def, min, max) => {
    const v = Number($(sel).value);
    return $(sel).value !== '' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  return {
    ...state.settings,
    mode: $('#set-mode').value,
    tiles: Number($('#set-tiles').value) || 1,
    wb: $('#set-wb').value,
    colorTol: num('#set-tol', DEFAULTS.colorTol, 3, 40),
    checkAll: $('#set-checkall').checked,
    hideOthers: $('#set-hideothers').checked,
    debug: $('#set-debug').checked,
    apiUrl: ($('#set-api').value.trim() || DEFAULTS.apiUrl).replace(/\/+$/, ''),
    parallel: Math.round(num('#set-parallel', DEFAULTS.parallel, 1, 6)),
    scoreSure: num('#set-sure', DEFAULTS.scoreSure, 0, 1),
    scoreUnsure: num('#set-unsure', DEFAULTS.scoreUnsure, 0, 1),
  };
}

function initSettings() {
  const dlg = $('#dlg-settings');
  $('#app-version').textContent = 'Version ' + APP_VERSION;
  $('#btn-settings').addEventListener('click', () => {
    fillSettingsForm(state.settings);
    renderDataStatus();
    dlg.returnValue = '';
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    const before = state.settings;
    state.settings = readSettingsForm();
    saveSettings(state.settings);
    showBanner('Einstellungen gespeichert.', 'ok');
    if (state.regions.length) {
      evaluateAll();
      renderAll();
      if (before.mode !== state.settings.mode || before.tiles !== state.settings.tiles || before.wb !== state.settings.wb) {
        showBanner('Einstellungen gespeichert. Für Modus/Kacheln/Weißabgleich die Analyse neu starten.', 'info');
      }
    }
    $('#debug-card').hidden = !(state.settings.debug && state.seg);
    if (state.settings.debug && state.seg) renderDebug();
    updateAnalyzeHint();
  });
  $('#btn-settings-reset').addEventListener('click', () => fillSettingsForm(resetSettings()));
  $('#btn-api-test').addEventListener('click', async () => {
    const out = $('#api-test-result');
    const url = ($('#set-api').value.trim() || DEFAULTS.apiUrl).replace(/\/+$/, '');
    out.textContent = 'Teste …';
    try {
      const r = await testConnection(url);
      out.innerHTML = `<span class="ok-text">✔ Verbindung ok (${r.ms} ms)</span>` +
        (r.first ? ` – Testbild erkannt als ${esc(r.first.id)} (${pct(r.first.score)})` : '');
    } catch (e) {
      out.innerHTML = `<span class="err-text">✘ ${esc(e.message)}</span>`;
    }
  });
  $('#btn-data-reload').addEventListener('click', async () => {
    dlg.close('cancel');
    await reloadData();
  });
  $('#data-import').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    dlg.close('cancel');
    showBanner('Importiere …', 'info', { sticky: true });
    try {
      const data = await importFiles(files, msg => { $('#search-status').textContent = msg; });
      if (data) { applyData(data); showBanner('Import erfolgreich.', 'ok'); }
      else showBanner('Import gespeichert, aber es fehlen noch parts.csv und/oder colors.csv.', 'warn', { sticky: true });
    } catch (err) {
      showBanner('Import fehlgeschlagen: ' + esc(err.message), 'error', { sticky: true });
    }
  });
}

/* ======================================================= Service Worker */

function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offerUpdate = worker => {
      showBanner('Neue Version verfügbar. <button id="btn-update" class="btn small">Jetzt neu laden</button>', 'info', { sticky: true });
      $('#btn-update').addEventListener('click', () => worker.postMessage('skipWaiting'));
    };
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
  }).catch(e => console.warn('Service Worker nicht registriert', e));
  // Nur bei einem UPDATE neu laden – nicht beim allerersten Besuch (da übernimmt der SW ebenfalls die Kontrolle)
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

/* ================================================================ Start */

function init() {
  initTabs();
  initSearch();
  initExampleSearch();
  initPartDialog();
  initWishlist();
  initPhoto();
  initAnalysis();
  initResults();
  initRegionDialog();
  initSettings();
  initServiceWorker();
  renderWishlist();
  updateAnalyzeHint();
  initData();
  window.addEventListener('offline', () => showBanner('Offline – Suche und Segmentierung funktionieren weiter, die Erkennung (Brickognize) braucht Internet.', 'warn'));
}

window.addEventListener('error', e => { if (e.message) showBanner('Fehler: ' + esc(e.message), 'error'); });
window.addEventListener('unhandledrejection', e => {
  const m = (e.reason && e.reason.message) || String(e.reason);
  if (e.reason && e.reason.name === 'AbortError') return;
  showBanner('Fehler: ' + esc(m), 'error');
});

init();

// Für Tests und die Browser-Konsole
window.__app = { state, runAnalysis, runRecognition, openRegionDialog };
