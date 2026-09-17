// Engagement tracker - "was this element really on screen long enough?"
//
// A dwell observer reports an element once its visible part has met a
// criterion continuously for `minMs` while the page was visible:
//   - dish cards: at least 50% of the card's area for 1 s (item_impression);
//   - category sections: at least half the section, or at least 30% of the
//     viewport height for tall sections, for 1 s (category_view).
// IntersectionObserver does the work for cards. It only reports - it never
// gates or reveals anything on screen. Where it is missing or never reports
// (some embedded views), a throttled getBoundingClientRect pass on scroll and
// on the tracker tick takes over. Category sections are always measured that
// way because a tall section's viewport coverage changes without crossing any
// element-ratio threshold.

export interface Box { w: number; h: number }

export interface DwellOptions<M> {
  minMs: number;
  /** Visible part (clipped to the viewport) vs the element's own box. */
  meets(visible: Box, box: Box, viewportH: number): boolean;
  thresholds: number[];
  /** Measure with getBoundingClientRect on scroll/tick even when IO works. */
  alwaysMeasure: boolean;
  now(): number;
  /** Page visible and tracker ready. */
  canCount(): boolean;
  onDwell(key: string, meta: M): void;
}

export interface DwellObserver<M> {
  observe(el: Element, key: string, meta: M): () => void;
  /**
   * Restart dwell clocks: the page became visible again or counting became
   * possible (newSession = false), or a new session began and every element
   * may be reported once more (newSession = true).
   */
  rearm(newSession: boolean): void;
  /** Page hidden: dwell must be continuous, so every clock stops. */
  pause(): void;
  /** Called on the tracker's 1 s tick. */
  poll(): void;
  count(): number;
  dispose(): void;
}

interface Entry<M> {
  key: string;
  meta: M;
  meets: boolean;
  since: number | null;
  /** Generation in which this element was reported. */
  firedGen: number;
}

const IO_SILENT_MS = 2_000;
const MEASURE_THROTTLE_MS = 250;

export const itemCriterion = (visible: Box, box: Box): boolean => {
  const area = box.w * box.h;
  return area > 0 && (visible.w * visible.h) / area >= 0.5;
};

export const categoryCriterion = (visible: Box, box: Box, viewportH: number): boolean =>
  visible.w > 0 && visible.h > 0 && (visible.h >= box.h * 0.5 || (viewportH > 0 && visible.h >= viewportH * 0.3));

