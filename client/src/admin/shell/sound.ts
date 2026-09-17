// Staff alert sounds (brief 19, DESIGN §10.27).
//
//  - The chime is synthesised with Web Audio: no audio files to load or cache.
//  - Browsers only start audio after a user gesture, so the context is created
//    or resumed inside the alerts toggle, the Test button, or (when the
//    preference was already on) the first tap or key press on the page.
//  - The preference is stored per device (localStorage), never per account:
//    a kitchen tablet can chime while the owner's laptop stays quiet.
//  - useOrderAlerts() chimes only for events that arrive after the page
//    loaded. Events replayed on reconnect or by the polling fallback are
//    ignored, so catching up never plays one sound per historical record.
import { useCallback, useEffect, useRef } from 'react';
import { api } from '../../lib/api.ts';
import { useLive, useLiveEvent, type WireEvent } from '../../lib/live.tsx';
import { createStore, storage, useStore } from '../../lib/store.ts';
import type { Permission } from '../../../../shared/permissions.ts';

export type AlertKind = 'order' | 'request';

const PREF_KEY = 'rg.admin.alerts';

interface SoundState {
  enabled: boolean;
  /** The audio context is running (a gesture has unlocked it). */
  unlocked: boolean;
  /** Web Audio exists in this browser. */
  supported: boolean;
}

type AudioCtor = new () => AudioContext;

function audioCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

const soundStore = createStore<SoundState>({
  enabled: storage.get<boolean>(PREF_KEY, false) === true,
  unlocked: false,
  supported: audioCtor() !== null,
});

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function syncUnlocked(): void {
  const running = ctx?.state === 'running';
  soundStore.set((s) => (s.unlocked === running ? s : { ...s, unlocked: running }));
  if (running) disarmGesture();
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    const limiter = ctx.createDynamicsCompressor();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    ctx.addEventListener('statechange', syncUnlocked);
  } catch {
    ctx = null;
    master = null;
  }
  return ctx;
}

/** Call from a user gesture: creates or resumes the audio context. */
function unlock(): Promise<boolean> {
  const c = ensureContext();
  if (!c) return Promise.resolve(false);
  if (c.state === 'running') {
    syncUnlocked();
    return Promise.resolve(true);
  }
  return c.resume().then(
    () => { syncUnlocked(); return c.state === 'running'; },
    () => false,
  );
}

// ---------------------------------------------------------------- first-gesture unlock
const GESTURES = ['pointerup', 'keydown', 'click'] as const;
let armed = false;

function onGesture(): void {
  if (!soundStore.get().enabled) return;
  void unlock();
}

function armGesture(): void {
  if (armed || typeof document === 'undefined') return;
  armed = true;
  for (const g of GESTURES) document.addEventListener(g, onGesture, { capture: true, passive: true });
}

function disarmGesture(): void {
  if (!armed) return;
  armed = false;
  for (const g of GESTURES) document.removeEventListener(g, onGesture, { capture: true });
}

if (soundStore.get().enabled) armGesture();

/**
 * The owner's "Alert sound on for new devices" (settings.notifications.sound_default).
 * It applies only while this device has never chosen: a device choice always
 * wins, and it is not written to storage, so a later change of the owner
 * default still reaches devices nobody set (D-FX-OPS-01).
 */
export function applySoundDefault(on: boolean): void {
  if (storage.get<boolean | null>(PREF_KEY, null) !== null) return;
  soundStore.set((s) => (s.enabled === on ? s : { ...s, enabled: on }));
  if (on && !soundStore.get().unlocked) armGesture();
  if (!on) disarmGesture();
}

// Another tab on this device changed the preference.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PREF_KEY) return;
    const enabled = storage.get<boolean>(PREF_KEY, false) === true;
    soundStore.set((s) => ({ ...s, enabled }));
    if (enabled && !soundStore.get().unlocked) armGesture();
  });
}

// ---------------------------------------------------------------- synthesis
function partial(c: AudioContext, out: AudioNode, freq: number, start: number, dur: number, peak: number): void {
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, start);
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(env);
  env.connect(out);
  osc.start(start);
  osc.stop(start + dur + 0.05);
  osc.onended = () => { osc.disconnect(); env.disconnect(); };
}

/** A soft bell: fundamental plus two quiet overtones that die away faster. */
function bell(c: AudioContext, out: AudioNode, freq: number, start: number, dur: number, peak: number): void {
  partial(c, out, freq, start, dur, peak);
  partial(c, out, freq * 2, start, dur * 0.55, peak * 0.22);
  partial(c, out, freq * 3.01, start, dur * 0.3, peak * 0.07);
}

function chime(kind: AlertKind): boolean {
  const c = ctx;
  if (!c || !master || c.state !== 'running') return false;
  const t0 = c.currentTime + 0.02;
  if (kind === 'order') {
    // Rising fourth (G5 → C6): "a new round is here".
    bell(c, master, 783.99, t0, 1.1, 0.3);
    bell(c, master, 1046.5, t0 + 0.17, 1.5, 0.28);
  } else {
    // Two light taps on E6: "a table is asking for something".
    bell(c, master, 1318.5, t0, 0.42, 0.16);
    bell(c, master, 1318.5, t0 + 0.2, 0.6, 0.14);
  }
  return true;
}

const lastPlayed: Record<AlertKind, number> = { order: 0, request: 0 };
const MIN_GAP_MS = 2000;

/** Play an alert if the device has alerts on and audio is unlocked. A burst of events chimes once. */
export function playAlert(kind: AlertKind): boolean {
  if (!soundStore.get().enabled) return false;
  const now = Date.now();
  if (now - lastPlayed[kind] < MIN_GAP_MS) return false;
  // An order chime already covers a request arriving in the same moment.
  if (kind === 'request' && now - lastPlayed.order < 900) return false;
  if (!chime(kind)) {
    // Not unlocked yet: wait for the next gesture rather than failing loudly.
    armGesture();
    return false;
  }
  lastPlayed[kind] = now;
  return true;
}

