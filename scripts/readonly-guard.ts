// Wraps an SDK client so only read methods can execute; any other method throws BEFORE a request is made.
const READ_OK = /^(list|retrieve|search|getUser|getUserList|getCount)/;

export function readOnly<T extends object>(label: string, target: T): T {
  const wrap = (obj: any, path: string): any => new Proxy(obj, {
    get(t, prop: string | symbol) {
      const v = t[prop as any];
      if (typeof prop === 'symbol') return v;
      if (typeof v === 'function') {
        return (...args: any[]) => {
          if (!READ_OK.test(prop)) throw new Error(`READ-ONLY GUARD: ${label}.${path}${prop}() blocked`);
          return v.apply(t, args);
        };
      }
      return v && typeof v === 'object' ? wrap(v, `${path}${prop}.`) : v;
    },
  });
  return wrap(target, '');
}

