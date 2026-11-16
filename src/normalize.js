// Cleanup rules for messy form data (CLAUDE.md §7 "Normalisation"). Pure functions — unit-tested in tests/.

// Emoji, skin tones, variation selectors, zero-width joiner, keycap mark.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;

/** Remove emoji, collapse whitespace, trim. */
export function clean(v) {
  return String(v ?? '').replace(EMOJI, '').replace(/\s+/g, ' ').trim();
}

/** Comparison key: cleaned, lowercase, and . - _ treated as spaces. */
export function keyOf(v) {
  return clean(v).toLowerCase().replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function titleCase(v) {
  return clean(v).toLowerCase().replace(/(^|[\s/(])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}

/** "geetanshu " / "DEEP" → "Geetanshu" / "Deep". */
export const person = (v) => titleCase(v);

// First match wins — order matters.
const DEPT_RULES = [
  [/^(sm|smm)$|soc|ocial|social/, 'Social Media'],
  [/seo/, 'SEO'],
  [/^we?bi?s?i?te|^web/, 'Website'],
  [/^mar?k[ea]?r?ting|^digital marketing/, 'Marketing'],
  [/^(tech|development)|tech ?\/ ?dev/, 'Tech / Development'],
  [/^(hr)$/, 'HR'],
];

export function dept(v) {
  const k = keyOf(v);
  if (!k) return '(Not specified)';
  for (const [re, label] of DEPT_RULES) if (re.test(k)) return label;
  return titleCase(v);
}

const PROJECT_ALIASES = {
  'Meyash Hospital': ['meyash', 'meyash hospital'],
  'NatureMania': ['nature mania', 'naturemania'],
  'Wayveda': ['wayveda', 'way veda'],
  'Lifestyle': ['lifestyle', 'lifestyle channel'],
  'Psychology Seekho': ['psychology seekho', 'psycology seekho'],
  'Dr Neha Mehta': ['dr neha mehta', 'dr neha', 'neha mehta'],
  'College Knowledge': ['ck', 'college knowledge', 'collegeknowledge'],
  'DCA': ['dca', 'digital chaabi academy'],
  'Digital Chaabi': ['dc', 'digital chaabi'],
  'Hari Har': ['hari har', 'harihar', 'hari har seeds'],
  'Kissan Ratan': ['kissan ratan', 'kisan ratan'],
  'My Fit Brain': ['my fit brain', 'myfitbrain', 'mfb'],
  'Asha Mehta Ki Rasoi': ['asha mehta ki rasoi', 'asha mehta'],
  'Life at MeDa': ['life at meda'],
  'MeDa': ['meda', 'meda partners'],
  'Intimacy Academy': ['intimacy academy'],
  'Dr Vibhor': ['vibhor', 'dr vibhor'],
};
const PROJECT_MAP = new Map(Object.entries(PROJECT_ALIASES).flatMap(([label, keys]) => keys.map((k) => [k, label])));

export function project(v) {
  const k = keyOf(v);
  if (!k) return '(Not specified)';
  return PROJECT_MAP.get(k) || titleCase(v);
}

export const PRIORITY_LABELS = ['Urgent', 'High', 'Normal', 'Low', 'Not set'];

/** "🔴 Urgent (Today)" → 0 … unknown/blank → 4. */
export function priority(v) {
  const k = keyOf(v);
  if (k.includes('urgent')) return 0;
  if (k.includes('high')) return 1;
  if (k.includes('normal')) return 2;
  if (k.includes('low')) return 3;
  return 4;
}

/** "TSK-391" → 391; anything else → null. */
export function idNum(v) {
  const m = /^\s*TSK-(\d+)\s*$/i.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
}

/** 7 → "TSK-007", 1576 → "TSK-1576". */
export const padId = (n) => 'TSK-' + String(n).padStart(3, '0');

// --- Dates. Sheets serial numbers are IST wall-clock days since 1899-12-30. ---
const IST_MS = 5.5 * 3600 * 1000;
const DAY_MS = 86400000;

export const serialNow = (nowMs = Date.now()) => (nowMs + IST_MS) / DAY_MS + 25569;
export const serialToMs = (serial) => (serial - 25569) * DAY_MS - IST_MS;

/** Cell value → epoch ms, or null when the cell isn't a date serial. */
export const toMs = (v) => (typeof v === 'number' && v > 0 ? serialToMs(v) : null);

/** "2026-11-20" (from <input type=date>) → whole-day serial, as the form writes deadlines. */
export function isoDateToSerial(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS + 25569;
}

/** IST "dd/MM/yyyy" and "HH:mm:ss" text, as the Coordinator tab stores them. */
export function istDateTimeText(nowMs = Date.now()) {
  const d = new Date(nowMs + IST_MS);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}

/** Stops a typed value being read as a formula if someone later pastes it with USER_ENTERED. */
export function safeText(v, max = 2000) {
  const s = String(v ?? '').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
