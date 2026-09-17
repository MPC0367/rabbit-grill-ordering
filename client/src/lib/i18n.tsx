// Thai-first bilingual UI.
//
//   const { t, lang, setLang, pick } = useI18n();
//   t('cart.send')                        → "ส่งออร์เดอร์"
//   t('cart.items', { n: 3 })             → "3 รายการ"      ({name} placeholders)
//   const name = pick(item.name)          → { text, lang, fallback }
//   <span lang={name.lang}>{name.text}</span>
//
// Switching language never remounts the app: state, cart, open sheets and
// scroll position all survive. Missing Thai data falls back VISIBLY to the
// original language (pick().fallback === true) instead of inventing a translation.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Bilingual } from '../../../shared/dto.ts';
import type { Locale } from '../../../shared/settings.ts';
import { dictionaries } from '../i18n/index.ts';

const STORAGE_KEY = 'rg.lang';

function storedLang(): Locale | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'th' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

export interface Picked { text: string; lang: Locale; fallback: boolean }

interface I18nApi {
  lang: Locale;
  setLang: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  has: (key: string) => boolean;
  pick: (b: Bilingual | null | undefined) => Picked;
  /** Both languages, current first: for bilingual labels on staff tickets. */
  both: (b: Bilingual | null | undefined) => { primary: Picked; secondary: Picked | null };
}

const I18nContext = createContext<I18nApi | null>(null);

let fadeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The short opacity change on a language switch (brief 42, --dur-base). CSS
 * animates the app root and any open sheet while <html data-lang-switch> is
 * set; nothing remounts, so state, scroll and open sheets are kept.
 */
function fadeLanguage(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  delete root.dataset.langSwitch;
  void root.offsetWidth; // restart the fade on a quick second switch
  root.dataset.langSwitch = '';
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => { delete root.dataset.langSwitch; }, 400);
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function I18nProvider({ children, scope, defaultLang = 'th' }: { children: ReactNode; scope: 'guest' | 'admin'; defaultLang?: Locale }) {
  const [lang, setLangState] = useState<Locale>(() => storedLang() ?? defaultLang);
  const current = useRef(lang);
  current.current = lang;

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dataset.scope = scope;
  }, [lang, scope]);

  const setLang = useCallback((l: Locale) => {
    if (l !== current.current) fadeLanguage();
    setLangState(l);
    try { window.localStorage.setItem(STORAGE_KEY, l); } catch { /* private mode */ }
  }, []);

  const value = useMemo<I18nApi>(() => {
    const primary = dictionaries[lang];
    const other = dictionaries[lang === 'th' ? 'en' : 'th'];
    const t = (key: string, vars?: Record<string, string | number>) => {
      const s = primary[key] ?? other[key];
      if (s === undefined) {
        if (import.meta.env.DEV) console.warn(`[i18n] missing key ${key}`);
        return key;
      }
      return interpolate(s, vars);
    };
    const pick = (b: Bilingual | null | undefined): Picked => {
      const want = b?.[lang];
      if (want) return { text: want, lang, fallback: false };
      const alt: Locale = lang === 'th' ? 'en' : 'th';
      const got = b?.[alt];
      if (got) return { text: got, lang: alt, fallback: true };
      return { text: '', lang, fallback: true };
    };
    const both = (b: Bilingual | null | undefined) => {
      const p = pick(b);
      const altLang: Locale = p.lang === 'th' ? 'en' : 'th';
      const alt = b?.[altLang];
      return { primary: p, secondary: alt && alt !== p.text ? { text: alt, lang: altLang, fallback: false } : null };
    };
    return { lang, setLang, t, has: (key) => key in primary || key in other, pick, both };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nApi {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

export function useT() {
  return useI18n().t;
}
