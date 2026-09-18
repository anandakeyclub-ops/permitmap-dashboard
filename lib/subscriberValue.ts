export interface ValueProgress {
  first_permit_drawer_open_at?: string | null;
  first_csv_export_at?: string | null;
  first_saved_lead_at?: string | null;
  returned_next_day?: boolean;
}

export type ValueAction = 'opportunities' | 'saved' | 'permits';
export interface NextValueAction { title: string; detail: string; cta: string; action: ValueAction }

export function nextValueAction(a: ValueProgress | null, savedLeadCount: number): NextValueAction {
  if (!a?.first_permit_drawer_open_at) return { title:'Find your first job to pursue', detail:'Start with the highest-ranked opportunities in your market and open the strongest match.', cta:'Review top opportunities', action:'opportunities' };
  if (savedLeadCount < 1 && !a?.first_saved_lead_at) return { title:'Build your pursuit list', detail:'Save the best opportunity so PermitMap becomes your working lead list, not another permit spreadsheet.', cta:'Save a lead', action:'opportunities' };
  if (!a?.first_csv_export_at) return { title:'Turn opportunities into calls', detail:'Export a focused call list and start working the projects you chose to pursue.', cta:'Build call list', action:'permits' };
  if (!a?.returned_next_day) return { title:'Work the leads you already chose', detail:'Return to your saved leads, update what you called or quoted, and keep your pipeline moving.', cta:'Work saved leads', action:'saved' };
  return { title:'Keep your pipeline moving', detail:'Review fresh opportunities, save the best fits, then update called, quoted, won, or lost as you work them.', cta:'Review fresh opportunities', action:'opportunities' };
}
