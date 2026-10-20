// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.config.*',
      '**/next-env.d.ts',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    // Domain code: no `any`, no I/O.
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pg', 'drizzle-orm*', '@nestjs/*', 'node:fs', 'node:net', 'node:http'],
              message: 'packages/domain must stay pure (no I/O).',
            },
          ],
        },
      ],
    },
  },
  {
    // Module boundaries in the API: a module may import another module only via its public index.
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // ../<other-module>/<anything but index.js>  (not ../../ shared infra/common)
              regex: '^\\.\\./(?!\\.\\.)[^/]+/(?!index\\.js$)[^/]+',
              message:
                'Import other modules only through their public index.ts (service interface).',
            },
          ],
        },
      ],
    },
  },
);
