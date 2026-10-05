import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "../src/rules/extractable-message-descriptor.js";

const valid = [
  {
    code: "formatMessage({ id: 'example.title', defaultMessage: 'Title' });",
  },
  {
    code: "intl.formatMessage({ id: 'example.title', defaultMessage: 'Title' });",
  },
  {
    code: "intl.$t({ 'id': 'example.title', 'defaultMessage': 'Title' });",
  },
  {
    code: "$formatMessage({ id: 'example.title', defaultMessage: 'Title' });",
  },
  {
    code: "defineMessage({ id: 'example.title', defaultMessage: 'Title' });",
  },
  {
    code: "defineMessages({ title: { id: 'example.title', defaultMessage: 'Title' } });",
  },
  {
    code: "const messages = defineMessages({ title: { id: 'example.title', defaultMessage: 'Title' } }); intl.formatMessage(messages.title);",
  },
  {
    code: "const metadata = { id: 'example.title' };",
  },
  {
    code: "const dynamicId = { id, defaultMessage: 'Title' };",
  },
];

const invalid = [
  {
    code: "const message = { id: 'example.title', defaultMessage: 'Title' };",
    errors: [{ messageId: "notExtractable" }],
  },
  {
    code: "const message = { id: 'example.title', defaultMessage: 'Title' }; intl.formatMessage(message);",
    errors: [{ messageId: "notExtractable" }],
  },
  {
    code: "other({ id: 'example.title', defaultMessage: 'Title' });",
    errors: [{ messageId: "notExtractable" }],
  },
  {
    code: "formatMessage({ wrapper: { id: 'example.title', defaultMessage: 'Title' } });",
    errors: [{ messageId: "notExtractable" }],
  },
  {
    code: "formatMessage(condition ? { id: 'example.title', defaultMessage: 'Title' } : { id: 'example.title', defaultMessage: 'Title' });",
    errors: [{ messageId: "notExtractable" }, { messageId: "notExtractable" }],
  },
  {
    code: "defineMessages({ nested: { title: { id: 'example.title', defaultMessage: 'Title' } } });",
    errors: [{ messageId: "notExtractable" }],
  },
];

describe("extractable-message-descriptor", () => {
  it("allows descriptors only in FormatJS extraction positions", () => {
    const tester = new RuleTester({
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    });
    tester.run("extractable-message-descriptor", rule, { valid, invalid });
  });
});
