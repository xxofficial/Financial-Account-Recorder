/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export function useSecondaryBack(fallback: string) {
  const navigate = useNavigate();
  return useCallback(() => {
    const historyState = window.history.state as { idx?: number } | null;
    if (typeof historyState?.idx === 'number' && historyState.idx > 0) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [fallback, navigate]);
}

export function useEdgeSwipeBack(enabled: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    let cancelled = false;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' || event.clientX > 32) return;
      const target = event.target as Element | null;
      if (target?.closest('[data-swipe-back-ignore], [role="dialog"], input, textarea, select, button, a')) return;
      start = { x: event.clientX, y: event.clientY };
      cancelled = false;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!start || cancelled) return;
      const dx = event.clientX - start.x;
      const dy = Math.abs(event.clientY - start.y);
      if (dy > 48 && dy > Math.abs(dx) * 0.8) cancelled = true;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!start || cancelled) { start = null; return; }
      const dx = event.clientX - start.x;
      const dy = Math.abs(event.clientY - start.y);
      start = null;
      if (dx >= 72 && dx > dy * 1.35) onBackRef.current();
    };
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerUp, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [enabled]);
}

export function SecondaryPageHeader({ title, fallback, right }: { title: ReactNode; fallback: string; right?: ReactNode }) {
  const goBack = useSecondaryBack(fallback);
  return <header className="secondary-page-header">
    <button type="button" className="icon-button" onClick={goBack} aria-label="返回"><ArrowLeft size={20} /></button>
    <h1>{title}</h1>
    <span className="secondary-page-header-right">{right}</span>
  </header>;
}
