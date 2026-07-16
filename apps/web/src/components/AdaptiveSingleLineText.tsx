import { useLayoutEffect, useRef, useState } from 'react';

export function AdaptiveSingleLineText({ text, className = '', maxFontSize = 16 }: { text: string; className?: string; maxFontSize?: number }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(maxFontSize);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    let frame = 0;
    const fit = () => {
      // Measure at the design size on every resize so the text grows again
      // when more horizontal room becomes available.
      element.style.fontSize = `${maxFontSize}px`;
      const fullWidth = element.scrollWidth;
      const availableWidth = element.clientWidth;
      const nextSize = fullWidth > 0 ? Math.min(maxFontSize, Math.max(1, (maxFontSize * availableWidth) / fullWidth)) : maxFontSize;
      element.style.fontSize = `${nextSize}px`;
      setFontSize(nextSize);
    };
    fit();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(element);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [maxFontSize, text]);

  return <span ref={textRef} className={`adaptive-single-line-text ${className}`} style={{ fontSize }} title={text}>{text}</span>;
}
