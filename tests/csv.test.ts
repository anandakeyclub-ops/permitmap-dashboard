import { describe, it, expect } from 'vitest';
import { buildPermitCsv, createExportFilename, escapeCsvField, formatDate, CSV_HEADERS } from '../lib/csv';

const HEADER = 'Permit Number,County,Address,Owner,Contractor,Description,Work Description,Trade,Status,Issue Date,Valuation';

function rows() {
  return [
    {
      PERMITNO: 'BLD-2026-00915', county: 'marion', FULL_ADDRESS: '1420 SE 17th St, Ocala',
      OWNER_NAME: 'Jane Doe', CONTRACTOR_NAME: 'Generator Supercenter',
      PERMIT_DESCRIPTION: 'Install standby generator', WORK_DESCRIPTION: 'Backup power',
      trade: 'electrical', STATUS: 'Issued', LAST_ISSUED_DATE: '2026-07-27', FINAL_VALUATION: '18500',
      // hidden/internal fields that must NOT be exported:
      score: 87, id: 'internal-123', preview_locked: false,
    },
  ];
}

describe('buildPermitCsv', () => {
  it('exports only the supplied rows with correct header + column order', () => {
    const csv = buildPermitCsv(rows());
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(HEADER);
    expect(CSV_HEADERS).toEqual(HEADER.split(','));
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[1]).toBe(
      'BLD-2026-00915,marion,"1420 SE 17th St, Ocala",Jane Doe,Generator Supercenter,' +
      'Install standby generator,Backup power,electrical,Issued,2026-07-27,18500',
    );
  });

  it('does not export hidden/internal fields', () => {
    const csv = buildPermitCsv(rows());
    expect(csv).not.toContain('internal-123');
    expect(csv).not.toContain('preview_locked');
    expect(csv).not.toMatch(/(^|,)87(,|$)/m); // score value not present as a field
  });

  it('quotes fields containing commas', () => {
    const csv = buildPermitCsv([{ FULL_ADDRESS: '1 Main St, Unit 4' }]);
    expect(csv.split('\r\n')[1]).toContain('"1 Main St, Unit 4"');
  });

  it('escapes embedded double quotes (" → "")', () => {
    const csv = buildPermitCsv([{ OWNER_NAME: 'The "Big" Co' }]);
    expect(csv.split('\r\n')[1]).toContain('"The ""Big"" Co"');
  });

  it('handles line breaks by quoting', () => {
    const csv = buildPermitCsv([{ PERMIT_DESCRIPTION: 'line1\nline2' }]);
    const dataLine = csv.slice(csv.indexOf('\r\n') + 2);
    expect(dataLine).toContain('"line1\nline2"');
  });

  it('null/undefined/missing → blank; empty string → blank', () => {
    const csv = buildPermitCsv([{ PERMITNO: 'X', OWNER_NAME: null, CONTRACTOR_NAME: undefined }]);
    // Permit Number=X, County blank, Address blank, Owner blank, Contractor blank, ...
    expect(csv.split('\r\n')[1]).toBe('X,,,,,,,,,,');
  });

  it('preserves numeric zero', () => {
    const csv = buildPermitCsv([{ PERMITNO: 'Z', FINAL_VALUATION: 0 }]);
    const cells = csv.split('\r\n')[1].split(',');
    expect(cells[0]).toBe('Z');
    expect(cells[10]).toBe('0'); // Valuation column, zero preserved (not blank)
  });

  it('neutralizes spreadsheet formula injection (= + - @)', () => {
    const csv = buildPermitCsv([{ OWNER_NAME: '=cmd()', CONTRACTOR_NAME: '+1', PERMIT_DESCRIPTION: '-5', WORK_DESCRIPTION: '@x' }]);
    const line = csv.split('\r\n')[1];
    expect(line).toContain("'=cmd()");
    expect(line).toContain("'+1");
    expect(line).toContain("'-5");
    expect(line).toContain("'@x");
  });

  it('does not mutate the input array', () => {
    const input = rows();
    const copy = JSON.parse(JSON.stringify(input));
    buildPermitCsv(input);
    expect(input).toEqual(copy);
  });
});

describe('buildPermitCsv — date basis awareness (PRC)', () => {
  // Citrus-shaped: opened-date basis. The header + value must follow the API-declared basis —
  // "Record opened" from OPENED_DATE — never a hardcoded "Issue Date" or a blank issue column.
  // Address is comma-free so a naive split(',') indexes columns correctly in these assertions.
  const citrusRow = () => [{
    PERMITNO: 'REM-2026-00042', county: 'citrus', FULL_ADDRESS: '9 Gulf Blvd Crystal River',
    trade: 'generator', STATUS: 'Open', OPENED_DATE: '2026-07-01', FINAL_VALUATION: '22000',
  }];

  it('uses coverage.date_label for the date header and OPENED_DATE for the value on an opened county', () => {
    const csv = buildPermitCsv(citrusRow(), { dateBasis: 'opened', dateLabel: 'Record opened' });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'Permit Number,County,Address,Owner,Contractor,Description,Work Description,Trade,Status,Record opened,Valuation',
    );
    // The date cell (10th column, index 9) is the OPENED_DATE, formatted — not blank, not an issue date.
    expect(lines[1].split(',')[9]).toBe('2026-07-01');
  });

  it('does not fabricate an issue date for an opened-only row exported under the default (issued) basis', () => {
    // No opts → issued basis. The row has no issue date, so the date cell is blank (never cross-copied).
    const csv = buildPermitCsv(citrusRow());
    const lines = csv.split('\r\n');
    expect(lines[0]).toContain(',Issue Date,'); // back-compat default header
    expect(lines[1].split(',')[9]).toBe('');     // blank, not the opened date
  });
});

describe('formatDate (consistent formatting)', () => {
  it('normalizes ISO and US formats to YYYY-MM-DD; passes through otherwise', () => {
    expect(formatDate('2026-07-27')).toBe('2026-07-27');
    expect(formatDate('2026-07-27T10:00:00Z')).toBe('2026-07-27');
    expect(formatDate('7/9/2026')).toBe('2026-07-09');
    expect(formatDate('')).toBe('');
    expect(formatDate(null)).toBe('');
  });
});

describe('createExportFilename', () => {
  it('includes active-filter context (county + trade/keyword) + date', () => {
    expect(createExportFilename({ county: 'marion', keyword: 'generator' }, '2026-07-30'))
      .toBe('permitmap_marion_generator_2026-07-30.csv');
    expect(createExportFilename({ county: 'Marion', trade: 'electrical' }, '2026-07-30'))
      .toBe('permitmap_marion_electrical_2026-07-30.csv'); // trade wins as context token
  });
  it('removes unsafe filename characters', () => {
    expect(createExportFilename({ county: 'Palm Beach/FL', keyword: 'A/C "unit"' }, '2026-07-30'))
      .toBe('permitmap_palm_beach_fl_a_c_unit_2026-07-30.csv');
  });
});

describe('escapeCsvField', () => {
  it('preserves 0 and blanks null/undefined', () => {
    expect(escapeCsvField(0)).toBe('0');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
    expect(escapeCsvField('')).toBe('');
  });
});
