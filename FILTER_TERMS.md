# NPO Domain Filter Terms

This document provides a comprehensive list of Non-Profit Organization (NPO) filter terms commonly used in donor management systems, particularly those found in Salesforce NPSP and similar platforms.

## Core Donor Segmentation Terms

### Donation Recency Categories

#### LYBUNT (Last Year But Unfortunately Not This)
- **Definition**: Donors who gave last year but have not given in the current year
- **Use Case**: Identify lapsed donors for re-engagement campaigns
- **Calculation**: Had donation(s) in previous fiscal year AND no donations in current fiscal year

#### SYBUNT (Some Year But Unfortunately Not This)  
- **Definition**: Donors who gave at some point in the past but not in the current year
- **Use Case**: Re-acquisition campaigns for historically engaged donors
- **Calculation**: Has any historical donation AND no donations in current fiscal year

#### NYBUNT (Never Yet But Unfortunately Not This)
- **Definition**: Constituents who have never made a donation
- **Use Case**: Acquisition campaigns for prospects
- **Calculation**: Constituent exists with no donation history

#### New Donors
- **Definition**: First-time donors within a specified period
- **Use Case**: Welcome series, new donor stewardship
- **Calculation**: First donation date within selected timeframe

#### Recently Lapsed Donors
- **Definition**: Donors whose last gift was 13-24 months ago
- **Use Case**: Win-back campaigns before they become deeply lapsed
- **Calculation**: Last donation date between 13-24 months ago

#### Deeply Lapsed Donors
- **Definition**: Donors whose last gift was 25+ months ago
- **Use Case**: Specialized re-engagement strategies
- **Calculation**: Last donation date > 24 months ago

### Donation Frequency Categories

#### Single Gift Donors
- **Definition**: Donors who have made exactly one donation
- **Use Case**: Convert to repeat donors
- **Calculation**: Count of donations = 1

#### Repeat Donors
- **Definition**: Donors who have made multiple donations
- **Use Case**: Retention and upgrade campaigns
- **Calculation**: Count of donations > 1

#### Recurring Donors
- **Definition**: Donors with active recurring gift commitments (monthly/yearly)
- **Use Case**: Sustainer stewardship and upgrade campaigns
- **Calculation**: Has active pledge with monthly/yearly frequency

#### Lapsed Recurring Donors
- **Definition**: Donors whose recurring gifts have stopped
- **Use Case**: Win-back failed recurring donations
- **Calculation**: Has cancelled/paused pledge status

### Giving Level Categories

#### Major Donors
- **Definition**: Donors above a certain cumulative or single gift threshold
- **Common Thresholds**: 
  - Single gift ≥ €1,000
  - Annual giving ≥ €5,000
  - Lifetime giving ≥ €10,000
- **Use Case**: High-touch stewardship, personal cultivation

#### Mid-Level Donors
- **Definition**: Donors in the middle giving range
- **Common Thresholds**:
  - Single gift €250-€999
  - Annual giving €1,000-€4,999
- **Use Case**: Upgrade to major donor status

#### Leadership Donors
- **Definition**: Top tier of annual fund donors
- **Common Thresholds**: Annual giving ≥ €1,000
- **Use Case**: Leadership circle benefits and recognition

#### Small Dollar Donors
- **Definition**: Donors below a certain threshold
- **Common Thresholds**: All gifts < €100
- **Use Case**: Volume-based engagement strategies

### Engagement Metrics

#### Donor Lifetime Value (LTV)
- **Definition**: Total cumulative giving from a donor
- **Use Case**: Identify high-value relationships
- **Calculation**: Sum of all cleared donations minus refunds

#### Average Gift Size
- **Definition**: Mean donation amount for a donor
- **Use Case**: Identify upgrade potential
- **Calculation**: Total giving / number of gifts

#### Days Since Last Gift
- **Definition**: Number of days since most recent donation
- **Use Case**: Timely follow-up and re-engagement
- **Calculation**: Today - last donation date

