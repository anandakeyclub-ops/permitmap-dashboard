import {it, expect} from 'vitest';
import {buildPermitCsv} from '../lib/csv';
it('keeps unknown dates blank even when an issued label and date-shaped field arrive', () => {
 const csv=buildPermitCsv([{PERMITNO:'test', LAST_ISSUED_DATE:'2026-11-01', OPENED_DATE:'2026-10-20'}], {dateBasis:'unknown',dateLabel:'Permit issued'});
 expect(csv).toContain('Date not verified'); expect(csv).not.toContain('2026-11-01'); expect(csv).not.toContain('2026-10-20');
});
it('labels opened export without relabeling it as Issue Date', () => {
 const csv=buildPermitCsv([{OPENED_DATE:'2026-10-20'}], {dateBasis:'opened'});
 expect(csv).toContain('Record opened'); expect(csv).not.toContain('Issue Date'); expect(csv).toContain('2026-10-20');
});

import {permitDetailFields, formatPermitField} from '../lib/permitDetail';
it('holds unknown drawer dates even if a date label claims issuance', () => {
 const f=permitDetailFields({dateBasis:'inspection',dateLabel:'Permit issued'}).find(f=>f.kind==='date')!;
 expect(f.label).toBe('Date not verified'); expect(formatPermitField({LAST_ISSUED_DATE:'2026-11-01'},f)).toBe('—');
});
