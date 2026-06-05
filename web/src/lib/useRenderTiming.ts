"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useDashboardStore } from "./store";

/**
 * Measures Chart.js render-and-paint time for a component.
 *
 * Pattern:
 *   - useLayoutEffect runs after React commit but BEFORE the browser paints,
 *     so we capture the start near render-end.
 *   - useEffect + requestAnimationFrame fires after the browser paints,
 *     so the elapsed time captures the full render → paint cycle.
 *
 * All samples are appended to the rolling window in the store; the median
 * is robust to the cold-mount outlier (Chart.js plugin registration spike on
 * first paint) without explicit filtering. Steady-state re-renders are what
 * we care about for the "is React render really 8-15 ms?" sanity check.
 *
 * Pass `dep` (e.g. the chart's data prop) so we re-time on every data update,
 * not on every render of unrelated state.
 */
export function useRenderTiming(name: string, dep: unknown) {
  const startRef = useRef<number>(0);
  const addChartRenderTiming = useDashboardStore(
    (s) => s.addChartRenderTiming
  );

  useLayoutEffect(() => {
    startRef.current = performance.now();
  });

  useEffect(() => {
    const start = startRef.current;
    if (start === 0) return;
    const raf = requestAnimationFrame(() => {
      const elapsed = performance.now() - start;
      addChartRenderTiming(name, elapsed);
    });
    return () => cancelAnimationFrame(raf);
  }, [dep, name, addChartRenderTiming]);
}
