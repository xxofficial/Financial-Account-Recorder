import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';
import type { BitmapCoordinatesRenderingScope } from 'fancy-canvas';

export interface CustomTradeMarker {
  time: Time;
  position: 'aboveBar' | 'belowBar';
  text: 'B' | 'S';
  color: string;
}

class TradeMarkersRenderer implements IPrimitivePaneRenderer {
  constructor(
    private _markers: CustomTradeMarker[],
    private _series: ISeriesApi<'Candlestick'>,
    private _chart: IChartApiBase<Time>
  ) {}

  draw(target: { useBitmapCoordinateSpace(f: (scope: BitmapCoordinatesRenderingScope) => void): void }) {
    target.useBitmapCoordinateSpace((scope) => {
      const { context: ctx, horizontalPixelRatio, verticalPixelRatio } = scope;
      const radius = 5 * Math.max(horizontalPixelRatio, verticalPixelRatio);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (const marker of this._markers) {
        const candle = this._series
          .data()
          .find((d) => d.time === marker.time) as { high: number; low: number } | undefined;
        if (!candle) continue;

        const price = marker.position === 'aboveBar' ? candle.high : candle.low;
        const x = this._chart.timeScale().timeToCoordinate(marker.time);
        const y = this._series.priceToCoordinate(price);
        if (x === null || y === null) continue;

        const bx = x * horizontalPixelRatio;
        const by = y * verticalPixelRatio;

        ctx.beginPath();
        ctx.arc(bx, by, radius, 0, Math.PI * 2);
        ctx.fillStyle = marker.color;
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.max(8, Math.round(radius * 1.1))}px sans-serif`;
        ctx.fillText(marker.text, bx, by);
      }
    });
  }
}

class TradeMarkersPaneView implements IPrimitivePaneView {
  constructor(
    private _markers: CustomTradeMarker[],
    private _series: ISeriesApi<'Candlestick'>,
    private _chart: IChartApiBase<Time>
  ) {}

  zOrder() {
    return 'top' as const;
  }

  renderer() {
    return new TradeMarkersRenderer(this._markers, this._series, this._chart);
  }
}

export class TradeMarkersPrimitive implements ISeriesPrimitive {
  private _markers: CustomTradeMarker[] = [];
  private _series: ISeriesApi<'Candlestick'> | null = null;
  private _chart: IChartApiBase<Time> | null = null;
  private _requestUpdate: (() => void) | null = null;

  attached(param: SeriesAttachedParameter<Time, 'Candlestick'>) {
    this._series = param.series;
    this._chart = param.chart;
    this._requestUpdate = param.requestUpdate;
  }

  detached() {
    this._series = null;
    this._chart = null;
    this._requestUpdate = null;
  }

  setMarkers(markers: CustomTradeMarker[]) {
    this._markers = markers;
    this._requestUpdate?.();
  }

  paneViews() {
    if (!this._series || !this._chart) return [];
    return [new TradeMarkersPaneView(this._markers, this._series, this._chart)];
  }
}
