import type { SiteClassification, SiteIntelligenceSignals, SiteType } from '@qa/shared';

interface SiteRule {
  type: SiteType;
  journeys: string[];
  features: string[];
  score: (s: SiteIntelligenceSignals) => number;
}

const all = (s: SiteIntelligenceSignals) =>
  [s.title, s.metaDescription, s.textSample, ...s.headings, ...s.linkTexts, ...s.buttonTexts]
    .join(' ')
    .toLowerCase();

function countMatches(text: string, terms: string[]): number {
  return terms.filter((t) => text.includes(t)).length;
}

const RULES: SiteRule[] = [
  {
    type: 'ecommerce',
    journeys: [
      'Browse product catalog',
      'Open product detail page',
      'Add item to cart',
      'View cart and update quantities',
      'Proceed to checkout',
      'Verify order summary / confirmation',
    ],
    features: ['product-catalog', 'cart', 'checkout', 'order'],
    score(s) {
      const text = all(s);
      const strong = countMatches(text, [
        'add to cart', 'add to bag', 'buy now', 'checkout', 'shopping cart',
        'your cart', 'place order', 'order summary', 'shop now',
      ]);
      const medium = countMatches(text, [
        'product', 'price', 'shop', 'store', 'sale', 'discount',
        'wishlist', 'quantity', 'shipping', 'delivery',
      ]);
      const urlScore = countMatches(s.urlPaths.join(' '), [
        '/cart', '/checkout', '/products', '/shop', '/store', '/order',
      ]);
      return strong * 0.25 + medium * 0.07 + urlScore * 0.15;
    },
  },
  {
    type: 'booking',
    journeys: [
      'Find search / availability form',
      'Fill in dates and guest count',
      'Browse available options',
      'Select option and fill details',
      'Confirm booking and check confirmation',
    ],
    features: ['availability-search', 'date-picker', 'reservation', 'confirmation'],
    score(s) {
      const text = all(s);
      const strong = countMatches(text, [
        'book now', 'check availability', 'reserve', 'reservation',
        'check-in', 'check-out', 'check in', 'check out',
        'book a', 'available dates', 'appointment',
      ]);
      const medium = countMatches(text, [
        'hotel', 'flight', 'room', 'guest', 'nights', 'calendar',
        'schedule', 'availability', 'slots', 'property',
      ]);
      const hasDateInput = s.inputTypes.some((t) => t === 'date' || t === 'datetime-local');
      return strong * 0.25 + medium * 0.07 + (hasDateInput ? 0.3 : 0);
    },
  },
  {
    type: 'saas-dashboard',
    journeys: [
      'Navigate sidebar to main entity list',
      'Create a new entity',
      'Edit an existing entity',
      'Delete an entity and verify removal',
      'Check settings / profile management',
    ],
    features: ['dashboard', 'entity-crud', 'sidebar-nav', 'settings'],
    score(s) {
      const text = all(s);
      const strong = countMatches(text, [
        'dashboard', 'workspace', 'project', 'new project', 'create new',
        'analytics', 'overview', 'team', 'members', 'settings',
      ]);
      const medium = countMatches(text, [
        'manage', 'workflow', 'integration', 'invite', 'billing',
        'usage', 'plan', 'upgrade', 'account', 'organization',
      ]);
      const urlScore = countMatches(s.urlPaths.join(' '), [
        '/dashboard', '/settings', '/projects', '/workspace', '/admin',
      ]);
      return strong * 0.2 + medium * 0.07 + urlScore * 0.15;
    },
  },
  {
    type: 'auth-portal',
    journeys: [
      'Login with valid credentials → verify home page reached',
      'Login with invalid credentials → verify error message shown',
      'Login with empty fields → verify validation',
      'Logout → verify redirect to login page',
      'Access protected page without login → verify redirect',
    ],
    features: ['login-form', 'credential-validation', 'logout', 'redirect-on-auth'],
    score(s) {
      const text = all(s);
      // Strong signal: login form IS the main content on the landing page
      const hasPasswordInput = s.inputTypes.includes('password');
      const strong = countMatches(text, [
        'sign in', 'log in', 'login', 'sign up',
        'forgot password', 'reset password', 'username', 'email address',
      ]);
      const isLoginHeavy = strong >= 2 && hasPasswordInput;
      // Penalise if the site also has cart/product signals (ecommerce wins)
      const hasEcommerce = countMatches(text, ['add to cart', 'checkout', 'product']) > 0;
      return (isLoginHeavy ? 0.6 : strong * 0.1) + (hasPasswordInput ? 0.2 : 0) - (hasEcommerce ? 0.3 : 0);
    },
  },
  {
    type: 'blog-cms',
    journeys: [
      'Browse article listing page',
      'Open a single article and read content',
      'Test search functionality',
      'Browse by category or tag',
      'Check pagination of article list',
    ],
    features: ['article-listing', 'single-post', 'categories', 'search'],
    score(s) {
      const text = all(s);
      const strong = countMatches(text, [
        'read more', 'continue reading', 'published', 'author',
        'category', 'tag', 'blog', 'article', 'post',
      ]);
      const medium = countMatches(text, [
        'comment', 'share', 'newsletter', 'subscribe', 'latest',
        'featured', 'popular', 'trending', 'min read',
      ]);
      return strong * 0.12 + medium * 0.06;
    },
  },
  {
    type: 'social',
    journeys: [
      'Browse main feed',
      'Open a user profile',
      'Follow / like / react to a post',
      'Create a new post',
      'Check notification flow',
    ],
    features: ['feed', 'user-profiles', 'follow', 'reactions', 'notifications'],
    score(s) {
      const text = all(s);
      const strong = countMatches(text, [
        'follow', 'like', 'share', 'comment', 'post', 'feed',
        'profile', 'friends', 'connections', 'notification',
      ]);
      const medium = countMatches(text, [
        'timeline', 'story', 'message', 'group', 'event',
        'react', 'mention', 'tag',
      ]);
      return strong * 0.15 + medium * 0.07;
    },
  },
  {
    type: 'fintech',
    journeys: [
      'View account balance / dashboard',
      'Initiate a transfer or payment',
      'Review transaction history',
      'Verify confirmation / receipt',
      'Check security / 2FA settings',
    ],
    features: ['balance', 'transactions', 'transfer', 'payment', 'security'],
    score(s) {
      const text = all(s);
      const strong = countMatches(text, [
        'balance', 'transfer', 'transaction', 'payment', 'account',
        'bank', 'deposit', 'withdraw', 'send money', 'pay now',
      ]);
      const medium = countMatches(text, [
        'currency', 'amount', 'recipient', 'statement', 'invoice',
        'wallet', 'credit', 'debit', 'fund',
      ]);
      return strong * 0.2 + medium * 0.08;
    },
  },
];

