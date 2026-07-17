import { describe, expect, it } from 'vitest';
import { describeSplitFactor } from '../shared/splitRatio';

describe('describeSplitFactor', () => {
  it('formats forward splits as old:new and labels the direction', () => {
    expect(describeSplitFactor(8)).toEqual({ direction: '拆股', ratio: '1:8', label: '拆股 1:8' });
    expect(describeSplitFactor(1.5)).toEqual({ direction: '拆股', ratio: '2:3', label: '拆股 2:3' });
  });

  it('formats reverse splits as old:new and labels the direction', () => {
    expect(describeSplitFactor(0.25)).toEqual({ direction: '并股', ratio: '4:1', label: '并股 4:1' });
    expect(describeSplitFactor(0.1)).toEqual({ direction: '并股', ratio: '10:1', label: '并股 10:1' });
  });

  it('handles no-op and invalid factors without inventing a direction', () => {
    expect(describeSplitFactor(1)).toEqual({ direction: '比例', ratio: '1:1', label: '比例 1:1' });
    expect(describeSplitFactor(0)).toEqual({ direction: '比例', ratio: '未知', label: '比例未知' });
  });
});
