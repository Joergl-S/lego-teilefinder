/**
 * search.js – Lokaler Suchindex für Rebrickable-Teile.
 *
 * Eigener, schlanker Index statt Fuse.js: Bei ~60 000 Teilen ist ein linearer
 * Durchlauf über vorab zerlegte Namen auf dem iPad schnell genug (wenige ms)
 * und liefert für Teilenummern und Maßangaben („2 x 4“) bessere Treffer als
 * eine unscharfe Suche.
 *
 * Außerdem: Variantenfamilien aus part_relationships (Print, Pattern, Mold,
 * Alternate), damit später z. B. „3001“ auch „3001pr0001“ zuordnen kann.
 */

/** Zerlegt Text in Suchwörter. „2x4“ → [„2“, „x“, „4“]. */
export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/(\d)\s*x(?=\s|\d|$)/g, '$1 x ')   // 2x4 → 2 x 4, „1x“ → 1 x
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Beziehungstypen, die als „gleiches Teil, andere Variante“ gelten. */
const VARIANT_TYPES = new Set(['P', 'T', 'M', 'A']);
/** Typen, deren Kind eine bedruckte/gemusterte Version ist. */
const PRINT_TYPES = new Set(['P', 'T']);
/** Fallback, falls part_relationships fehlt: typische Rebrickable-Suffixe. */
const PRINT_RE = /(pr|pat|pb|px)\d/i;

/** Kommen die Suchwörter als zusammenhängende Folge von Wortanfängen im Namen vor? */
function inSequence(tokens, q, lastIdx) {
  outer: for (let i = 0; i + q.length <= tokens.length; i++) {
    for (let k = 0; k < q.length; k++) {
      const t = tokens[i + k], w = q[k];
      const exact = k < lastIdx && /^\d+$/.test(w);
      if (exact ? t !== w : !t.startsWith(w)) continue outer;
    }
    return true;
  }
  return false;
}

export class PartIndex {
  /**
   * @param {Array} parts         [[part_num, name, cat_id], ...]
   * @param {Object} categories   {cat_id: name}
   * @param {Array} relationships [[type, child, parent], ...]
   */
  constructor(parts, categories = {}, relationships = []) {
    this.categories = categories;
    this.byNum = new Map();
    this.entries = parts.map(([num, name, cat]) => {
      const e = {
        num,
        numLower: num.toLowerCase(),
        name,
        nameNorm: tokenize(name).join(' '),
        tokens: tokenize(name),
        cat,
        isPrint: false,
      };
      this.byNum.set(num, e);
      return e;
    });

    // Varianten per Union-Find gruppieren
    this.parent = new Map();
    const hasRel = relationships.length > 0;
    for (const [type, child, par] of relationships) {
      if (PRINT_TYPES.has(type)) {
        const e = this.byNum.get(child);
        if (e) e.isPrint = true;
      }
      if (VARIANT_TYPES.has(type)) this._union(child, par);
    }
    if (!hasRel) for (const e of this.entries) e.isPrint = PRINT_RE.test(e.num);

    // Familien als Listen für schnellen Zugriff
    this.families = new Map();
    for (const num of this.parent.keys()) {
      const root = this._find(num);
      if (!this.families.has(root)) this.families.set(root, []);
      this.families.get(root).push(num);
    }
  }

  _find(x) {
    let p = this.parent.get(x);
    if (p === undefined) { this.parent.set(x, x); return x; }
    while (p !== x) {
      const gp = this.parent.get(p);
      this.parent.set(x, gp);   // Pfadverkürzung
      x = p; p = gp;
    }
    return x;
  }

  _union(a, b) {
    const ra = this._find(a), rb = this._find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  get(num) {
    return this.byNum.get(num) || null;
  }

  categoryName(catId) {
    return this.categories[catId] || '';
  }

  /** Alle Teilenummern derselben Variantenfamilie (inkl. num selbst). */
  family(num) {
    if (!this.parent.has(num)) return [num];
    return this.families.get(this._find(num)) || [num];
  }

  /**
   * Sucht nach Teilenummer oder Name.
   * @returns {Array} Einträge, bestes Ergebnis zuerst
   */
  search(query, { limit = 60, hidePrints = true } = {}) {
    const raw = query.trim().toLowerCase();
    if (!raw) return [];
    const qTokens = tokenize(raw);
    const qNorm = qTokens.join(' ');
    const compact = raw.replace(/\s+/g, '');
    const lastIdx = qTokens.length - 1;
    // Schneller Vorfilter: das längste Suchwort muss irgendwo im Namen vorkommen
    const longest = qTokens.reduce((a, b) => (b.length > a.length ? b : a), '');
    const scored = [];

    for (const e of this.entries) {
      let score = -1;

      // 1) Teilenummer
      if (e.numLower === compact) score = 1000;
      else if (compact.length >= 2 && e.numLower.startsWith(compact)) score = 800 - (e.numLower.length - compact.length);

      // 2) Name: jedes Suchwort muss am Anfang eines Namenswortes passen.
      //    Reine Zahlen müssen exakt passen (außer das zuletzt getippte Wort),
      //    damit „2 x 4“ nicht „2 x 42“ findet.
      if (score < 0 && qTokens.length && e.nameNorm.includes(longest)) {
        // Jedes Suchwort braucht ein EIGENES Namenswort („1 x 1“ ≠ „1 x 2“)
        const used = new Uint8Array(e.tokens.length);
        let ok = true;
        for (let i = 0; i < qTokens.length && ok; i++) {
          const q = qTokens[i];
          const exact = i < lastIdx && /^\d+$/.test(q);
          const k = e.tokens.findIndex((t, j) => !used[j] && (exact ? t === q : t.startsWith(q)));
          if (k < 0) ok = false; else used[k] = 1;
        }
        if (ok) {
          score = 500 - e.tokens.length * 3 - e.name.length / 20;
          if (inSequence(e.tokens, qTokens, lastIdx)) score += 40;   // Wörter in der richtigen Reihenfolge
          if (e.nameNorm.startsWith(qNorm)) score += 30;              // Name beginnt mit der Suche
          if (e.tokens[0] === qTokens[0]) score += 10;
        }
      }

      if (score < 0) continue;
      if (hidePrints && e.isPrint && score < 1000) continue;   // exakte Nummer immer zeigen
      scored.push([score, e]);
    }

    scored.sort((a, b) => b[0] - a[0] || a[1].num.length - b[1].num.length);
    return scored.slice(0, limit).map(s => s[1]);
  }
}

/** URL eines Vorschaubildes bei Rebrickable (LDraw-Rendering in der gewählten Farbe). */
export function partImageUrl(partNum, colorId) {
  const c = colorId == null || colorId < 0 ? 71 : colorId;   // 71 = Light Bluish Gray als neutrale Vorschau
  return `https://cdn.rebrickable.com/media/parts/ldraw/${c}/${encodeURIComponent(partNum)}.png`;
}

/** Platzhalterbild, falls Rebrickable kein Rendering hat. */
export const PLACEHOLDER_IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#e2e8f0"/>' +
  '<rect x="12" y="28" width="40" height="20" rx="2" fill="#94a3b8"/><rect x="17" y="21" width="10" height="8" rx="2" fill="#94a3b8"/>' +
  '<rect x="37" y="21" width="10" height="8" rx="2" fill="#94a3b8"/></svg>');
