import { describe, expect, it } from 'vitest';
import { nextValueAction } from '../lib/subscriberValue';

describe('nextValueAction', () => {
  it('starts with the ranked opportunity queue', () => expect(nextValueAction(null,0).action).toBe('opportunities'));
  it('moves from review to save', () => expect(nextValueAction({first_permit_drawer_open_at:'x'},0).cta).toBe('Save a lead'));
  it('moves a saved lead into a call list', () => expect(nextValueAction({first_permit_drawer_open_at:'x',first_saved_lead_at:'x'},1).action).toBe('permits'));
  it('moves an exported list into the saved pipeline', () => expect(nextValueAction({first_permit_drawer_open_at:'x',first_saved_lead_at:'x',first_csv_export_at:'x'},1).action).toBe('saved'));
  it('returns activated users to fresh opportunities', () => expect(nextValueAction({first_permit_drawer_open_at:'x',first_saved_lead_at:'x',first_csv_export_at:'x',returned_next_day:true},1).cta).toBe('Review fresh opportunities'));
});
