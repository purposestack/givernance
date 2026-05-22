# Advanced Filter UI Components

This directory contains the advanced filtering system for constituents in Givernance.

## Components

### FilterBuilder
The main interface for creating and editing constituent filters. Provides both visual builder and preset templates.

```tsx
import { FilterBuilder } from "@/components/constituents/filters";

function MyComponent() {
  const [filter, setFilter] = useState<Filter | null>(null);
  const [matchCount, setMatchCount] = useState(0);
  const [countLoading, setCountLoading] = useState(false);

  // Update match count when filter changes
  useEffect(() => {
    if (!filter) {
      setMatchCount(0);
      return;
    }

    setCountLoading(true);
    // Call your API to get the count
    getFilteredCount(filter).then(count => {
      setMatchCount(count);
      setCountLoading(false);
    });
  }, [filter]);

  return (
    <FilterBuilder
      filter={filter}
      onChange={setFilter}
      showCount={true}
      matchCount={matchCount}
      countLoading={countLoading}
    />
  );
}
```

### FilterChip
Visual representation of a single filter condition.

```tsx
import { FilterChip } from "@/components/constituents/filters";

<FilterChip
  condition={{
    id: "1",
    field: "email",
    operator: "contains",
    value: "@example.com"
  }}
  onRemove={(id) => handleRemove(id)}
/>
```

### FilterPresets
Pre-defined filter templates for common nonprofit queries.

```tsx
import { FilterPresets } from "@/components/constituents/filters";

<FilterPresets
  onSelect={(preset) => applyPreset(preset)}
  display="dropdown" // or "grid"
/>
```

## Filter Types

### Filter Structure
```typescript
interface Filter {
  id: string;
  name?: string;
  description?: string;
  conditions: FilterCondition[];
  logic: "AND" | "OR";
  groups?: Filter[]; // For nested filters
}

interface FilterCondition {
  id: string;
  field: string;
  operator: FilterOperator;
  value: any;
  label?: string;
}
```

### Available Operators
- **Text fields**: equals, not_equals, contains, not_contains, starts_with, ends_with, is_null, is_not_null
- **Number fields**: equals, not_equals, greater_than, less_than, greater_than_or_equal, less_than_or_equal, between
- **Date fields**: greater_than, less_than, between, is_null, is_not_null, in_last_days, not_in_last_days, older_than_days
- **Enum fields**: equals, not_equals, in, not_in
- **Array fields**: contains, not_contains

## Preset Templates

The system includes several pre-defined templates:

### Donation History
- **LYBUNT**: Last Year But Unfortunately Not This Year
- **SYBUNT**: Some Year But Unfortunately Not This Year  
- **Major Donors**: Total donations ≥ €500
- **Recurring Donors**: Active monthly donors
- **New Donors**: First-time donors in last 90 days
- **Lapsed Donors**: No donation in 12+ months

### Demographics
- **Local Supporters**: Geneva region (12xx postal codes)
- **Swiss Residents**: Country = CH

### Engagement
- **Missing Email**: Constituents without email
- **Complete Contact**: Has both email and phone
- **Volunteers**: Type = volunteer

## Integration with Campaign Members

The filter system is integrated into the campaign members selection dialog:

```tsx
import { CampaignMembersCard } from "@/components/campaigns/campaign-members-card-with-filters";

<CampaignMembersCard
  campaignId={campaignId}
  initialMembers={members}
  initialTotal={total}
  doorDrop={false}
  onTotalChanged={(count) => updateCount(count)}
/>
```

## Backend Integration

Currently, the filtering is implemented client-side for demonstration. For production use, you'll need to:

1. Update the `ConstituentService.listConstituents` method to accept filter parameters
2. Implement server-side filter parsing and SQL generation
3. Add proper indexes to support efficient filtering

Example API call structure:
```typescript
// Future API structure
const filtered = await ConstituentService.listConstituents(client, {
  filter: {
    conditions: [
      { field: "type", operator: "equals", value: "donor" },
      { field: "lastDonationAt", operator: "in_last_days", value: 365 }
    ],
    logic: "AND"
  },
  perPage: 50,
  page: 1
});
```

## Accessibility

All components include:
- ARIA labels for interactive elements
- Keyboard navigation support
- Screen reader announcements for dynamic content
- Proper focus management in dialogs

## Mobile Responsiveness

The filter UI adapts for mobile:
- Compact chip display
- Full-screen dialog on small screens
- Touch-friendly controls
- Responsive grid layouts