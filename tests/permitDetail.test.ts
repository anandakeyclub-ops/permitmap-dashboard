import { describe, it, expect } from 'vitest';
import { PERMIT_DETAIL_FIELDS, permitDetailFields, formatPermitField, NOT_PROVIDED, isNotProvided } from '../lib/permitDetail';

// Alachua-shaped (rich): owner/contractor/valuation present; no RECORD_TYPE/STATUS at source.
const alachua = {
  PERMITNO: 'B26-000834', county: 'alachua',
  LAST_ISSUED_DATE: '2026-07-30', FULL_ADDRESS: '231 SW 123RD ST, NEWBERRY, FL 32669',
  OWNER_NAME: 'Browix LLC', CONTRACTOR_NAME: 'Damani Brown',
  PERMIT_DESCRIPTION: 'Addition of master bath', trade: 'general_contractor', FINAL_VALUATION: '100000',
};
// Marion-shaped (EnerGov): permit type + status present; no owner/contractor/valuation at source.
const marion = {
  PERMITNO: 'BLDR-26-06-17821', county: 'marion', STATUS: 'Issued', RECORD_TYPE: 'Residential Solar',
  PERMIT_DESCRIPTION: 'Solar-Photovoltaic Rooftop', FULL_ADDRESS: '17056 SE 115TH TERRACE RD',
  LAST_ISSUED_DATE: '2026-07-31', trade: 'roofing',
  OWNER_NAME: '', CONTRACTOR_NAME: '', FINAL_VALUATION: '',
};
const byLabel = (l: string) => PERMIT_DETAIL_FIELDS.find(f => f.label === l)!;
// The drawer passes NOT_PROVIDED as the empty text; other callers keep the default '—'.
const drawer = (p: Record<string, any>, l: string) => formatPermitField(p, byLabel(l), NOT_PROVIDED);

describe('PERMIT_DETAIL_FIELDS spec', () => {
  it('exposes the real permit attributes, in order — no phantom Work Description', () => {
    expect(PERMIT_DETAIL_FIELDS.map(f => f.label)).toEqual([
      'Permit Number', 'Permit Type', 'Description', 'Status', 'Issue Date', 'Address',
      'Owner', 'Contractor', 'Trade', 'Valuation', 'County',
    ]);
    expect(PERMIT_DETAIL_FIELDS.map(f => f.label)).not.toContain('Work Description');
  });
});

describe('formatPermitField — Alachua (rich source)', () => {
  it('renders every provided field', () => {
    expect(formatPermitField(alachua, byLabel('Permit Number'))).toBe('B26-000834');
    expect(formatPermitField(alachua, byLabel('Owner'))).toBe('Browix LLC');
    expect(formatPermitField(alachua, byLabel('Contractor'))).toBe('Damani Brown');
    expect(formatPermitField(alachua, byLabel('Valuation'))).toBe('$100,000');
    expect(formatPermitField(alachua, byLabel('Description'))).toBe('Addition of master bath');
    expect(formatPermitField(alachua, byLabel('Trade'))).toBe('general contractor');
    expect(formatPermitField(alachua, byLabel('Issue Date'))).toBe('2026-07-30');
  });
  it('honestly marks source-absent fields (no RECORD_TYPE/STATUS)', () => {
    expect(drawer(alachua, 'Permit Type')).toBe(NOT_PROVIDED);
    expect(drawer(alachua, 'Status')).toBe(NOT_PROVIDED);
  });
});

describe('formatPermitField — Marion (EnerGov, no owner/contractor/valuation) — never fabricated', () => {
  it('renders provided fields', () => {
    expect(formatPermitField(marion, byLabel('Permit Type'))).toBe('Residential Solar');
    expect(formatPermitField(marion, byLabel('Status'))).toBe('Issued');
    expect(formatPermitField(marion, byLabel('Description'))).toBe('Solar-Photovoltaic Rooftop');
  });
  it('shows the honest placeholder for blank owner/contractor/valuation', () => {
    expect(drawer(marion, 'Owner')).toBe(NOT_PROVIDED);
    expect(drawer(marion, 'Contractor')).toBe(NOT_PROVIDED);
    expect(drawer(marion, 'Valuation')).toBe(NOT_PROVIDED);
    expect(isNotProvided(drawer(marion, 'Owner'))).toBe(true);
  });
});

