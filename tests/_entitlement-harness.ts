// In-memory Stripe + Clerk fakes for the entitlement-truth suite. NEVER touches the network.
import { PRICE_TO_TIER, entitlementForStatus, tierForSubscription } from '../lib/provisioning';
import { PAUSE_PARAMS } from '../lib/lifecycle';

export const PRICE = {
  starter: 'price_1TMtSHIgaDPbFgUVPElPgL8V',
  pro: 'price_1TMtStIgaDPbFgUVPFOUjBMW',
  team: 'price_1TMtThIgaDPbFgUVoxIWlvf3',
};
const RANK: Record<string, number> = { starter: 1, pro: 2, team: 3 };
const USER = 'user_1';
const EMAIL = 'a@x.com';

type SubOpts = { status?: string; price?: string; items?: string[]; customer?: string; pause_collection?: any; cancel_at_period_end?: boolean; metadata?: Record<string, any> };

export function subObj(id: string, o: SubOpts = {}) {
  const prices = o.items || [o.price || PRICE.pro];
  return {
    id, object: 'subscription', status: o.status || 'active', customer: o.customer || 'cus_1',
    items: { data: prices.map(p => ({ price: { id: p } })) },
    metadata: { clerk_user_id: USER, ...(o.metadata || {}) },
    pause_collection: o.pause_collection || null, cancel_at_period_end: !!o.cancel_at_period_end,
  };
}

let evCounter = 0;
export function ev(type: string, object: any, created: number) {
  return { id: `evt_${++evCounter}`, type, created, data: { object: JSON.parse(JSON.stringify(object)) } };
}

export function makeWorld() {
  const subs = new Map<string, any>();
  const createdAt = new Map<string, number>();
  const lagged = new Map<string, any>();
  const users = new Map<string, { id: string; email: string; publicMetadata: Record<string, any> }>();
  users.set(USER, { id: USER, email: EMAIL, publicMetadata: {} });
  const emits: { name: string; props: any }[] = [];
  const alerts: { kind: string; detail: any }[] = [];
  const stripeUpdates: { id: string; params: any }[] = [];
  const forbiddenStripeCalls: string[] = [];
  let clerkWriteCount = 0;
  const world: any = { failRetrieve: false, emits, alerts, stripeUpdates, forbiddenStripeCalls };

  world.setSub = (id: string, patch: SubOpts) => {
    const cur = subs.get(id);
    if (!cur) createdAt.set(id, createdAt.size + 1);
    const base = cur ? { ...cur } : subObj(id, patch);
    if (patch.status) base.status = patch.status;
    if (patch.price || patch.items) base.items = { data: (patch.items || [patch.price!]).map(p => ({ price: { id: p } })) };
    if (patch.customer) base.customer = patch.customer;
    if ('pause_collection' in patch) base.pause_collection = patch.pause_collection;
    if ('cancel_at_period_end' in patch) base.cancel_at_period_end = patch.cancel_at_period_end;
    base.created = createdAt.get(id);
    subs.set(id, base);
  };
  world.sub = (id: string) => JSON.parse(JSON.stringify(subs.get(id)));
  world.lagRetrieve = (id: string, patch: any) => lagged.set(id, patch);
  world.subs = subs;
  world.users = users;
  world.clerkWrites = () => clerkWriteCount;
  world.emit = async (name: string, props: any) => { emits.push({ name, props }); };
  world.alert = (kind: string, detail: any) => { alerts.push({ kind, detail }); };

  const guard = (label: string, target: any) => new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (..._a: any[]) => { forbiddenStripeCalls.push(`${label}.${String(prop)}`); return Promise.resolve({}); };
    },
  });

  world.stripe = {
    webhooks: { constructEvent: () => { throw new Error('not used'); } },
    subscriptions: guard('subscriptions', {
      retrieve: async (id: string) => {
        if (world.failRetrieve) throw new Error('stripe unavailable');
        const s = subs.get(id);
        if (!s) throw new Error('No such subscription');
        return { ...JSON.parse(JSON.stringify(s)), ...(lagged.get(id) || {}) };
      },
      update: async (id: string, params: any) => {
        stripeUpdates.push({ id, params });
        const onlyMetadata = Object.keys(params).length === 1 && params.metadata;
        const isPause = JSON.stringify(params) === JSON.stringify(PAUSE_PARAMS);
        if (!onlyMetadata && !isPause) forbiddenStripeCalls.push(`subscriptions.update(${JSON.stringify(params)})`);
        const s = subs.get(id);
        if (s && params.metadata) s.metadata = { ...s.metadata, ...params.metadata };
        return s || {};
      },
      list: async (p: any) => ({ data: [...subs.values()].filter(s => !p.customer || s.customer === p.customer).map(s => JSON.parse(JSON.stringify(s))) }),
      search: async (p: any) => {
        const m = /metadata\['clerk_user_id'\]:'([^']+)'/.exec(p.query || '');
        return { data: [...subs.values()].filter(s => m && s.metadata?.clerk_user_id === m[1]).map(s => JSON.parse(JSON.stringify(s))) };
      },
    }),
    customers: guard('customers', {
      retrieve: async () => ({ id: 'cus', email: EMAIL }),
      update: async (_id: string, params: any) => {
        if (!(Object.keys(params).length === 1 && params.metadata)) forbiddenStripeCalls.push(`customers.update(${JSON.stringify(params)})`);
        return {};
      },
    }),
  };

  world.clerk = {
    users: {
      getUserList: async ({ emailAddress }: { emailAddress: string[] }) => {
        const m = [...users.values()].filter(u => emailAddress.includes(u.email));
        return { totalCount: m.length, data: m.map(u => ({ id: u.id })) };
      },
      getUser: async (id: string) => { const u = users.get(id); return u ? { publicMetadata: JSON.parse(JSON.stringify(u.publicMetadata)) } : null; },
      updateUserMetadata: async (id: string, p: { publicMetadata: Record<string, any> }) => {
        clerkWriteCount++;
        const u = users.get(id)!;
        u.publicMetadata = { ...u.publicMetadata, ...JSON.parse(JSON.stringify(p.publicMetadata)) }; // Clerk merges top-level keys
        return {};
      },
      createUser: async (p: { emailAddress: string[]; publicMetadata: Record<string, any> }) => {
        clerkWriteCount++;
        const id = `user_new_${users.size}`;
        users.set(id, { id, email: p.emailAddress[0], publicMetadata: { ...p.publicMetadata } });
        return { id };
      },
    },
  };
  return world as {
    failRetrieve: boolean; emits: typeof emits; alerts: typeof alerts; stripeUpdates: typeof stripeUpdates;
    forbiddenStripeCalls: string[]; stripe: any; clerk: any; emit: any; alert: any;
    setSub: (id: string, p: SubOpts) => void; sub: (id: string) => any; lagRetrieve: (id: string, patch: any) => void;
    clerkWrites: () => number; subs: Map<string, any>; users: Map<string, any>;
  };
}
export type World = ReturnType<typeof makeWorld>;

