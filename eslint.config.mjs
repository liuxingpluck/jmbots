// TS 源码、Bun 脚本与离线测试共用只检查不产物的工程；MJS 保持 Node 兼容规则。
import eslintJs from '@eslint/js';
import * as eslintConfig from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default eslintConfig.defineConfig([
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'runtime/**',
      'data/**',
      '**/data/**',
      'docs/**',
      '**/*.local.*',
      '**/secrets*',
      'bun.lock',
      '.codegraph/**',
      // 2026-10-29 重写前的旧代码，只作参考，不检查。
      '*_bak/**',
      'bak/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
    extends: [
      eslintJs.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.check.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // 网页代码运行在浏览器，用 web/tsconfig.json 的 DOM/JSX 设置做类型检查。
  {
    files: ['web/src/**/*.{ts,tsx}'],
    extends: [
      eslintJs.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: ['./web/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.mjs'],
    extends: [eslintJs.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  // Prettier只负责排版，先关闭冲突样式规则，再明确保留项目的结构约束。
  prettier,
  {
    files: [
      'src/**/*.ts',
      'web/src/**/*.{ts,tsx}',
      'scripts/**/*.{ts,mjs}',
      'tests/**/*.{ts,mjs}',
      'eslint.config.mjs',
    ],
    rules: {
      curly: ['error', 'all'],
      'no-nested-ternary': 'error',
      // 所有跨模块运行时成员保留来源前缀；纯类型和有清楚库名的默认导出可保留。
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportDeclaration[importKind!="type"] > ImportSpecifier[importKind!="type"]',
          message:
            '运行时成员请使用模块命名空间，如 path.resolve()、yaml.parseDocument()；类型请用 import type。',
        },
      ],
    },
  },
]);
