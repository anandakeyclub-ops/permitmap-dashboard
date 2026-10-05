import { describe, it, expect } from 'vitest';
import { readOnly } from '../scripts/readonly-guard';

function fake() {
  const calls: string[] = [];
  const rec = (n: string) => async () => { calls.push(n); return { data: [] }; };
  const client = {
    subscriptions: { list: rec('subs.list'), retrieve: rec('subs.retrieve'), search: rec('subs.search'), update: rec('subs.update'), cancel: rec('subs.cancel') },
    customers: { update: rec('cust.update') }, invoices: { pay: rec('inv.pay') },
    webhookEndpoints: { list: rec('wh.list'), del: rec('wh.del'), update: rec('wh.update') },
    users: { getUserList: rec('u.list'), getUser: rec('u.get'), updateUserMetadata: rec('u.updateMeta'), deleteUser: rec('u.delete'), createUser: rec('u.create') },
  };
  return { calls, client };
}
describe('production verifier read-only guard (real proxy)', () => {
  it('lets reads through', async () => {
    const { calls, client } = fake(); const c: any = readOnly('x', client);
    await c.subscriptions.list(); await c.subscriptions.retrieve('s'); await c.subscriptions.search({}); await c.webhookEndpoints.list(); await c.users.getUserList({}); await c.users.getUser('u');
    expect(calls).toEqual(['subs.list', 'subs.retrieve', 'subs.search', 'wh.list', 'u.list', 'u.get']);
  });
  it('blocks every write before any call is made', () => {
    const { calls, client } = fake(); const c: any = readOnly('x', client);
    const writes = [() => c.subscriptions.update('s', {}), () => c.subscriptions.cancel('s'), () => c.customers.update('c', {}), () => c.invoices.pay('i'),
      () => c.webhookEndpoints.del('w'), () => c.webhookEndpoints.update('w', {}), () => c.users.updateUserMetadata('u', {}), () => c.users.deleteUser('u'), () => c.users.createUser({})];
    for (const w of writes) expect(w).toThrow(/READ-ONLY GUARD/);
    expect(calls).toEqual([]);
  });
});
