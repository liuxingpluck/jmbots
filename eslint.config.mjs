// src7、Bun 脚本和网页各用自己的类型项目，MJS 使用 Node 规则。
import eslintJs from '@eslint/js';
import * as eslintConfig from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const structureRules = {
  curly: 'off',
  'jmbots/require-blocks': 'warn',
  'no-nested-ternary': 'error',
  //M 跨模块运行时成员保留来源前缀，纯类型和有清楚库名的默认导出可保留。
  'no-restricted-syntax': [
    'warn',
    {
      selector: 'ImportDeclaration[importKind!="type"] > ImportSpecifier[importKind!="type"]',
      message: '运行时成员请使用模块命名空间，如 path.resolve()、yaml.parseDocument()；类型请用 import type。',
    },
  ],
};

const requireBlocks = {
  meta: {
    schema: [],
    messages: { expected: '请用大括号包住这条分支或循环语句。' },
  },
  create(context) {
    function checkBody(body) {
      //M 多个分支分别报告，提示定位到需要括号的语句。
      if (body.type !== 'BlockStatement') {
        const violation = { node: body, messageId: 'expected' };
        context.report(violation);
      }
    }

    function checkLoop(node) {
      //M 循环体始终需要大括号。
      checkBody(node.body);
    }

    return {
      IfStatement(node) {
        const sameLine = node.loc.start.line === node.loc.end.line;
        const followsElse = node.parent.type === 'IfStatement' && node.parent.alternate === node;
        const guardReturn = node.consequent.type === 'ReturnStatement';
        const alternate = node.alternate;
        //G 只有独立的单行提前 return 可以省掉大括号。
        const exempt = alternate === null && !followsElse && sameLine && guardReturn;
        if (!exempt) {
          checkBody(node.consequent);
        }

        //M else if 会作为自己的 IfStatement 节点检查。
        if (alternate !== null && alternate.type !== 'IfStatement') {
          checkBody(alternate);
        }
      },
      ForStatement: checkLoop,
      ForInStatement: checkLoop,
      ForOfStatement: checkLoop,
      WhileStatement: checkLoop,
      DoWhileStatement: checkLoop,
    };
  },
};

const src7Presets = [eslintJs.configs.recommended, ...tseslint.configs.recommendedTypeChecked, prettier];
const src7Errors = ['preserve-caught-error', '@typescript-eslint/no-floating-promises'];

/** 保留已有规则选项，逐步清理的 src7 问题按警告报告。 */
function getSrc7Rules() {
  const presetRules = src7Presets.map((config) => config.rules);
  const rules = Object.assign({}, ...presetRules, structureRules);

  //M 这两类已修过的错误挡住回归，其余现存问题保留检查但先降为警告。
  for (const name of Object.keys(rules)) {
    if (src7Errors.includes(name)) {
      continue;
    }

    const setting = rules[name];
    let values = [setting];
    if (Array.isArray(setting)) {
      values = setting;
    }
    const [severity, ...options] = values;
    if (severity === 'error' || severity === 2) {
      rules[name] = ['warn', ...options];
    }
  }
  for (const name of src7Errors) {
    rules[name] = 'error';
  }
  return rules;
}

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
      // NamiDSH 只读，不检查。
      'namidsh/**',
    ],
  },
  {
    files: ['scripts/**/*.ts', 'web/Build.ts'],
    extends: [
      eslintJs.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.json'],
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
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    extends: [eslintJs.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['ztools/aobb-shot/**/*.ts'],
    extends: [
      eslintJs.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./ztools/aobb-shot/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Prettier只负责排版，先关闭冲突样式规则，再明确保留项目的结构约束。
  prettier,
  {
    files: [
      'src7/**/*.ts',
      'web/**/*.{ts,tsx}',
      'scripts/**/*.{ts,mjs}',
      'ztools/aobb-shot/**/*.ts',
      'eslint.config.mjs',
    ],
    plugins: { jmbots: { rules: { 'require-blocks': requireBlocks } } },
    rules: structureRules,
  },
  {
    files: ['src7/**/*.ts'],
    extends: src7Presets,
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: getSrc7Rules(),
  },
]);
