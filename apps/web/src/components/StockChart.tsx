import { useEffect, useRef, useState, useMemo } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type CandlestickData,
  type HistogramData,
  type LineData,
  CrosshairMode,
} from 'lightweight-charts';
import type { Transaction } from '../db/schema';
import {
  TradeMarkersPrimitive,
  type CustomTradeMarker,
} from '../core/chart/tradeMarkersPrimitive';
import {
  type ChartBar,
  type ChartRange,
  type CandlestickColorScheme,
  filterBarsByRange,
  getCandlestickColors,
  getVolumeColor,
  computeMovingAverage,
  buildTradeMarkers,
  MA_COLORS,
  MA_PERIODS,
} from '../core/chart/chartDataUtils';

interface StockChartProps {
  bars: ChartBar[];
  trades: Transaction[];
  timeRange: ChartRange;
  colorScheme?: CandlestickColorScheme;
  height?: number;
}

interface LegendData {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number | null;
  changePercent: number | null;
  ma: Record<number, number | null>;
}

function isCandlestickData(value: { time: Time }): value is CandlestickData {
  return 'open' in value && 'high' in value && 'low' in value && 'close' in value;
}

const formatPrice = (val: number | null | undefined) =>
  val == null ? '-' : val.toFixed(2);

const formatPercent = (val: number | null | undefined) => {
  if (val == null) return '-';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
};

