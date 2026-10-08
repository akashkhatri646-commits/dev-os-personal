import type { Config } from 'tailwindcss'

// Tokens come from docs/design.md. Components use ONLY these semantic names;
// raw primitives live as CSS variables in src/app/globals.css.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      text: {
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        disabled: 'var(--text-disabled)',
        'on-brand': 'var(--text-on-brand)',
      },
      bg: {
        primary: 'var(--bg-primary)',
        surface: 'var(--bg-surface)',
        subtle: 'var(--bg-subtle)',
        pressed: 'var(--bg-pressed)',
        brand: 'var(--brand)',
        'brand-hover': 'var(--brand-hover)',
        'brand-subtle': 'var(--brand-subtle)',
      },
      border: {
        DEFAULT: 'var(--border-default)',
        strong: 'var(--border-strong)',
        brand: 'var(--brand)',
      },
      brand: {
        DEFAULT: 'var(--brand)',
        hover: 'var(--brand-hover)',
        subtle: 'var(--brand-subtle)',
      },
      success: {
        bg: 'var(--success-bg)',
        border: 'var(--success-border)',
        text: 'var(--success-text)',
        solid: 'var(--success-solid)',
      },
      danger: {
        bg: 'var(--danger-bg)',
        border: 'var(--danger-border)',
        text: 'var(--danger-text)',
        solid: 'var(--danger-solid)',
      },
      warning: {
        bg: 'var(--warning-bg)',
        border: 'var(--warning-border)',
        text: 'var(--warning-text)',
        solid: 'var(--warning-solid)',
      },
      info: {
        bg: 'var(--info-bg)',
        border: 'var(--info-border)',
        text: 'var(--info-text)',
        solid: 'var(--info-solid)',
      },
      accent: {
        bg: 'var(--accent-bg)',
        border: 'var(--accent-border)',
        text: 'var(--accent-text)',
        solid: 'var(--accent-solid)',
      },
    },
    // Tailwind's default spacing scale is already a 4px grid (1 = 4px, 24 = 96px, 28 = 112px).
    borderRadius: {
      none: '0px',
      sm: '4px',
      DEFAULT: '6px',
      md: '6px',
      lg: '8px',
      xl: '12px',
      full: '9999px',
    },
    fontFamily: {
      sans: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
      mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
    },
    // Type scale from the design system (size / line-height / weight). Letter-spacing is 0 everywhere.
    fontSize: {
      'body-sm': ['12px', { lineHeight: '18px', fontWeight: '400', letterSpacing: '0' }],
      'body-lg': ['16px', { lineHeight: '24px', fontWeight: '500', letterSpacing: '0' }],
      h5: ['24px', { lineHeight: '32px', fontWeight: '500', letterSpacing: '0' }],
      h4: ['28px', { lineHeight: '36px', fontWeight: '600', letterSpacing: '0' }],
      h3: ['30px', { lineHeight: '38px', fontWeight: '600', letterSpacing: '0' }],
      h2: ['36px', { lineHeight: '44px', fontWeight: '700', letterSpacing: '0' }],
      h1: ['48px', { lineHeight: '56px', fontWeight: '700', letterSpacing: '0' }],
    },
    extend: {
      transitionDuration: {
        fast: '100ms',
        base: '150ms',
        panel: '200ms',
        page: '250ms',
      },
    },
  },
  plugins: [],
}

export default config
