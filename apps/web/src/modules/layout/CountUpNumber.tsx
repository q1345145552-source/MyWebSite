"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type CountUpNumberProps = {
  value: number;
  durationMs?: number;
  decimals?: number;
};

export default function CountUpNumber({ value, durationMs = 700, decimals = 0 }: CountUpNumberProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const prevValueRef = useRef(value);

  useEffect(() => {
    const from = prevValueRef.current;
    const to = value;
    if (from === to) return;

    let frame = 0;
    const start = performance.now();

    const run = (now: number) => {
      const progress = Math.min((now - start) / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(from + (to - from) * eased);
      if (progress < 1) {
        frame = requestAnimationFrame(run);
      } else {
        prevValueRef.current = to;
      }
    };

    frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
  }, [durationMs, value]);

  const text = useMemo(() => {
    return displayValue.toFixed(decimals);
  }, [decimals, displayValue]);

  return <>{text}</>;
}
