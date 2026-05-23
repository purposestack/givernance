/**
 * Pattern detection utilities for special donor segments
 */

import { sql } from "drizzle-orm";
import { withTenantContext } from "../../../lib/db.js";
import type { PatternConfig, PatternType } from "./types.js";

export interface DonationPattern {
  constituentId: string;
  pattern: PatternType;
  metadata?: Record<string, string | number | boolean>;
}

export class PatternDetector {
  private orgId: string;
  private config: PatternConfig;

  constructor(orgId: string, config: PatternConfig = {}) {
    this.orgId = orgId;
    this.config = {
      LYBUNT: { lookbackYears: 1, ...config.LYBUNT },
      SYBUNT: { lookbackYears: 5, ...config.SYBUNT },
      RECURRING: { minOccurrences: 3, windowMonths: 12, ...config.RECURRING },
      // 12 months — aligned with query-builder.ts LAPSED pattern (and FE preset copy).
      LAPSED: { monthsSinceLastDonation: 12, ...config.LAPSED },
      // Lifetime threshold — windowMonths kept here only for the
      // `detectMajorDonors()` admin helper, but query-builder.ts MAJOR_DONOR
      // is now lifetime (no window). The two will diverge on the rolling-window
      // detector below until the helper is rewritten lifetime-only.
      MAJOR_DONOR: { thresholdCents: 100000, windowMonths: 12, ...config.MAJOR_DONOR },
    };
  }

  /**
   * Detect LYBUNT (Last Year But Unfortunately Not This) donors
   */
  async detectLYBUNT(): Promise<string[]> {
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;

    const result = await withTenantContext(this.orgId, async (db) => {
      return await db.execute(sql`
        SELECT DISTINCT d1.constituent_id
        FROM donations d1
        WHERE d1.org_id = ${this.orgId}
          AND d1.status = 'cleared'
          AND EXTRACT(YEAR FROM d1.donated_at) = ${lastYear}
          AND NOT EXISTS (
            SELECT 1 FROM donations d2
            WHERE d2.constituent_id = d1.constituent_id
              AND d2.org_id = ${this.orgId}
              AND d2.status = 'cleared'
              AND EXTRACT(YEAR FROM d2.donated_at) = ${currentYear}
          )
      `);
    });

    return result.rows.map((row) => row.constituent_id as string) as string[];
  }

  /**
   * Detect SYBUNT (Some Year But Unfortunately Not This) donors
   */
  async detectSYBUNT(): Promise<string[]> {
    const currentYear = new Date().getFullYear();
    const lookbackYears = this.config.SYBUNT?.lookbackYears || 5;
    const startYear = currentYear - lookbackYears;

    const result = await withTenantContext(this.orgId, async (db) => {
      return await db.execute(sql`
        SELECT DISTINCT d1.constituent_id
        FROM donations d1
        WHERE d1.org_id = ${this.orgId}
          AND d1.status = 'cleared'
          AND EXTRACT(YEAR FROM d1.donated_at) >= ${startYear}
          AND EXTRACT(YEAR FROM d1.donated_at) < ${currentYear}
          AND NOT EXISTS (
            SELECT 1 FROM donations d2
            WHERE d2.constituent_id = d1.constituent_id
              AND d2.org_id = ${this.orgId}
              AND d2.status = 'cleared'
              AND EXTRACT(YEAR FROM d2.donated_at) = ${currentYear}
          )
      `);
    });

    return result.rows.map((row) => row.constituent_id as string) as string[];
  }

