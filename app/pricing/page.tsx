'use client';

export default function Pricing() {
  const tiers = [
    {
      name: 'Starter',
      price: '$79',
      period: '/month',
      description: 'Perfect for contractors focused on one market',
      features: [
        '1 county',
        'Up to 50 permits/week',
        'Opportunity scoring',
        'Trade breakdown',
        'Smart targeting',
        'Weekly insights',
      ],
      cta: 'Get Started',
      href: 'https://buy.stripe.com/cNi3cvfWv1aT6Am63QdUY00',
      highlight: false,
    },
    {
      name: 'Pro',
      price: '$149',
      period: '/month',
      description: 'For contractors expanding across multiple counties',
      features: [
        'Up to 5 counties',
        'Unlimited permits',
        'Full opportunity scoring',
        'ZIP code heat maps',
        'Advanced trend analysis',
        'Priority support',
      ],
      cta: 'Go Pro',
      href: 'https://buy.stripe.com/pro_link',
      highlight: true,
    },
    {
      name: 'Team',
      price: '$299',
      period: '/month',
      description: 'For large contractors and multi-market operations',
      features: [
        'All Florida counties',
        'Unlimited permits',
        'White-label reports',
        'API access',
        'Team accounts',
        'Dedicated support',
      ],
      cta: 'Contact Us',
      href: 'mailto:dana@permitmap.org',
      highlight: false,
    },
  ];

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0f1e',
      color: '#e2e8f0',
      fontFamily: "'DM Sans', sans-serif",
      padding: '60px 24px',
    }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 56 }}>
          <h1 style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em',
            margin: '0 0 12px', color: '#f1f5f9' }}>
            Simple, transparent pricing
          </h1>
          <p style={{ fontSize: 16, color: '#64748b', margin: 0 }}>
            Real permit intelligence. No contracts. Cancel anytime.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
          {tiers.map(tier => (
            <div key={tier.name} style={{
              background: tier.highlight ? 'linear-gradient(135deg, #1e3a5f, #1e293b)' : '#111827',
              border: `1px solid ${tier.highlight ? '#2563eb' : '#1e293b'}`,
              borderRadius: 16,
              padding: '32px 28px',
              position: 'relative',
            }}>
              {tier.highlight && (
                <div style={{
                  position: 'absolute', top: -12, left: '50%',
                  transform: 'translateX(-50%)',
                  background: '#2563eb', color: '#fff',
                  fontSize: 11, fontWeight: 700, padding: '4px 12px',
                  borderRadius: 20, textTransform: 'uppercase', letterSpacing: '0.08em',
                }}>Most Popular</div>
              )}

              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#64748b',
                  textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                  {tier.name}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 8 }}>
                  <span style={{ fontSize: 40, fontWeight: 700, color: '#f1f5f9',
                    letterSpacing: '-0.03em' }}>{tier.price}</span>
                  <span style={{ fontSize: 14, color: '#475569' }}>{tier.period}</span>
                </div>
                <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>{tier.description}</p>
              </div>

              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 28px' }}>
                {tier.features.map(f => (
                  <li key={f} style={{ display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 0', fontSize: 14, color: '#94a3b8',
                    borderBottom: '1px solid #1e293b' }}>
                    <span style={{ color: '#22c55e', fontWeight: 700 }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              <a href={tier.href} style={{
                display: 'block', textAlign: 'center',
                padding: '12px 24px', borderRadius: 8,
                background: tier.highlight ? '#2563eb' : '#1e293b',
                color: '#fff', fontWeight: 700, fontSize: 14,
                textDecoration: 'none',
                border: tier.highlight ? 'none' : '1px solid #334155',
              }}>{tier.cta}</a>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap');
      `}</style>
    </div>
  );
}
