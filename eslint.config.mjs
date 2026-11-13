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
      // 2026-10-29 重写前的旧代码，只作参考，不检查。
      '*_bak/**',
      'bak/**',
      // Cordis 源码克隆、搬 0.5 时的参考文件、NamiDSH：只读，不检查。
      'src6/cordis/**',
      'src6/参考_src5/**',
      'namidsh/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'scripts6/**/*.ts', 'tests/**/*.ts', 'src6/**/*.ts', 'tests6/**/*.ts', 'web/Build.ts', 'testpage/Build.ts', 'learn/**/*.ts'],
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
  // 网页代码运行在浏览器，用 web/tsconfig.json 的 DOM/JSX 设置做类型检查（docs/界面/01_界面设计.md）。
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
  // 接口测试页：和网页同一套规则，用 testpage/tsconfig.json。
  {
    files: ['testpage/src/**/*.{ts,tsx}'],
    extends: [
      eslintJs.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: ['./testpage/tsconfig.json'],
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
      'src6/**/*.ts',
      'tests6/**/*.ts',
      'web/**/*.{ts,tsx}',
      'testpage/**/*.{ts,tsx}',
      'scripts/**/*.{ts,mjs}',
      'scripts6/**/*.ts',
      'tests/**/*.{ts,mjs}',
      'learn/**/*.ts',
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
