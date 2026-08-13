type Sleep = (ms: number) => Promise<void>;

function isRateLimitError(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.httpStatus;
  const code = String(err?.code ?? err?.errors?.[0]?.code ?? '').toLowerCase();
  const message = String(err?.message ?? err?.errors?.[0]?.message ?? '').toLowerCase();
  return status === 429 || code.includes('rate') || message.includes('too many requests') || message.includes('rate limit');
}

async function retryClerk<T>(fn: () => Promise<T>, sleep: Sleep, attempts = 3): Promise<T> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (!isRateLimitError(err) || i === attempts - 1) throw err;
      await sleep(i === 0 ? 300 : 1000);
    }
  }
  throw last;
}

export function wrapClerkWithRateLimitRetry(clerk: any, sleep: Sleep = (ms) => new Promise(r => setTimeout(r, ms))) {
  const users = clerk.users;
  return {
    ...clerk,
    users: {
      ...users,
      getUserList: (p: any) => retryClerk(() => users.getUserList(p), sleep),
      updateUserMetadata: (id: string, p: any) => retryClerk(() => users.updateUserMetadata(id, p), sleep),
      createUser: (p: any) => retryClerk(() => users.createUser(p), sleep),
      ...(users.getUser ? { getUser: (id: string) => retryClerk(() => users.getUser(id), sleep) } : {}),
    },
  };
}

function sameClerkMapping(current: any, params: any): boolean {
  const wanted = params?.metadata?.clerk_user_id;
  return !!wanted && current?.metadata?.clerk_user_id === wanted && Object.keys(params.metadata || {}).length === 1;
}

// Prevent webhook feedback loops: provisioning historically back-stamped the same clerk_user_id
// on every customer.subscription.updated event. Stripe emits subscription.updated for metadata
// writes, so a no-op write could trigger another webhook and amplify Clerk traffic until 429s.
// Only suppress the exact no-op mapping write; pause_collection and every other Stripe update pass through.
export function wrapStripeWithIdempotentMapping(stripe: any) {
  const rawSubRetrieve = stripe.subscriptions.retrieve.bind(stripe.subscriptions);
  const rawSubUpdate = stripe.subscriptions.update.bind(stripe.subscriptions);
  const rawCustomerRetrieve = stripe.customers.retrieve.bind(stripe.customers);
  const rawCustomerUpdate = stripe.customers.update.bind(stripe.customers);

  return {
    webhooks: stripe.webhooks,
    subscriptions: {
      retrieve: rawSubRetrieve,
      update: async (id: string, params: any) => {
        if (params?.metadata?.clerk_user_id && Object.keys(params).length === 1) {
          const current = await rawSubRetrieve(id);
          if (sameClerkMapping(current, params)) return current;
        }
        return rawSubUpdate(id, params);
      },
    },
    customers: {
      retrieve: rawCustomerRetrieve,
      update: async (id: string, params: any) => {
        if (params?.metadata?.clerk_user_id && Object.keys(params).length === 1) {
          const current = await rawCustomerRetrieve(id);
          if (!current?.deleted && sameClerkMapping(current, params)) return current;
        }
        return rawCustomerUpdate(id, params);
      },
    },
  };
}

export const _test = { isRateLimitError, retryClerk, sameClerkMapping };