  /**
   * Detect recurring donors based on donation frequency
   */
  async detectRecurring(): Promise<Array<{ constituentId: string; frequency: string }>> {
    const windowMonths = this.config.RECURRING?.windowMonths || 12;
    const minOccurrences = this.config.RECURRING?.minOccurrences || 3;
    const windowStart = new Date();
    windowStart.setMonth(windowStart.getMonth() - windowMonths);

    const result = await withTenantContext(this.orgId, async (db) => {
      return await db.execute(sql`
        WITH donation_intervals AS (
          SELECT 
            constituent_id,
            donated_at,
            LAG(donated_at) OVER (PARTITION BY constituent_id ORDER BY donated_at) as prev_donated_at,
            EXTRACT(EPOCH FROM (donated_at - LAG(donated_at) OVER (PARTITION BY constituent_id ORDER BY donated_at))) / 86400 as days_between
          FROM donations
          WHERE org_id = ${this.orgId}
            AND status = 'cleared'
            AND donated_at >= ${windowStart}
        ),
        recurring_patterns AS (
          SELECT 
            constituent_id,
            COUNT(*) as donation_count,
            AVG(days_between) as avg_interval_days,
            STDDEV(days_between) as interval_stddev,
            CASE
              WHEN AVG(days_between) BETWEEN 25 AND 35 THEN 'monthly'
              WHEN AVG(days_between) BETWEEN 80 AND 100 THEN 'quarterly'
              WHEN AVG(days_between) BETWEEN 350 AND 380 THEN 'annual'
              WHEN AVG(days_between) BETWEEN 55 AND 65 THEN 'bi-monthly'
              ELSE 'irregular'
            END as frequency_pattern
          FROM donation_intervals
          WHERE days_between IS NOT NULL
          GROUP BY constituent_id
          HAVING COUNT(*) >= ${minOccurrences}
            AND STDDEV(days_between) < AVG(days_between) * 0.3  -- Low variance indicates regular pattern
        )
        SELECT 
          constituent_id,
          frequency_pattern
        FROM recurring_patterns
        WHERE frequency_pattern != 'irregular'
      `);
    });

    return result.rows.map((row) => ({
      constituentId: row.constituent_id as string,
      frequency: row.frequency_pattern as string,
    })) as Array<{ constituentId: string; frequency: string }>;
  }

  /**
   * Detect lapsed donors (no recent donation but donated before)
   */
  async detectLapsed(): Promise<Array<{ constituentId: string; lastDonationDate: Date }>> {
    const monthsSinceLastDonation = this.config.LAPSED?.monthsSinceLastDonation || 6;
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsSinceLastDonation);

    const result = await withTenantContext(this.orgId, async (db) => {
      return await db.execute(sql`
        WITH last_donations AS (
          SELECT 
            constituent_id,
            MAX(donated_at) as last_donation_date
          FROM donations
          WHERE org_id = ${this.orgId}
            AND status = 'cleared'
          GROUP BY constituent_id
          HAVING MAX(donated_at) < ${cutoffDate}
        )
        SELECT 
          constituent_id,
          last_donation_date
        FROM last_donations
        ORDER BY last_donation_date DESC
      `);
    });

