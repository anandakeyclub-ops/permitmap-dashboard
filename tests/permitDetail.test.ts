import { describe, it, expect } from 'vitest';
import { PERMIT_DETAIL_FIELDS, formatPermitField } from '../lib/permitDetail';

const full = {
  PERMITNO: 'BLD-2026-00915', county: 'marion', STATUS: 'Issued',
  LAST_ISSUED_DATE: '2026-07-27', FULL_ADDRESS: '1420 SE 17th St, Ocala',
  OWNER_NAME: 'Jane Doe', CONTRACTOR_NAME: 'Generator Supercenter',
  PERMIT_DESCRIPTION: 'Install standby generator', WORK_DESCRIPTION: 'Backup power',
  trade: 'general_contractor', FINAL_VALUATION: '$18,500',
};
const byLabel = (l: string) => PERMIT_DETAIL_FIELDS.find(f => f.label === l)!;

describe('PERMIT_DETAIL_FIELDS spec', () => {
  it('has exactly the 11 requested fields, in order', () => {
    expect(PERMIT_DETAIL_FIELDS.map(f => f.label)).toEqual([
      'Permit Number', 'County', 'Status', 'Issue Date', 'Address', 'Owner',
      'Contractor', 'Description', 'Work Description', 'Trade', 'Valuation',
    ]);
  });
});

describe('formatPermitField', () => {
  it('renders each field from the loaded permit', () => {
    expect(formatPermitField(full, byLabel('Permit Number'))).toBe('BLD-2026-00915');
    expect(formatPermitField(full, byLabel('County'))).toBe('marion');
    expect(formatPermitField(full, byLabel('Status'))).toBe('Issued');
    expect(formatPermitField(full, byLabel('Issue Date'))).toBe('2026-07-27');
    expect(formatPermitField(full, byLabel('Address'))).toBe('1420 SE 17th St, Ocala');
    expect(formatPermitField(full, byLabel('Owner'))).toBe('Jane Doe');
    expect(formatPermitField(full, byLabel('Contractor'))).toBe('Generator Supercenter');
    expect(formatPermitField(full, byLabel('Description'))).toBe('Install standby generator');
    expect(formatPermitField(full, byLabel('Work Description'))).toBe('Backup power');
  });

  it('formats valuation as $ + thousands (strips $ and commas)', () => {
    expect(formatPermitField(full, byLabel('Valuation'))).toBe('$18,500');
    expect(formatPermitField({ FINAL_VALUATION: '99500.5' }, byLabel('Valuation'))).toBe('$99,500.5');
  });

  it('formats trade for readability (underscores → spaces)', () => {
    expect(formatPermitField(full, byLabel('Trade'))).toBe('general contractor');
  });

  it('missing / empty values render as em dash', () => {
    expect(formatPermitField({}, byLabel('Owner'))).toBe('—');
    expect(formatPermitField({ OWNER_NAME: '' }, byLabel('Owner'))).toBe('—');
    expect(formatPermitField({}, byLabel('Work Description'))).toBe('—');
    expect(formatPermitField({ FINAL_VALUATION: '0' }, byLabel('Valuation'))).toBe('—');   // not > 0
    expect(formatPermitField({ FINAL_VALUATION: 'N/A' }, byLabel('Valuation'))).toBe('—');
  });

  it('accepts lowercase field-name fallbacks', () => {
    const lower = { full_address: '5 Oak Ave', owner_name: 'Bob', final_valuation: '1200', last_issued_date: '2026-07-01' };
    expect(formatPermitField(lower, byLabel('Address'))).toBe('5 Oak Ave');
    expect(formatPermitField(lower, byLabel('Owner'))).toBe('Bob');
    expect(formatPermitField(lower, byLabel('Valuation'))).toBe('$1,200');
    expect(formatPermitField(lower, byLabel('Issue Date'))).toBe('2026-07-01');
  });

  it('is read-only — does not mutate the permit', () => {
    const p = { ...full };
    const snap = JSON.parse(JSON.stringify(p));
    PERMIT_DETAIL_FIELDS.forEach(f => formatPermitField(p, f));
    expect(p).toEqual(snap);
  });
});
