/**
 * Language detection + canned reply lines — pure functions, no I/O.
 *
 * The twins answer in the asker's language, but the canned refusal / rate-limit /
 * unavailable lines must NEVER come from a model (they fire exactly when we are
 * refusing to call one). So they are hand-written per language here. Detection is
 * a cheap deterministic heuristic: it runs on raw untrusted text, which is safe
 * because nothing here is stored, logged or prompted — it only picks a label.
 *
 * "other" is reserved in the Lang union for future detectors; every canned-line
 * helper falls back to English for it.
 */

export type Lang = "ru" | "en" | "es" | "other";

const LETTER_RE = /\p{L}/u;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

/** One of these characters alone is a strong Spanish signal. */
const SPANISH_CHAR_RE = /[¿¡ñÑ]/;

/** Common Spanish words; two distinct hits (incl. the "por favor" phrase) → es. */
const SPANISH_WORDS = ["como", "para", "qué", "cómo", "gracias", "hola"] as const;

/**
 * Heuristic: cyrillic-letter ratio > 0.25 → ru; else Spanish signals → es;
 * else en. Ratio is computed over letters only so URLs/emoji do not dilute it.
 */
export function detectLanguage(text: string): Lang {
  const t = text ?? "";
  let letters = 0;
  let cyrillic = 0;
  for (const ch of t) {
    if (!LETTER_RE.test(ch)) continue;
    letters++;
    if (CYRILLIC_RE.test(ch)) cyrillic++;
  }
  if (letters > 0 && cyrillic / letters > 0.25) return "ru";

  if (SPANISH_CHAR_RE.test(t)) return "es";
  const lower = t.toLowerCase();
  // Unicode-aware tokenisation: \b does not work next to accented letters (qué).
  const tokens = new Set(lower.split(/[^\p{L}]+/u).filter((w) => w.length > 0));
  let signals = 0;
  for (const w of SPANISH_WORDS) if (tokens.has(w)) signals++;
  if (lower.includes("por favor")) signals++;
  if (signals >= 2) return "es";

  return "en";
}

type LineTable = Readonly<Record<"en" | "ru" | "es", string>>;

const REFUSAL: LineTable = {
  en: "Message rejected by the safety filter. Describe what you need in plain language — no model-control commands, no hidden payloads.",
  ru: "Сообщение отклонено фильтром безопасности. Опишите вопрос обычным языком — без команд для управления моделью и скрытых вставок.",
  es: "Mensaje rechazado por el filtro de seguridad. Describe tu pregunta con lenguaje sencillo — sin comandos de control del modelo ni cargas ocultas.",
};

const RATE_LIMIT: LineTable = {
  en: "Easy there — too many questions at once. Give it a minute and ask again.",
  ru: "Полегче — слишком много вопросов подряд. Подождите минуту и спросите снова.",
  es: "Con calma — demasiadas preguntas seguidas. Espera un minuto y vuelve a preguntar.",
};

const UNAVAILABLE: LineTable = {
  en: "The twin is catching his breath — even demigods rest between rounds. Try again shortly.",
  ru: "Близнец переводит дух — даже полубоги отдыхают между раундами. Попробуйте чуть позже.",
  es: "El gemelo está recuperando el aliento — hasta los semidioses descansan entre asaltos. Inténtalo de nuevo en un momento.",
};

const DEFLECTION: LineTable = {
  en: "I keep my own counsel. Ask me about the AICOM ecosystem instead — that I answer gladly.",
  ru: "Свои правила я держу при себе. Спросите лучше про экосистему AICOM — на это отвечу с радостью.",
  es: "Mis reglas me las guardo. Pregúntame sobre el ecosistema AICOM — eso lo respondo con gusto.",
};

function pick(table: LineTable, lang: Lang): string {
  return lang === "ru" || lang === "es" ? table[lang] : table.en;
}

/** Canned reply when AEGIS rejects the input (never reaches a model). */
export function refusalLine(lang: Lang): string {
  return pick(REFUSAL, lang);
}

/** Canned reply when a rate limiter blocks the question (never reaches a model). */
export function rateLimitLine(lang: Lang): string {
  return pick(RATE_LIMIT, lang);
}

/** Canned reply when the LLM is down or the daily budget is spent. */
export function unavailableLine(lang: Lang): string {
  return pick(UNAVAILABLE, lang);
}

/** Canned reply when the output guard detects system-prompt / marker leakage. */
export function deflectionLine(lang: Lang): string {
  return pick(DEFLECTION, lang);
}
