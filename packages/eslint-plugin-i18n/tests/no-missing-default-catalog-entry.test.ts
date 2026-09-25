import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import rule from '../src/rules/no-missing-default-catalog-entry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = path.join(here, 'fixtures/en.json');

const valid = [
  {
    code: "formatMessage({ id: 'example.title' });",
    options: [{ catalog }],
  },
  {
    code: "defineMessages({ count: { id: 'example.count', defaultMessage: 'x' } });",
    options: [{ catalog }],
  },
  {
    code: "intl.formatMessage({ id: `example.title` });",
    options: [{ catalog }],
  },
];

const invalid = [
  {
    code: "formatMessage({ id: 'example.missing' });",
    options: [{ catalog }],
    errors: [{ messageId: 'missingEntry' }],
  },
  {
    code: "formatMessage({ id: messageId });",
    options: [{ catalog }],
    errors: [{ messageId: 'dynamicId' }],
  },
];

describe('no-missing-default-catalog-entry', () => {
  it('checks supported FormatJS call forms', () => {
    const tester = new RuleTester({
      languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    });
    tester.run('no-missing-default-catalog-entry', rule, { valid, invalid });
    expect(readFileSync(catalog, 'utf8')).toContain('example.title');
  });
});