/**
 * The Test button: unlocks audio (it runs inside the click) and plays the
 * order chime even while alerts are off, so staff can check the volume.
 * Resolves false when this browser cannot play sound.
 */
export function testAlert(): Promise<boolean> {
  return unlock().then((ok) => (ok ? chime('order') : false));
}

export interface AlertSound {
  enabled: boolean;
  setEnabled(v: boolean): void;
  test(): void;
  play(kind: AlertKind): void;
  /** Audio is running on this device (after a gesture). */
  unlocked: boolean;
  /** Web Audio is available at all. */
  supported: boolean;
  /** Same as test(), with the outcome. */
  testNow(): Promise<boolean>;
  /** Call from a tap: starts audio without playing anything. Resolves whether sound can now play. */
  resume(): Promise<boolean>;
}

export function useAlertSound(): AlertSound {
  const s = useStore(soundStore);
  const setEnabled = useCallback((v: boolean) => {
    storage.set(PREF_KEY, v);
    soundStore.set((p) => ({ ...p, enabled: v }));
    if (v) {
      armGesture();
      void unlock();
    } else {
      disarmGesture();
    }
  }, []);
  const test = useCallback(() => { void testAlert(); }, []);
  const play = useCallback((kind: AlertKind) => { playAlert(kind); }, []);
  return { enabled: s.enabled, setEnabled, test, play, unlocked: s.unlocked, supported: s.supported, testNow: testAlert, resume: unlock };
}

// ---------------------------------------------------------------- live alerts
/** Map a live event to the alert it deserves, or null. Creations only. */
export function alertKindFor(e: WireEvent, can: (p: Permission) => boolean): AlertKind | null {
  if (e.topic === 'order.created') return can('orders.view') ? 'order' : null;
  const created = e.entity.version === 1 && e.entity.id !== null;
  if (!created) return null;
  if (e.topic === 'service.updated' && e.payload.status === 'sent') return can('service.handle') ? 'request' : null;
  if (e.topic === 'portion.updated' && e.payload.status === 'requested') return can('portions.quote') ? 'request' : null;
  return null;
}

const CATCH_UP_TOLERANCE_MS = 1500;
/** While the stream reports trouble, events older than this are catch-up, not news. */
const CATCH_UP_AGE_MS = 4000;

export interface OrderAlertOptions {
  can: (p: Permission) => boolean;
  /** A recent server timestamp (e.g. OverviewDTO.server_time) to align clocks. */
  serverTime?: string | null;
  /** Called for every fresh alert-worthy event (sound or not), e.g. to announce it. */
  onAlert?: (kind: AlertKind, e: WireEvent) => void;
}

/**
 * Chime for rounds and requests created after this page loaded.
 *  - `floor`: the newest event id when the page connected. The polling
 *    fallback starts from 0, and anything at or below the floor is history.
 *  - `boundary`: the moment of the latest (re)connect. A reconnect replays
 *    what was missed, and those events are older than the reconnect, so they
 *    refresh the screens silently. The Orders badge still shows them.
 *  - The polling fallback delivers what it missed in one batch while the
 *    stream still counts as reconnecting: that batch is catch-up too.
 */
export function useOrderAlerts({ can, serverTime, onAlert }: OrderAlertOptions): void {
  const live = useLive();
  const floor = useRef<number | null>(null);
  const offset = useRef<{ ms: number; at: number } | null>(null);
  /** Client-clock time of the latest (re)connect. */
  const boundary = useRef<number>(Date.now());
  const canRef = useRef(can);
  canRef.current = can;
  const alertRef = useRef(onAlert);
  alertRef.current = onAlert;
  const liveState = useRef(live.state);
  liveState.current = live.state;

  // Clock alignment: network delay only ever makes a sample smaller, so keep
  // the largest recent one.
  useEffect(() => {
    if (!serverTime) return;
    const t = Date.parse(serverTime);
    if (!Number.isFinite(t)) return;
    const sample = t - Date.now();
    const prev = offset.current;
    const fresh = !prev || Date.now() - prev.at > 30 * 60_000;
    if (fresh || sample > prev.ms) offset.current = { ms: sample, at: Date.now() };
  }, [serverTime]);

  // The event floor at first connect.
  useEffect(() => {
    let cancelled = false;
    api.get<{ cursor: number }>('/api/staff/events/poll?since=0')
      .then((r) => { if (!cancelled) floor.current = r.cursor; })
      .catch(() => { /* the time boundary still protects against history */ });
    return () => { cancelled = true; };
  }, []);

  // Every (re)connect moves the catch-up boundary to "now".
  useEffect(() => live.onResync(() => { boundary.current = Date.now(); }), [live.onResync]);

  useLiveEvent(['order.created', 'service.updated', 'portion.updated'], (e) => {
    if (floor.current !== null && e.id <= floor.current) return;
    // Server time → this device's clock, with the best offset known right now.
    const at = Date.parse(e.at) - (offset.current?.ms ?? 0);
    if (!Number.isFinite(at)) return;
    if (at < boundary.current - CATCH_UP_TOLERANCE_MS) return;
    const st = liveState.current;
    if ((st === 'reconnecting' || st === 'offline') && at < Date.now() - CATCH_UP_AGE_MS) {
      // An old event delivered while the stream was down (the polling fallback's
      // catch-up batch): history, and so is the rest of that batch.
      boundary.current = Date.now();
      return;
    }
    const kind = alertKindFor(e, canRef.current);
    if (!kind) return;
    playAlert(kind);
    alertRef.current?.(kind, e);
  });
}