export function classifySite(signals: SiteIntelligenceSignals): SiteClassification {
  const scores = RULES.map((rule) => ({
    rule,
    raw: Math.min(rule.score(signals), 1),
  }));

  scores.sort((a, b) => b.raw - a.raw);
  const best = scores[0];

  if (best.raw < 0.3) {
    return {
      siteType: 'generic',
      confidence: best.raw,
      signals: ['No strong domain signals detected'],
      inferredJourneys: ['Navigate key pages', 'Test forms', 'Check error states'],
      keyFeatures: ['generic'],
    };
  }

  const explainSignals: string[] = [];
  const text = all(signals);

  for (const r of RULES.slice(0, 3)) {
    if (r.type === best.rule.type) {
      for (const term of [
        'add to cart', 'book now', 'dashboard', 'sign in', 'read more', 'follow', 'balance',
        'checkout', 'reservation', 'workspace', 'login', 'article', 'transaction',
      ]) {
        if (text.includes(term)) {
          explainSignals.push(`Found "${term}" in page content`);
        }
      }
    }
  }

  if (signals.inputTypes.includes('date')) explainSignals.push('Date input field detected');
  if (signals.inputTypes.includes('password')) explainSignals.push('Password input field detected');
  if (explainSignals.length === 0) explainSignals.push(`Page title: "${signals.title}"`);

  return {
    siteType: best.rule.type,
    confidence: best.raw,
    signals: explainSignals.slice(0, 5),
    inferredJourneys: best.rule.journeys,
    keyFeatures: best.rule.features,
  };
}
