module.exports = {
    root: true,
    env: { browser: true, es2020: true, node: true },
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:react-hooks/recommended',
    ],
    ignorePatterns: ['dist', '.eslintrc.cjs', 'server/dist', 'test-render.tsx'],
    parser: '@typescript-eslint/parser',
    plugins: ['react-refresh'],
    rules: {
        'react-refresh/only-export-components': [
            'warn',
            { allowConstantExport: true },
        ],

        /**
         * A leading underscore already means "deliberately unused" throughout
         * this codebase — Express error middleware must declare all four
         * parameters to be recognised as an error handler, and several
         * signatures keep arguments the implementation no longer reads.
         *
         * Without this setting the convention and the linter disagree, and the
         * linter wins by being noisy: it reported ten violations of a rule the
         * code was already following correctly.
         */
        '@typescript-eslint/no-unused-vars': ['error', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
        }],

        /**
         * `any` is a warning here rather than an error, deliberately.
         *
         * The remaining uses are concentrated at boundaries where a precise
         * type is genuinely unavailable — Prisma's transaction client inside
         * `$transaction`, multer's file shapes, Razorpay's untyped SDK
         * responses, and Express request augmentation. Replacing them wholesale
         * with `unknown` means a cast at every use, which moves the unsoundness
         * rather than removing it, and does so across the payment and ledger
         * paths — the two places where a refactor for tidiness is least worth
         * the risk.
         *
         * So: not a blocker, but permanently visible. CI pins the warning
         * ceiling to today's count, which makes this a ratchet — the number can
         * fall and cannot rise.
         */
        '@typescript-eslint/no-explicit-any': 'warn',
    },
    overrides: [
        {
            /**
             * Tests lazily `require()` modules after `jest.mock` has been set
             * up, which is the documented way to control import order and
             * cannot be expressed with a static import.
             */
            files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
            rules: {
                '@typescript-eslint/no-var-requires': 'off',
            },
        },
    ],
}
