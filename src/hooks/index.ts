import { useState, useEffect, useRef } from "react";

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useCountUp(value: number): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      from.current = value;
      setShown(value);
      return;
    }
    const start = from.current;
    const delta = value - start;
    if (Math.abs(delta) < 0.1 || prefersReducedMotion()) {
      from.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    const DUR = 600;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / DUR);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(start + delta * eased);
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown;
}

export function useMinDwell(on: boolean, minMs = 4000) {
  const [shown, setShown] = useState(on);
  const shownAt = useRef(0);
  useEffect(() => {
    if (on) {
      if (!shown) {
        shownAt.current = Date.now();
        setShown(true);
      }
      return;
    }
    if (!shown) return;
    const held = Date.now() - shownAt.current;
    if (held >= minMs) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(false), minMs - held);
    return () => clearTimeout(t);
  }, [on, shown, minMs]);
  return shown;
}

export function useLatch(on: boolean, reset: boolean) {
  const [latched, setLatched] = useState(false);
  useEffect(() => {
    if (reset) setLatched(false);
    else if (on) setLatched(true);
  }, [on, reset]);
  return latched && !reset;
}

export function useHeldAmount(amount: number, minMs = 4000) {
  const on = amount > 0.00000001;
  const shown = useMinDwell(on, minMs);
  const last = useRef(amount);
  useEffect(() => {
    if (on) last.current = amount;
  }, [on, amount]);
  return { shown, amount: on ? amount : last.current };
}

export function useScanEta(scanned: number, total: number, active: boolean): number | null {
  const samples = useRef<{ t: number; n: number }[]>([]);
  const [eta, setEta] = useState<number | null>(null);
  useEffect(() => {
    if (!active || total <= 0) {
      samples.current = [];
      setEta(null);
      return;
    }
    const now = Date.now();
    const s = samples.current;
    if (s.length && scanned < s[s.length - 1].n) s.length = 0;
    if (!s.length || scanned !== s[s.length - 1].n) s.push({ t: now, n: scanned });
    while (s.length > 3 && now - s[0].t > 120_000) s.shift();
    if (s.length < 4) return;
    const spanSecs = (now - s[0].t) / 1000;
    if (spanSecs < 20) return;
    const rates: number[] = [];
    for (let i = 1; i < s.length; i++) {
      const dt = (s[i].t - s[i - 1].t) / 1000;
      const dn = s[i].n - s[i - 1].n;
      if (dt > 0.5 && dn > 0) rates.push(dn / dt);
    }
    if (rates.length < 3) return;
    rates.sort((a, b) => a - b);
    const rate = rates[Math.floor(rates.length / 2)];
    if (!(rate > 0)) return;
    setEta(Math.round(Math.max(0, total - scanned) / rate));
  }, [scanned, total, active]);
  return eta;
}

export function fmtEta(secs: number): string {
  if (secs < 45) return "under a minute left";
  const m = Math.round(secs / 60);
  if (m < 60) return `~${m} min left`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `~${h}h ${rem}m left` : `~${h}h left`;
}

export function useElapsedWhile(on: boolean): number | null {
  const [secs, setSecs] = useState<number | null>(null);
  const since = useRef<number | null>(null);
  useEffect(() => {
    if (!on) {
      since.current = null;
      setSecs(null);
      return;
    }
    if (since.current == null) since.current = Date.now();
    const tick = () => setSecs(Math.floor((Date.now() - (since.current ?? Date.now())) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [on]);
  return secs;
}
