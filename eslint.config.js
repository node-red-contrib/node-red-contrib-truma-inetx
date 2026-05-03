import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  Buffer: 'readonly',
  console: 'readonly',
  module: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly'
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'output/**', 'captures/**', 'analysis/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'preserve-caught-error': 'off'
    }
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: nodeGlobals
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error'
    }
  },
  {
    files: ['bin/**/*.js', 'test/**/*.js', 'nodes/**/*.js', 'eslint.config.js'],
    languageOptions: {
      globals: nodeGlobals
    },
    rules: {
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unused-expressions': 'off'
    }
  }
);
