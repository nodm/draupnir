import baseConfig from '../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/vitest.config.{js,cjs,mjs,ts,cts,mts}',
          ],
          // @pulumi/pulumi and @pulumi/aws are declared ahead of use: index.ts
          // intentionally declares zero resources at this stage (see design.md),
          // so no static import exists yet for dependency-checks to find.
          ignoredDependencies: ['@pulumi/pulumi', '@pulumi/aws'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