describe('permitDetailFields — date basis awareness (PRC)', () => {
  // Citrus-shaped: opened-date basis, no issue date. The drawer's date row must show the API's
  // label ("Record opened") and read OPENED_DATE — never a blank issue date, never opened-as-issued.
  const citrus = {
    PERMITNO: 'REM-2026-00042', county: 'citrus', trade: 'generator',
    OPENED_DATE: '2026-07-01', FULL_ADDRESS: '9 Gulf Blvd, Crystal River',
  };
  const fieldFor = (fields: ReturnType<typeof permitDetailFields>, keyPresent: string) =>
    fields.find(f => f.keys.includes(keyPresent));

  it('opened basis: the date row is labeled from coverage.date_label and reads OPENED_DATE', () => {
    const fields = permitDetailFields({ dateBasis: 'opened', dateLabel: 'Record opened' });
    const dateField = fields.find(f => f.keys.includes('OPENED_DATE'))!;
    expect(dateField.label).toBe('Record opened');
    expect(formatPermitField(citrus, dateField, NOT_PROVIDED)).toBe('2026-07-01');
    // No stale "Issue Date" row remains, and no issue-date key leaks into the date field.
    expect(fields.map(f => f.label)).not.toContain('Issue Date');
    expect(dateField.keys).not.toContain('LAST_ISSUED_DATE');
  });

  it('opened basis with no explicit label falls back to "Record opened"', () => {
    const fields = permitDetailFields({ dateBasis: 'opened' });
    expect(fields.find(f => f.keys.includes('OPENED_DATE'))!.label).toBe('Record opened');
  });

  it('omitted opts → issued basis: date row reads LAST_ISSUED_DATE, labeled from the basis default', () => {
    const fields = permitDetailFields();
    // Same field set/order as the static spec (only the date row's label is metadata-derived).
    expect(fields.map(f => f.keys)).toEqual(PERMIT_DETAIL_FIELDS.map(f => f.keys));
    const dateField = fields.find(f => f.keys.includes('LAST_ISSUED_DATE'))!;
    expect(dateField.keys).toContain('LAST_ISSUED_DATE');
    // No explicit label → the issued-basis default ("Permit issued"), never a hardcoded "Issue Date".
    expect(dateField.label).toBe('Permit issued');
    void fieldFor; // (helper kept for readability; unused branch)
  });

  it('opened basis does NOT fabricate a date for a row that only has an issue date', () => {
    const issuedOnly = { LAST_ISSUED_DATE: '2026-07-27' };
    const fields = permitDetailFields({ dateBasis: 'opened', dateLabel: 'Record opened' });
    const dateField = fields.find(f => f.keys.includes('OPENED_DATE'))!;
    expect(formatPermitField(issuedOnly, dateField, NOT_PROVIDED)).toBe(NOT_PROVIDED);
  });
});

describe('formatPermitField — formatting, empty-text param, fallbacks', () => {
  it('valuation $ + thousands, only when > 0', () => {
    expect(formatPermitField({ FINAL_VALUATION: '$18,500' }, byLabel('Valuation'))).toBe('$18,500');
    expect(drawer({ FINAL_VALUATION: '0' }, 'Valuation')).toBe(NOT_PROVIDED);
    expect(drawer({ FINAL_VALUATION: 'N/A' }, 'Valuation')).toBe(NOT_PROVIDED);
  });
  it('default empty text is the em dash (Contractor Profile / table unchanged)', () => {
    expect(formatPermitField({}, byLabel('Owner'))).toBe('—');
    expect(formatPermitField({ OWNER_NAME: '' }, byLabel('Owner'))).toBe('—');
  });
  it('drawer opts into the honest sentence', () => {
    expect(drawer({}, 'Owner')).toBe(NOT_PROVIDED);
  });
  it('lowercase fallbacks', () => {
    const lower = { full_address: '5 Oak Ave', owner_name: 'Bob', final_valuation: '1200', last_issued_date: '2026-07-01' };
    expect(formatPermitField(lower, byLabel('Address'))).toBe('5 Oak Ave');
    expect(formatPermitField(lower, byLabel('Owner'))).toBe('Bob');
    expect(formatPermitField(lower, byLabel('Valuation'))).toBe('$1,200');
  });
  it('is read-only — does not mutate the permit', () => {
    const p = { ...marion };
    const snap = JSON.parse(JSON.stringify(p));
    PERMIT_DETAIL_FIELDS.forEach(f => formatPermitField(p, f));
    expect(p).toEqual(snap);
  });
});
