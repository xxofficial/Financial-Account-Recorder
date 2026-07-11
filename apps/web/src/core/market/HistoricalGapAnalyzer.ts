import { db } from '../../db/localDb';

export class HistoricalGapAnalyzer {
  /**
   * Helper to get all weekday dates between start and end (inclusive)
   */
  static getWeekdayDates(startStr: string, endStr: string): string[] {
    const dates: string[] = [];
    const start = new Date(startStr);
    const end = new Date(endStr);
    const current = new Date(start);
    
    while (current <= end) {
      const day = current.getDay();
      // 0 = Sunday, 6 = Saturday
      if (day !== 0 && day !== 6) {
        dates.push(current.toISOString().split('T')[0]);
      }
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }

  /**
   * Find missing historical ranges for a given security and resolution
   */
  static async findMissingHistoricalRanges(input: {
    securityKey: string;
    resolution: '1d';
    requiredFromDate: string;
    requiredToDate: string;
  }): Promise<Array<{ fromDate: string; toDate: string }>> {
    const { securityKey, resolution, requiredFromDate, requiredToDate } = input;
    if (requiredFromDate > requiredToDate) {
      return [];
    }

    // 1. Fetch all bars for this security from database
    const allBars = await db.historicalBars
      .where('securityKey')
      .equals(securityKey)
      .toArray();

    // 2. Filter by resolution and date range
    const filteredBars = allBars.filter(
      b => b.resolution === resolution && b.tradeDate >= requiredFromDate && b.tradeDate <= requiredToDate
    );

    const existingDates = new Set(filteredBars.map(b => b.tradeDate));

    // 3. Generate all weekday dates in the required range
    const requiredWeekdays = this.getWeekdayDates(requiredFromDate, requiredToDate);

    // 4. Identify missing dates
    const missingDates = requiredWeekdays.filter(d => !existingDates.has(d));
    if (missingDates.length === 0) {
      return [];
    }

    // Sort missing dates ascending
    missingDates.sort((a, b) => a.localeCompare(b));

    // 5. Group missing dates into contiguous ranges
    const ranges: { fromDate: string; toDate: string }[] = [];
    let currentStart = missingDates[0];
    let currentEnd = missingDates[0];

    for (let i = 1; i < missingDates.length; i++) {
      const date = missingDates[i];
      const lastDate = new Date(currentEnd);
      const nextDate = new Date(date);
      const diffMs = nextDate.getTime() - lastDate.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

      // Weekend gaps are 3 days (Friday to Monday)
      if (diffDays <= 3) {
        currentEnd = date;
      } else {
        ranges.push({ fromDate: currentStart, toDate: currentEnd });
        currentStart = date;
        currentEnd = date;
      }
    }
    ranges.push({ fromDate: currentStart, toDate: currentEnd });

    return ranges;
  }
}
