import { describe, it, expect } from 'vitest';
import {
  lifecycleState, interlockDecision, shouldResume, ALLOWED_TRANSITIONS,
  PAUSE_PARAMS, RESUME_PARAMS,
} from '../lib/lifecycle';
import { evaluateOnboarding } from '../lib/onboarding';

// Shorthands
const preview = { tier: 'preview', subStatus: null };
const proTrialIncomplete = { tier: 'pro', subStatus: 'trialing', selected_counties: [], selected_trades: [], email: 'x@co.com' };
const proTrialComplete = { tier: 'pro', subStatus: 'trialing', selected_counties: ['marion'], selected_trades: ['roofing'], email: 'x@co.com' };
const teamTrialComplete = { tier: 'team', subStatus: 'trialing', email: 'q@co.com' };           // team: county/trade optional
const teamTrialNoEmail = { tier: 'team', subStatus: 'trialing', email: null };
const teamActive = { tier: 'team', subStatus: 'active', email: 'q@co.com' };

describe('lifecycle state machine (seams 1-3)', () => {
  it('1. Nicholas-shaped preview user is never paid/onboarded', () => {
    // preview tier, no sub — even if an analytics county exists elsewhere, we never pass it as a selection
    const st = lifecycleState({ tier: 'preview', subStatus: null, selected_counties: null, selected_trades: null });
    expect(st).toBe('PREVIEW');
    expect(['ACTIVE_PAID', 'TRIALING_PRODUCT_READY', 'TRIALING_ONBOARDING_INCOMPLETE']).not.toContain(st);
    expect(interlockDecision(preview).action).toBe('allow');   // nothing to charge
  });

  it('2. preview engagement does not fabricate a trial', () => {
    expect(lifecycleState({ tier: 'preview', subStatus: '' })).toBe('PREVIEW');
    expect(lifecycleState({ tier: null, subStatus: null })).toBe('PREVIEW');
  });

  it('3. preview -> checkout -> trial progression', () => {
    expect(lifecycleState({ tier: 'starter', subStatus: 'incomplete' })).toBe('CHECKOUT_STARTED');
    expect(lifecycleState(proTrialIncomplete)).toBe('TRIALING_ONBOARDING_INCOMPLETE');
  });

  it('4. Starter/Pro incomplete trial -> onboarding-incomplete (gated)', () => {
    expect(lifecycleState(proTrialIncomplete)).toBe('TRIALING_ONBOARDING_INCOMPLETE');
    expect(lifecycleState({ tier: 'starter', subStatus: 'trialing', selected_counties: [], selected_trades: [], email: 'x@co.com' }))
      .toBe('TRIALING_ONBOARDING_INCOMPLETE');
  });

  it('5. valid canonical county+trade -> product ready (uses evaluateOnboarding, no duplicate rule)', () => {
    expect(lifecycleState(proTrialComplete)).toBe('TRIALING_PRODUCT_READY');
    // consistency: PRODUCT_READY iff evaluateOnboarding.complete (single source of truth)
    expect(evaluateOnboarding({ tier: 'pro', selected_counties: ['marion'], selected_trades: ['roofing'], email: 'x@co.com' }).complete).toBe(true);
  });

  it('6. completion releases the gate / interlock (shouldResume)', () => {
    expect(shouldResume({ ...proTrialComplete, paused: true })).toBe(true);
    expect(shouldResume({ ...proTrialIncomplete, paused: true })).toBe(false);   // still incomplete
    expect(shouldResume({ ...proTrialComplete, paused: false })).toBe(false);    // not paused, nothing to resume
  });

  it('7. complete trial converts normally (interlock allow)', () => {
    expect(interlockDecision(proTrialComplete).action).toBe('allow');
  });

  it('8. incomplete trial cannot incur first paid charge (interlock pause)', () => {
    const d = interlockDecision(proTrialIncomplete);
    expect(d.action).toBe('pause');
    expect(d.state).toBe('TRIALING_ONBOARDING_INCOMPLETE');
    expect(PAUSE_PARAMS.pause_collection.behavior).toBe('void');   // withhold the charge, reversibly
  });

  it('9. Team behavior intact (county/trade optional, email required)', () => {
    expect(lifecycleState(teamTrialComplete)).toBe('TRIALING_PRODUCT_READY');
    expect(interlockDecision(teamTrialComplete).action).toBe('allow');
    expect(lifecycleState(teamTrialNoEmail)).toBe('TRIALING_ONBOARDING_INCOMPLETE');   // still needs email
  });

  it('10. Quontrell-shaped Team active customer unaffected', () => {
    expect(lifecycleState(teamActive)).toBe('ACTIVE_PAID');
    expect(interlockDecision(teamActive).action).toBe('allow');   // no first-charge interlock on active
  });

  it('11. canceled/disputed do not re-enter active delivery', () => {
    expect(lifecycleState({ tier: 'pro', subStatus: 'canceled' })).toBe('CANCELED');
    expect(lifecycleState({ tier: 'pro', subStatus: 'active', hasDispute: true })).toBe('DISPUTED');
    // transitions: CANCELED can only go back through CHECKOUT_STARTED (re-subscribe), never straight to ACTIVE_PAID
    expect(ALLOWED_TRANSITIONS.CANCELED).toEqual(['CHECKOUT_STARTED']);
    expect(ALLOWED_TRANSITIONS.DISPUTED).not.toContain('ACTIVE_PAID');
  });

  it('12. re-subscribe path prevents silent duplicate-active (transition guard)', () => {
    // a canceled customer must pass through CHECKOUT_STARTED again — not jump to ACTIVE_PAID
    expect(ALLOWED_TRANSITIONS.CANCELED).not.toContain('ACTIVE_PAID');
    expect(ALLOWED_TRANSITIONS.PREVIEW).toContain('CHECKOUT_STARTED');
  });

  it('13. no duplicate lifecycle rules — onboarding delegated to evaluateOnboarding', () => {
    // lifecycle PRODUCT_READY must track evaluateOnboarding exactly for the same inputs
    for (const c of [proTrialComplete, proTrialIncomplete, teamTrialComplete, teamTrialNoEmail]) {
      const complete = evaluateOnboarding({ tier: c.tier, selected_counties: (c as any).selected_counties, selected_trades: (c as any).selected_trades, email: c.email }).complete;
      expect(lifecycleState(c) === 'TRIALING_PRODUCT_READY').toBe(complete);
    }
  });

  it('14. resume params clear the pause', () => {
    expect(RESUME_PARAMS.pause_collection).toBe('');
    expect(shouldResume({ ...teamTrialComplete, paused: true })).toBe(true);
  });

  it('internal test marker takes precedence', () => {
    expect(lifecycleState({ tier: 'pro', subStatus: 'active', internalTest: true })).toBe('INTERNAL_TEST');
  });
});