#### Giving Frequency Score
- **Definition**: How often a donor gives (e.g., gifts per year)
- **Use Case**: Identify highly engaged donors
- **Calculation**: Number of gifts / years as donor

### Campaign Attribution

#### First Touch Campaign
- **Definition**: Campaign that brought in the donor initially
- **Use Case**: Acquisition channel analysis
- **Calculation**: Campaign linked to first donation

#### Last Touch Campaign  
- **Definition**: Most recent campaign donor responded to
- **Use Case**: Recent engagement tracking
- **Calculation**: Campaign linked to most recent donation

#### Multi-Campaign Donors
- **Definition**: Donors who have given to multiple campaigns
- **Use Case**: Cross-campaign engagement analysis
- **Calculation**: Count of distinct campaigns > 1

### Geographic Segmentation

#### Local Donors
- **Definition**: Donors within a certain radius or region
- **Use Case**: Event invitations, local engagement
- **Calculation**: Based on postal code or city

#### International Donors
- **Definition**: Donors outside the organization's country
- **Use Case**: Special acknowledgment, tax considerations
- **Calculation**: Country code != organization country

### Communication Preferences

#### Email Contactable
- **Definition**: Has valid email address on file
- **Use Case**: Digital campaign targeting
- **Calculation**: Email field is not null/empty

#### Postal Mail Recipients
- **Definition**: Has complete mailing address
- **Use Case**: Direct mail campaigns
- **Calculation**: Has addressLine1, postalCode, city, countryCode

#### Do Not Contact
- **Definition**: Has requested no communications
- **Use Case**: Suppression lists
- **Calculation**: Based on constituent tags or preferences

### Special Categories

#### Memorial/Honorary Donors
- **Definition**: Gave in memory or honor of someone
- **Use Case**: Special acknowledgments
- **Calculation**: Based on donation tags or allocation to memorial funds

#### Event Attendees
- **Definition**: Has attended organization events
- **Use Case**: Event-based cultivation
- **Calculation**: Linked to event registration/attendance

#### Volunteers
- **Definition**: Has volunteer history with organization
- **Use Case**: Volunteer-to-donor conversion
- **Calculation**: Constituent type includes "volunteer"

#### Corporate Donors
- **Definition**: Gifts from companies/foundations
- **Use Case**: Corporate stewardship strategies  
- **Calculation**: Constituent type = "organization" or similar

### Fiscal Year Considerations

#### Year-End Donors
- **Definition**: Donors who typically give in Q4
- **Use Case**: Year-end campaign targeting
- **Calculation**: Majority of gifts in Oct-Dec

#### Fiscal Year Donors
- **Definition**: Donors who have given in current fiscal year
- **Use Case**: Annual fund tracking
- **Calculation**: Has donation where fiscal year = current

#### Multi-Year Donors
- **Definition**: Donors who have given in multiple fiscal years
- **Use Case**: Consistent supporter recognition
- **Calculation**: Count of distinct fiscal years with donations > 1

## Swiss-Specific Terms (Given QR-Bill Integration)

### QR-Bill Donors
- **Definition**: Donors who gave via Swiss QR-bill
- **Use Case**: Track postal campaign effectiveness
- **Calculation**: Donation has swissQrReferenceId or qrCodeId

### Bank Transfer Donors  
- **Definition**: Donors who gave via bank transfer (non-Stripe)
- **Use Case**: Different acknowledgment process
- **Calculation**: paymentSource = 'camt053'

## Implementation Priority

### Phase 1 - Core Filters
1. LYBUNT/SYBUNT
2. Giving level thresholds  
3. Donation recency (last gift date ranges)
4. Has email/Has complete address
5. Campaign-specific donors

### Phase 2 - Advanced Filters
1. Recurring donor status
2. Lifetime value ranges
3. Average gift calculations
4. Multi-criteria combinations (e.g., "Major donors who are LYBUNT")
5. Geographic filters

### Phase 3 - Specialized Filters
1. Giving patterns (seasonal, frequency)
2. Channel preferences
3. Custom tag-based segments
4. Predictive scores (if implemented)