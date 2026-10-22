import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import rule from "../src/rules/no-duplicate-message-id.js";

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
  },
});

describe("no-duplicate-message-id", () => {
  it("reports ids declared twice with different text", () => {
    tester.run("no-duplicate-message-id", rule, {
      valid: [
        "defineMessages({ a: { id: 'x', defaultMessage: 'X' }, b: { id: 'y', defaultMessage: 'Y' } });",
        // reusing an identical descriptor is harmless
        "defineMessages({ a: { id: 'x', defaultMessage: 'X', description: 'd' } }); formatMessage({ id: 'x', defaultMessage: 'X', description: 'd' });",
        "formatMessage({ id: someId, defaultMessage: 'X' }); formatMessage({ id: someId, defaultMessage: 'Y' });",
      ],
      invalid: [
        {
          // insights-rbac-ui: the same key twice in defineMessages, same English, different context
          code: "defineMessages({\n  recommended: { id: 'recommendedContentTitle', defaultMessage: 'Recommended', description: 'Card title' },\n  recommended2: { id: 'recommendedContentTitle', defaultMessage: 'Recommended', description: 'Panel title' },\n});",
          errors: [
            {
              message:
                'Message id "recommendedContentTitle" is also declared on line 2 with a different defaultMessage or description; only one reaches the source catalog.',
              line: 3,
            },
          ],
        },
        {
          code: "defineMessage({ id: 'x', defaultMessage: 'A' });\nconst e = <FormattedMessage id=\"x\" defaultMessage=\"B\" />;",
          errors: [{ messageId: "duplicateId", line: 2 }],
        },
        {
          code: "defineMessages({ page: { title: { id: 'x', defaultMessage: 'A' } } });\nintl.formatMessage({ id: 'x', defaultMessage: 'A', description: { context: 'b' } });",
          errors: [{ messageId: "duplicateId", line: 2 }],
        },
      ],
    });
  });
});
