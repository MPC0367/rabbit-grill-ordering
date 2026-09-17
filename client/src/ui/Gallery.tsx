// /ui-kit (development only): the living styleguide.
//   ?embed=guest&lang=th   guest specimens only (used by the phone frame)
//   ?open=sheet|service|categories|dialog|drawer|weigh   open a modal on load (screenshots)
import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { Locale } from '../../../shared/settings.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useRoute } from '../lib/router.ts';
import { storage } from '../lib/store.ts';
import { ToastProvider } from './Toast.tsx';
import { LangToggle, Wordmark } from './Brand.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';
import { Skeleton } from './Feedback.tsx';
import { useIsoLayoutEffect } from './cx.ts';
import GalleryGuest, { GUEST_SECTIONS } from './GalleryGuest.tsx';
import './Gallery.css';

// The staff kit's gallery is optional: glob returns {} when the file does not exist yet.
const adminModules = import.meta.glob<{ default: ComponentType }>('./admin/GalleryAdmin.tsx');
const adminLoader = adminModules['./admin/GalleryAdmin.tsx'];
const GalleryAdmin = lazy<ComponentType>(() =>
  adminLoader ? adminLoader() : Promise.reject(new Error('ui/admin/GalleryAdmin.tsx has not been written yet.')),
);

class Boundary extends Component<{ children: ReactNode; fallback: (error: Error) => ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.warn('[ui-kit] staff gallery failed to render:', error.message);
  }
  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

// The staff gallery mounts its own I18nProvider (English first when nothing is
// stored). Store the outer provider's starting language (App's default, Thai)
// before either renders so both galleries open in the same language.
try {
  if (typeof window !== 'undefined' && !window.localStorage.getItem('rg.lang')) window.localStorage.setItem('rg.lang', 'th');
} catch { /* storage unavailable: the galleries may start in different languages */ }

type Frame = 'full' | 'phone';
const FRAME_KEY = 'rg.kit.frame';

export default function Gallery() {
  const { query } = useRoute();
  const { lang, setLang } = useI18n();
  const embed = query.get('embed');
  const qLang = query.get('lang');

  useEffect(() => {
    if ((qLang === 'th' || qLang === 'en') && qLang !== lang) setLang(qLang as Locale);
    // follow the query only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qLang]);

  useEffect(() => {
    document.title = 'UI kit · Rabbit Grill';
  }, []);

  if (embed === 'guest') {
    return (
      <ToastProvider>
        <div className="kit kit--embed">
          <main className="kit__main" data-scope="guest">
            <GalleryGuest />
          </main>
        </div>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <GalleryPage />
    </ToastProvider>
  );
}

function GalleryPage() {
  const { lang, setLang } = useI18n();
  // Persist the language so the staff gallery (its own I18nProvider) starts in the same one.
  useIsoLayoutEffect(() => { setLang(lang); }, [lang, setLang]);
  const [frame, setFrameState] = useState<Frame>(() => storage.get<Frame>(FRAME_KEY, 'full'));
  const setFrame = (f: Frame) => { setFrameState(f); storage.set(FRAME_KEY, f); };
  const L = (th: string, en: string) => (lang === 'th' ? th : en);

  return (
    <div className="kit">
      <a className="skip" href="#kit-main">{L('ข้ามไปที่เนื้อหา', 'Skip to content')}</a>
      <header className="kit__bar">
        <div className="kit__brand">
          <Wordmark variant="staff" sub="Khao Yai · Design" />
          <h1 className="kit__title" lang="en">UI kit</h1>
        </div>
        <div className="kit__controls">
          <SegmentedControl<Frame>
            label={L('กรอบแสดงผล', 'Preview frame')}
            value={frame}
            onChange={setFrame}
            options={[{ value: 'full', label: L('เต็มความกว้าง', 'Full width') }, { value: 'phone', label: L('กรอบมือถือ', 'Phone frame') }]}
          />
          <LangToggle />
        </div>
        <nav className="kit__jump" aria-label={L('ไปยังส่วน', 'Jump to section')}>
          {frame === 'full' ? GUEST_SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} lang="en">{label}</a>) : null}
          <a href="#staff-kit" lang="en">Staff kit</a>
        </nav>
      </header>

      <main className="kit__main" id="kit-main" tabIndex={-1}>
        <section className="kit__part" aria-labelledby="guest-kit-h">
          <div className="kit__part-h">
            <h2 id="guest-kit-h">{L('ชุดหน้าลูกค้า', 'Guest kit')}</h2>
            {lang === 'th' ? <p className="en" lang="en">Guest kit</p> : null}
          </div>
          <p className="kit__lede">
            {L(
              'ชื่อจาน ราคา และรูปมาจากเมนูจริงของร้าน (data-src/catalog.json) โต๊ะ เวลา เลขอ้างอิง และรายการร่างเป็นข้อมูลตัวอย่าง',
              'Dish names, prices and photos come from the restaurant’s own menu (data-src/catalog.json). Table, times, references and the draft are fixtures.',
            )}
          </p>
          {frame === 'phone' ? (
            <div className="kit-phone">
              <iframe key={lang} title={L('ชุดหน้าลูกค้าในกรอบมือถือ 390px', 'Guest kit in a 390px phone frame')} src={`/ui-kit?embed=guest&lang=${lang}`} />
            </div>
          ) : (
            <div data-scope="guest"><GalleryGuest /></div>
          )}
        </section>

        <section className="kit__part" id="staff-kit" aria-labelledby="staff-kit-h">
          <div className="kit__part-h">
            <h2 id="staff-kit-h">{L('ชุดหน้าพนักงาน', 'Staff kit')}</h2>
            {lang === 'th' ? <p className="en" lang="en">Staff kit</p> : null}
          </div>
          <Boundary
            key={lang}
            fallback={(error) => (
              <div className="kit-boundary" role="status">
                <h3>{L('ยังแสดงชุดหน้าพนักงานไม่ได้', 'The staff kit gallery is not available')}</h3>
                <p lang="en">{error.message}</p>
              </div>
            )}
          >
            <Suspense fallback={<div className="kit-boundary" aria-busy="true"><Skeleton lines={3} /></div>}>
              <GalleryAdmin key={lang} />
            </Suspense>
          </Boundary>
        </section>
      </main>
    </div>
  );
}
