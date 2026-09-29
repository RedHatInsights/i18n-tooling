import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "../src/rules/no-missing-default-catalog-entry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = path.join(here, "fixtures/en.json");

const valid = [
  {
    code: "formatMessage({ id: 'example.title' });",
    options: [{ catalog }],
  },
  {
    code: "formatMessage({ 'id': 'example.title' });",
    options: [{ catalog }],
  },
  {
    code: "intl['formatMessage']({ id: 'example.title' });",
    options: [{ catalog }],
  },
  {
    code: "other({ id: 'example.missing' });",
    options: [{ catalog }],
  },
  {
    code: "intl.getMessage({ id: 'example.missing' });",
    options: [{ catalog }],
  },
  {
    code: "defineMessages({ count: { id: 'example.count', defaultMessage: 'x' } });",
    options: [{ catalog }],
  },
  {
    code: "defineMessages({ page: { header: { id: 'example.title' } } });",
    options: [{ catalog }],
  },
  {
    code: "const messages = defineMessages({ title: { id: 'example.title' } }); intl.formatMessage(messages.title);",
    options: [{ catalog }],
  },
  {
    code: "const messages = defineMessages({ title: { id: 'example.title' } }); <FormattedMessage {...messages.title} />;",
    options: [{ catalog }],
  },
  {
    code: "intl.formatMessage({ id: `example.title` });",
    options: [{ catalog }],
  },
  {
    code: '<FormattedMessage id="example.title" />;',
    options: [{ catalog }],
  },
  {
    code: '<Intl.FormattedMessage id="example.title" />;',
    options: [{ catalog }],
  },
];

const invalid = [
  {
    code: "formatMessage({ id: 'example.missing' });",
    options: [{ catalog }],
    errors: [{ messageId: "missingEntry" }],
  },
  {
    code: "defineMessages({ page: { header: { id: 'example.missing' } } });",
    options: [{ catalog }],
    errors: [{ messageId: "missingEntry" }],
  },
  {
    code: "const messages = defineMessages({ title: { id: 'example.missing' } }); intl.formatMessage(messages.title);",
    options: [{ catalog }],
    errors: [{ messageId: "missingEntry" }],
  },
  {
    code: "formatMessage({ defaultMessage: 'New message' });",
    options: [{ catalog }],
    errors: [{ messageId: "missingId" }],
  },
  {
    code: "formatMessage({ ['id']: 'example.title' });",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "formatMessage({ id: 'example.title', ...metadata });",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "formatMessage({ id: 'example.title', id: 'example.title' });",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "formatMessage({ id: 'example.title', ['id']: 'example.missing' });",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "formatMessage(getMessageDescriptor());",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "formatMessage(messageDescriptor);",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "const messages = { title: { id: 'example.missing' } }; intl.formatMessage(messages.title);",
    options: [{ catalog }],
    errors: [{ messageId: "missingEntry" }],
  },
  {
    code: "const message = defineMessage({ id: 'example.missing' }); intl.formatMessage(message);",
    options: [{ catalog }],
    errors: [{ messageId: "missingEntry" }],
  },
  {
    code: "formatMessage(messages[messageId]);",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "defineMessages({ count: { defaultMessage: 'New message' } });",
    options: [{ catalog }],
    errors: [{ messageId: "missingId" }],
  },
  {
    code: "defineMessages(descriptors);",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "defineMessages({ ...descriptors });",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "defineMessages({ count: getDescriptor() });",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "formatMessage(...descriptors);",
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "formatMessage({ id: messageId });",
    options: [{ catalog }],
    errors: [{ messageId: "dynamicId" }],
  },
  {
    code: "formatMessage({ id: `example.${suffix}` });",
    options: [{ catalog }],
    errors: [{ messageId: "dynamicId" }],
  },
  {
    code: '<FormattedMessage id="example.missing" />;',
    options: [{ catalog }],
    errors: [{ messageId: "missingEntry" }],
  },
  {
    code: '<FormattedMessage defaultMessage="New message" />;',
    options: [{ catalog }],
    errors: [{ messageId: "missingId" }],
  },
  {
    code: "<FormattedMessage id={messageId} />;",
    options: [{ catalog }],
    errors: [{ messageId: "dynamicId" }],
  },
  {
    code: "<FormattedMessage {...props} />;",
    options: [{ catalog }],
    errors: [{ messageId: "missingId" }],
  },
  {
    code: '<FormattedMessage id="example.title" {...props} />;',
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: '<FormattedMessage id="example.title" id="example.title" />;',
    options: [{ catalog }],
    errors: [{ messageId: "uninspectableDescriptor" }],
  },
  {
    code: "formatMessage({ id: 'example.title' });",
    options: [{ catalog: path.join(here, "fixtures/missing.json") }],
    errors: [{ messageId: "missingCatalog" }],
  },
  {
    code: "formatMessage({ id: 'example.title' });",
    options: [{ catalog: path.join(here, "fixtures/invalid.txt") }],
    errors: [{ messageId: "missingCatalog" }],
  },
  {
    code: "formatMessage({ id: 'example.title' });",
    options: [{ catalog: path.join(here, "fixtures/not-an-object.txt") }],
    errors: [{ messageId: "missingCatalog" }],
  },
];

describe("no-missing-default-catalog-entry", () => {
  it("checks supported FormatJS call forms", () => {
    const tester = new RuleTester({
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    });
    tester.run("no-missing-default-catalog-entry", rule, { valid, invalid });
  });
});