export default function StockChart({
  bars,
  trades,
  timeRange,
  colorScheme = 'red_up',
  height = 320,
}: StockChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const maSeriesRefs = useRef<Map<number, ISeriesApi<'Line'>>>(new Map());
  const markersPrimitiveRef = useRef<TradeMarkersPrimitive | null>(null);
  const prevTimeRangeRef = useRef<ChartRange>(timeRange);

  const [legend, setLegend] = useState<LegendData | null>(null);

  const chartData = useMemo(() => {
    const filtered = filterBarsByRange(bars, timeRange);

    const candleData: CandlestickData[] = filtered.map((b) => ({
      time: b.time as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));

    const volumeData: HistogramData[] = filtered.map((b) => ({
      time: b.time as Time,
      value: b.volume,
      color: getVolumeColor(colorScheme, b.close >= b.open),
    }));

    const closeData = filtered.map((b) => ({ time: b.time, value: b.close }));
    const maData = MA_PERIODS.map((period) => ({
      period,
      data: computeMovingAverage(closeData, period)
        .filter((d): d is { time: string; value: number } => d.value !== null)
        .map((d) => ({ time: d.time as Time, value: d.value })),
    }));

    const markers = buildTradeMarkers(trades, {
      buyColor: '#22c55e',
      sellColor: '#ef4444',
    }).map(
      (m): CustomTradeMarker => ({
        time: m.time as Time,
        position: m.position,
        color: m.color,
        text: m.text,
      })
    );

    return { candleData, volumeData, maData, markers, filtered };
  }, [bars, timeRange, colorScheme, trades]);

  // Initialize chart
  useEffect(() => {
    if (!containerRef.current) return;
    const mountedMaSeries = maSeriesRefs.current;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#9ca3af',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.08)',
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: false,
      },
      autoSize: true,
    });

    const mainPane = chart.panes()[0];
    const volumePane = chart.addPane();
    mainPane.setStretchFactor(3);
    volumePane.setStretchFactor(1);

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      ...getCandlestickColors(colorScheme),
    }, 0);
    const markersPrimitive = new TradeMarkersPrimitive();
    candlestickSeries.attachPrimitive(markersPrimitive);

    MA_PERIODS.forEach((period) => {
      const maSeries = chart.addSeries(LineSeries, {
        color: MA_COLORS[`MA${period}`],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      }, 0);
      maSeriesRefs.current.set(period, maSeries);
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    }, 1);
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0 } });

    chart.subscribeCrosshairMove((param) => {
      const candles = candlestickSeries.data().filter(isCandlestickData);
      const candle = candles.find((d) => d.time === param.time);
      const volume = volumeSeries
        .data()
        .find((d) => d.time === param.time) as HistogramData | undefined;

      if (candle) {
        const idx = candles.findIndex((d) => d.time === param.time);
        const prev = idx > 0 ? candles[idx - 1] : null;
        const change = prev ? candle.close - prev.close : null;
        const changePercent =
          prev && prev.close !== 0 ? (change! / prev.close) * 100 : null;
        const ma: Record<number, number | null> = {};
        maSeriesRefs.current.forEach((series, period) => {
          const point = series
            .data()
            .find((d) => d.time === param.time) as LineData | undefined;
          ma[period] = point?.value ?? null;
        });

        setLegend({
          time: String(param.time),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: volume?.value ?? 0,
          change,
          changePercent,
          ma,
        });
      } else if (!param.time) {
        setLegend(null);
      }
    });

    chartRef.current = chart;
    candlestickSeriesRef.current = candlestickSeries;
    volumeSeriesRef.current = volumeSeries;
    markersPrimitiveRef.current = markersPrimitive;

    return () => {
      chart.remove();
      chartRef.current = null;
      candlestickSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markersPrimitiveRef.current = null;
      mountedMaSeries.clear();
    };
  }, [colorScheme]);

  // Update data
  useEffect(() => {
    if (
      !chartRef.current ||
      !candlestickSeriesRef.current ||
      !volumeSeriesRef.current
    )
      return;

    candlestickSeriesRef.current.setData(chartData.candleData);
    volumeSeriesRef.current.setData(chartData.volumeData);
    markersPrimitiveRef.current?.setMarkers(chartData.markers);

    maSeriesRefs.current.forEach((series, period) => {
      const ma = chartData.maData.find((m) => m.period === period);
      series.setData(ma?.data ?? []);
    });
  }, [chartData]);

  // Fit content when time range explicitly changes
  useEffect(() => {
    if (prevTimeRangeRef.current !== timeRange) {
      chartRef.current?.timeScale().fitContent();
      prevTimeRangeRef.current = timeRange;
    }
  }, [timeRange]);

  const latestMA = useMemo(() => {
    const ma: Record<number, number | null> = {};
    chartData.maData.forEach(({ period, data }) => {
      const last = data[data.length - 1];
      ma[period] = last?.value ?? null;
    });
    return ma;
  }, [chartData.maData]);

  const latestChange = useMemo(() => {
    const len = chartData.filtered.length;
    if (len < 2) return { change: null as number | null, changePercent: null as number | null };
    const current = chartData.filtered[len - 1];
    const prev = chartData.filtered[len - 2];
    const change = current.close - prev.close;
    const changePercent = prev.close !== 0 ? (change / prev.close) * 100 : null;
    return { change, changePercent };
  }, [chartData.filtered]);

  const latestBar = chartData.filtered[chartData.filtered.length - 1];
  const display = legend ??
    (latestBar
      ? {
          time: latestBar.time,
          open: latestBar.open,
          high: latestBar.high,
          low: latestBar.low,
          close: latestBar.close,
          volume: latestBar.volume,
          change: latestChange.change,
          changePercent: latestChange.changePercent,
          ma: latestMA,
        }
      : null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height }}>
      {display && (
        <div
          style={{
            height: 64,
            padding: '4px 8px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: '0.2rem',
            fontSize: '0.7rem',
            color: '#e2e8f0',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: '0.3rem 0.75rem',
            }}
          >
            <span style={{ fontWeight: 700 }}>{display.time}</span>
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: '0.3rem 0.75rem',
            }}
          >
            <span>开 {formatPrice(display.open)}</span>
            <span>高 {formatPrice(display.high)}</span>
            <span>低 {formatPrice(display.low)}</span>
            <span
              style={{
                color:
                  display.close >= display.open
                    ? getCandlestickColors(colorScheme).upColor
                    : getCandlestickColors(colorScheme).downColor,
              }}
            >
              收 {formatPrice(display.close)}
            </span>
            {display.change !== null && (
              <span
                style={{
                  color:
                    display.change >= 0
                      ? getCandlestickColors(colorScheme).upColor
                      : getCandlestickColors(colorScheme).downColor,
                }}
              >
                {formatPercent(display.changePercent)}
              </span>
            )}
            <span>量 {display.volume.toLocaleString()}</span>
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: '0.3rem 0.75rem',
            }}
          >
            {MA_PERIODS.map((period) => {
              const val = display.ma[period];
              return (
                <span key={period} style={{ color: MA_COLORS[`MA${period}`] }}>
                  MA{period}
                  {val != null ? ` ${formatPrice(val)}` : ''}
                </span>
              );
            })}
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, width: '100%', position: 'relative' }}
      />
    </div>
  );
}