    return result.rows.map((row) => ({
      constituentId: row.constituent_id as string,
      lastDonationDate: new Date(row.last_donation_date as string),
    })) as Array<{ constituentId: string; lastDonationDate: Date }>;
  }

  /**
   * Detect major donors based on total donation amount in a time window
   */
  async detectMajorDonors(): Promise<Array<{ constituentId: string; totalAmountCents: number }>> {
    const windowMonths = this.config.MAJOR_DONOR?.windowMonths || 12;
    const thresholdCents = this.config.MAJOR_DONOR?.thresholdCents || 100000; // 1000 EUR default
    const windowStart = new Date();
    windowStart.setMonth(windowStart.getMonth() - windowMonths);

    const result = await withTenantContext(this.orgId, async (db) => {
      return await db.execute(sql`
        SELECT 
          constituent_id,
          SUM(amount_base_cents) as total_amount_cents
        FROM donations
        WHERE org_id = ${this.orgId}
          AND status = 'cleared'
          AND donated_at >= ${windowStart}
        GROUP BY constituent_id
        HAVING SUM(amount_base_cents) >= ${thresholdCents}
        ORDER BY total_amount_cents DESC
      `);
    });

    return result.rows.map((row) => ({
      constituentId: row.constituent_id as string,
      totalAmountCents: parseInt(row.total_amount_cents as string, 10),
    })) as Array<{ constituentId: string; totalAmountCents: number }>;
  }

  /**
   * Detect all patterns for a given set of constituents
   */
  async detectAllPatterns(constituentIds?: string[]): Promise<Map<string, PatternType[]>> {
    const patternMap = new Map<string, PatternType[]>();

    // Initialize map for all constituents
    if (constituentIds) {
      for (const id of constituentIds) {
        patternMap.set(id, []);
      }
    }

    // Detect each pattern
    const [lybunt, sybunt, recurring, lapsed, majorDonors] = await Promise.all([
      this.detectLYBUNT(),
      this.detectSYBUNT(),
      this.detectRecurring(),
      this.detectLapsed(),
      this.detectMajorDonors(),
    ]);

    // Add LYBUNT
    lybunt.forEach((id) => {
      if (!constituentIds || constituentIds.includes(id)) {
        const patterns = patternMap.get(id) || [];
        patterns.push("LYBUNT");
        patternMap.set(id, patterns);
      }
    });

    // Add SYBUNT
    sybunt.forEach((id) => {
      if (!constituentIds || constituentIds.includes(id)) {
        const patterns = patternMap.get(id) || [];
        patterns.push("SYBUNT");
        patternMap.set(id, patterns);
      }
    });

    // Add RECURRING
    recurring.forEach(({ constituentId }) => {
      if (!constituentIds || constituentIds.includes(constituentId)) {
        const patterns = patternMap.get(constituentId) || [];
        patterns.push("RECURRING");
        patternMap.set(constituentId, patterns);
      }
    });

    // Add LAPSED
    lapsed.forEach(({ constituentId }) => {
      if (!constituentIds || constituentIds.includes(constituentId)) {
        const patterns = patternMap.get(constituentId) || [];
        patterns.push("LAPSED");
        patternMap.set(constituentId, patterns);
      }
    });

    // Add MAJOR_DONOR
    majorDonors.forEach(({ constituentId }) => {
      if (!constituentIds || constituentIds.includes(constituentId)) {
        const patterns = patternMap.get(constituentId) || [];
        patterns.push("MAJOR_DONOR");
        patternMap.set(constituentId, patterns);
      }
    });

    return patternMap;
  }

  /**
   * Get donation statistics for pattern analysis
   */
  async getDonationStatistics(constituentId: string): Promise<{
    totalDonations: number;
    totalAmountCents: number;
    averageAmountCents: number;
    firstDonationDate: Date | null;
    lastDonationDate: Date | null;
    donationFrequency: string | null;
  }> {
    const result = await withTenantContext(this.orgId, async (db) => {
      return await db.execute(sql`
        WITH donation_stats AS (
          SELECT 
            COUNT(*) as total_donations,
            SUM(amount_base_cents) as total_amount,
            AVG(amount_base_cents) as avg_amount,
            MIN(donated_at) as first_donation,
            MAX(donated_at) as last_donation
          FROM donations
          WHERE org_id = ${this.orgId}
            AND constituent_id = ${constituentId}
            AND status = 'cleared'
        ),
        donation_intervals AS (
          SELECT 
            EXTRACT(EPOCH FROM (donated_at - LAG(donated_at) OVER (ORDER BY donated_at))) / 86400 as days_between
          FROM donations
          WHERE org_id = ${this.orgId}
            AND constituent_id = ${constituentId}
            AND status = 'cleared'
          ORDER BY donated_at
        ),
        frequency_analysis AS (
          SELECT 
            AVG(days_between) as avg_interval,
            CASE
              WHEN AVG(days_between) BETWEEN 25 AND 35 THEN 'monthly'
              WHEN AVG(days_between) BETWEEN 80 AND 100 THEN 'quarterly'
              WHEN AVG(days_between) BETWEEN 350 AND 380 THEN 'annual'
              WHEN AVG(days_between) BETWEEN 55 AND 65 THEN 'bi-monthly'
              ELSE 'irregular'
            END as frequency
          FROM donation_intervals
          WHERE days_between IS NOT NULL
        )
        SELECT 
          s.*,
          f.frequency
        FROM donation_stats s
        LEFT JOIN frequency_analysis f ON true
      `);
    });

    const row = result.rows[0];
    return {
      totalDonations: parseInt((row?.total_donations as string) || "0", 10),
      totalAmountCents: parseInt((row?.total_amount as string) || "0", 10),
      averageAmountCents: parseInt((row?.avg_amount as string) || "0", 10),
      firstDonationDate: row?.first_donation ? new Date(row.first_donation as string) : null,
      lastDonationDate: row?.last_donation ? new Date(row.last_donation as string) : null,
      donationFrequency: (row?.frequency as string) || null,
    };
  }
}