export function clerkEntitlement(w: World, userId: string) {
  const pm = w.users.get(userId)?.publicMetadata || {};
  return { tier: pm.tier as string | undefined, billing: pm.billing_status as string | undefined, subId: pm.stripe_subscription_id as string | undefined, rawStatus: pm.stripe_subscription_status as string | undefined };
}
export const core = (c: { tier?: string; billing?: string }) => ({ tier: c.tier, billing: c.billing });

// What Stripe says the entitlement SHOULD be for this user, derived only from the fake Stripe state.
export function truthEntitlement(w: World, userId: string): { tier?: string; billing?: string } {
  const mine = [...w.subs.values()].filter(s => s.metadata?.clerk_user_id === userId);
  const entitled = mine.filter(s => entitlementForStatus(s.status, !!s.pause_collection).action === 'grant' && tierForSubscription(s));
  if (entitled.length) {
    entitled.sort((a, b) => RANK[tierForSubscription(b)!] - RANK[tierForSubscription(a)!]);
    const top = entitled[0];
    const best = entitled.filter(s => tierForSubscription(s) === tierForSubscription(top))
      .sort((a, b) => Number(entitlementForStatus(b.status, false).action === 'grant' && b.status !== 'past_due') - Number(a.status !== 'past_due'))[0];
    const d = entitlementForStatus(best.status, !!best.pause_collection) as { billingStatus: string };
    return { tier: tierForSubscription(best)!, billing: d.billingStatus };
  }
  const revoked = mine.filter(s => entitlementForStatus(s.status, false).action === 'revoke').sort((a, b) => b.created - a.created);
  if (!revoked.length) return { tier: undefined, billing: undefined };
  return { tier: 'cancelled', billing: (entitlementForStatus(revoked[0].status, false) as { billingStatus: string }).billingStatus };
}
export { PRICE_TO_TIER };