export function createDwellObserver<M>(opts: DwellOptions<M>): DwellObserver<M> {
  const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';
  const entries = new Map<Element, Entry<M>>();
  let generation = 1;
  let io: IntersectionObserver | null = null;
  let ioSeen = false;
  let measuring = opts.alwaysMeasure;
  let listening = false;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let silentTimer: ReturnType<typeof setTimeout> | null = null;
  let measureTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMeasure = -Infinity;
  const offs: Array<() => void> = [];

  function viewport(): Box {
    return { w: window.innerWidth || document.documentElement.clientWidth, h: window.innerHeight || document.documentElement.clientHeight };
  }

  function measure(el: Element): boolean {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const vp = viewport();
    const visible = {
      w: Math.max(0, Math.min(r.right, vp.w) - Math.max(r.left, 0)),
      h: Math.max(0, Math.min(r.bottom, vp.h) - Math.max(r.top, 0)),
    };
    return opts.meets(visible, { w: r.width, h: r.height }, vp.h);
  }

  function update(entry: Entry<M>, meets: boolean, now: number) {
    entry.meets = meets;
    if (meets && opts.canCount() && entry.firedGen !== generation) entry.since ??= now;
    else entry.since = null;
  }

  function arm() {
    if (dwellTimer !== null) { clearTimeout(dwellTimer); dwellTimer = null; }
    let due = Infinity;
    for (const e of entries.values()) if (e.since !== null) due = Math.min(due, e.since + opts.minMs);
    if (due === Infinity) return;
    dwellTimer = setTimeout(fire, Math.max(20, due - opts.now() + 5));
  }

  function fire() {
    dwellTimer = null;
    const now = opts.now();
    if (!opts.canCount()) { for (const e of entries.values()) e.since = null; return; }
    for (const [el, e] of entries) {
      if (e.since === null || now - e.since < opts.minMs || e.firedGen === generation) continue;
      if (measuring && !measure(el)) { update(e, false, now); continue; }
      e.firedGen = generation;
      e.since = null;
      try { opts.onDwell(e.key, e.meta); } catch { /* never throw into the page */ }
    }
    arm();
  }

  function measureAll() {
    measureTimer = null;
    lastMeasure = opts.now();
    const now = lastMeasure;
    for (const [el, e] of entries) {
      if (e.firedGen === generation) continue;
      update(e, measure(el), now);
    }
    arm();
  }

  function measureSoon() {
    if (!measuring || measureTimer !== null) return;
    const wait = Math.max(0, MEASURE_THROTTLE_MS - (opts.now() - lastMeasure));
    measureTimer = setTimeout(measureAll, wait);
  }

  function listen() {
    if (listening || !hasDom) return;
    listening = true;
    const onScroll = () => measureSoon();
    const capture = { capture: true, passive: true } as const;
    document.addEventListener('scroll', onScroll, capture);
    window.addEventListener('resize', onScroll, { passive: true });
    offs.push(() => document.removeEventListener('scroll', onScroll, capture));
    offs.push(() => window.removeEventListener('resize', onScroll));
  }

  function startMeasuring() {
    measuring = true;
    listen();
    measureSoon();
  }

  if (hasDom && !opts.alwaysMeasure && typeof IntersectionObserver === 'function') {
    try {
      io = new IntersectionObserver((list) => {
        ioSeen = true;
        const now = opts.now();
        for (const item of list) {
          const e = entries.get(item.target);
          if (!e) continue;
          const vh = item.rootBounds?.height ?? viewport().h;
          const meets = item.isIntersecting && opts.meets(
            { w: item.intersectionRect.width, h: item.intersectionRect.height },
            { w: item.boundingClientRect.width, h: item.boundingClientRect.height },
            vh,
          );
          update(e, meets, now);
        }
        arm();
      }, { threshold: opts.thresholds });
    } catch {
      io = null;
    }
  }
  if (opts.alwaysMeasure || !io) startMeasuring();

  return {
    observe(el, key, meta) {
      if (!hasDom) return () => {};
      const entry: Entry<M> = { key, meta, meets: false, since: null, firedGen: 0 };
      entries.set(el, entry);
      if (io) {
        io.observe(el);
        if (!ioSeen && silentTimer === null) {
          silentTimer = setTimeout(() => {
            silentTimer = null;
            if (!ioSeen && entries.size > 0) startMeasuring();
          }, IO_SILENT_MS);
        }
      }
      if (measuring) measureSoon();
      return () => {
        if (entries.get(el) !== entry) return;
        entries.delete(el);
        io?.unobserve(el);
      };
    },

    rearm(newSession) {
      if (newSession) generation++;
      const now = opts.now();
      if (measuring) {
        measureAll();
        return;
      }
      for (const e of entries.values()) update(e, e.meets, now);
      arm();
    },

    pause() {
      for (const e of entries.values()) e.since = null;
      if (dwellTimer !== null) { clearTimeout(dwellTimer); dwellTimer = null; }
    },

    poll() {
      if (measuring) measureSoon();
      else if (dwellTimer === null) {
        // Elements that met the criterion while counting was not possible yet.
        const now = opts.now();
        let changed = false;
        for (const e of entries.values()) {
          if (e.meets && e.since === null && e.firedGen !== generation && opts.canCount()) { e.since = now; changed = true; }
        }
        if (changed) arm();
      }
    },

    count: () => entries.size,

    dispose() {
      io?.disconnect();
      io = null;
      for (const off of offs) off();
      offs.length = 0;
      for (const t of [dwellTimer, silentTimer, measureTimer]) if (t !== null) clearTimeout(t);
      dwellTimer = silentTimer = measureTimer = null;
      entries.clear();
    },
  };
}
