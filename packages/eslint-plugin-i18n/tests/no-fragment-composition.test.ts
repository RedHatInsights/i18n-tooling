import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import rule from "../src/rules/no-fragment-composition.js";
import chromeMessages from "./fixtures/chrome-fragment-messages.json" with { type: "json" };

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
  },
});
const message = (text: string) => `intl.formatMessage({ defaultMessage: ${JSON.stringify(text)} })`;
const error = { messageId: "composition" };

describe("no-fragment-composition", () => {
  it("preserves decimal and dotted-abbreviation labels and documented ambiguous adjacency", () => {
    tester.run("no-fragment-composition", rule, {
      valid: [
        `<p>{${message("Version 2.0")}} <a>{${message("Release notes")}}</a></p>`,
        `<p>{${message("Formats, e.g. CSV")}} <a>Help</a></p>`,
        `${message("Version 2.0")} + ' ' + ${message("Release notes")}`,
        "`${" + message("Formats, e.g. CSV") + "} ${" + message("Help") + "}`",
        `<p>{intl[formatMessage]({ defaultMessage: 'Try again. Contact' })} <a>support</a>.</p>`,
        `<p>{${message("Click")}} <a>{${message("here")}}</a> {${message("to continue")}}</p>`,
        `<p>{${message("If the problem persists, contact")}} {${message("support.")}}</p>`,
      ],
      invalid: [],
    });
  });
  it("recognizes computed calls and member JSX and reports nested compositions once", () => {
    tester.run("no-fragment-composition", rule, {
      valid: [],
      invalid: [
        `<p>{intl['formatMessage']({ defaultMessage: 'Try again. Contact' })} <a>support</a>.</p>`,
        `<p><Intl.FormattedMessage defaultMessage="Try again. Contact" /> <a>support</a>.</p>`,
        `<p>{${message("Try again. Contact")} + ' ' + ${message("support")}} <a>Guide</a></p>`,
        `<p>{${message("By participating")} + ${message(", you help.")}}</p>`,
        `<p>{${message("Read")} + ' '}<a>guide</a>.</p>`,
        `<p title={${message("Try again. Contact")} + ' ' + ${message("support")}}>Help</p>`,
        `<p title={\`\${${message("Try again. Contact")}} \${${message("support")}}\`}>Help</p>`,
        "<p>{`${" + message("By participating") + "}${" + message(", you help.") + "}`}</p>",
        "`${" + message("By participating") + " + `${" + message(", you help.") + "}`}`",
      ].map((code) => ({ code, errors: [error] })),
    });
  });
  it("reproduces Chrome's original message IDs, text, spacers, and icon-bearing links", () => {
    // insights-chrome a60c492c54e9315205872dbcbd26702c9b491b63, before PR #3774.
    const declarations = `const messages = defineMessages(${JSON.stringify(chromeMessages)});`;
    tester.run("no-fragment-composition", rule, {
      valid: [],
      invalid: [
        `<Content component="p">
          {intl.formatMessage(messages.describeReportBug)}{' '}
          <Content component="a">{intl.formatMessage(messages.openSupportCase)} <ExternalLinkAltIcon /></Content>
        </Content>`,
        `<Content component="p">
          {intl.formatMessage(messages.informDirectionDescription)}&nbsp;
          <Content component="a">{intl.formatMessage(messages.userResearchTeam)}</Content>
          {intl.formatMessage(messages.directInfluence)}
        </Content>`,
        `<div>
          {intl.formatMessage(messages.filterByTagsPopoverContent1)}{' '}
          <a>{intl.formatMessage(messages.filterByTagsPopoverSatelliteLink)}</a>
          {intl.formatMessage(messages.filterByTagsPopoverContent2)}{' '}
          <a>{intl.formatMessage(messages.filterByTagsPopoverCCGLink)}</a>{' '}
          {intl.formatMessage(messages.filterByTagsPopoverContent3)}
        </div>`,
        `<p>{intl.formatMessage(messages.problemProcessingRequest)}{' '}
          <a>{intl.formatMessage(messages.redHatSupport)}</a>
        </p>`,
      ].map((code) => ({ code: declarations + code, errors: [error] })),
    });
  });
  it("resolves relative default/named imports but not missing, dynamic, or shadowed descriptors", () => {
    const directory = mkdtempSync(join(tmpdir(), "i18n-descriptors-"));
    try {
      writeFileSync(
        join(directory, "messages.ts"),
        `export const request = { defaultMessage: 'Try again. Contact' }; export default defineMessages({ request });`,
      );
      const filename = join(directory, "View.tsx");
      tester.run("no-fragment-composition", rule, {
        valid: [
          {
            filename,
            code: `import messages from './missing'; <p>{intl.formatMessage(messages.request)} <a>support.</a></p>`,
          },
          {
            filename,
            code: `import messages from './messages'; function C(messages) { return <p>{intl.formatMessage(messages.request)} <a>support.</a></p> }`,
          },
          {
            filename,
            code: `import messages from './messages'; <p>{intl.formatMessage(messages[key])} <a>support.</a></p>`,
          },
        ],
        invalid: [
          {
            filename,
            code: `import messages from './messages'; <p>{intl.formatMessage(messages.request)} <a>support.</a></p>`,
            errors: [error],
          },
          {
            filename,
            code: `import { request as m } from './messages.js'; <p>{intl.formatMessage(m)} <a>support.</a></p>`,
            errors: [error],
          },
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("distinguishes inline composition from independent messages and unknown values", () => {
    tester.run("no-fragment-composition", rule, {
      valid: [
        `${message("{count, plural, one {One item.} other {Many items.}}")} + ' ' + ${message("Continue.")}`,
        `<p>{${message("Status")}} {${message("Ready.")}}</p>`,
        `${message("Read <Link>the guide.</Link>")} + ' ' + ${message("Next sentence.")}`,
        `<p>{${message("Try again.")}} {${message("Contact support.")}}</p>`,
        `<div><p>{${message("Contact")}}</p><p>{${message("support.")}}</p></div>`,
        `<div><span>{${message("Name")}}</span><span>{${message("Status")}}</span></div>`,
        `<p>{${message("Documentation:")}} <a>{${message("Guide")}}</a></p>`,
        `<p>{${message("Read the documentation.")}} <a>{${message("Guide")}}</a></p>`,
        `<p>{${message("Read <Link>the guide</Link>.")}}</p>`,
        `${message("First sentence.")} + ' ' + ${message("Second sentence.")}`,
        "`${" + message("First sentence.") + "} ${" + message("Second sentence.") + "}`",
        `${message("Status")} + ': ' + ${message("Ready.")}`,
        `<p>{intl.formatMessage(dynamic)} <a>{${message("Guide")}}</a></p>`,
        `<p>{${message("Try again. Contact")}}{unknown}<a>{${message("support")}}</a></p>`,
        `const m = { a: { defaultMessage: 'Try again. Contact' } }; function C(m) { return <p>{intl.formatMessage(m.a)} <a>support.</a></p>; }`,
        `const m = { a: { defaultMessage: 'Try again. Contact' } }; m.a = other; <p>{intl.formatMessage(m.a)} <a>support.</a></p>`,
      ],
      invalid: [
        {
          code: `<p>{${message("By participating")}}<em>{${message(", you help shape our products.")}}</em></p>`,
          errors: [error],
        },
        {
          code: `<p>{${message("By participating")}}{${message(", you help shape our products.")}}</p>`,
          errors: [error],
        },
        {
          code: `<p><span>{${message("Try again. Contact")}} <a>support</a>.</span></p>`,
          errors: [error],
        },
        { code: `<p>{${message("Read")}} <a>the guide</a>.</p>`, errors: [error] },
        {
          code: `<p>{${message("Try again. Contact")}} <a>{${message("support")}}</a>.</p>`,
          errors: [error],
        },
        {
          code: `<p>{${message("Participate with our")}} <a>{${message("Research team")}}</a>{${message(", and shape our products.")}}</p>`,
          errors: [error],
        },
        {
          code: `<div>{${message("Tags can be")}} <a>{${message("imported")}}</a>{${message(". Read our")}} <a>{${message("guide")}}</a>{${message("for details.")}}</div>`,
          errors: [error],
        },
        {
          code: `<p>{${message("Try again. Contact")}} <a>{${message("support")}}</a> {${message("or check our")}} <a>{${message("Status page")}}</a> {${message("for known outages.")}}</p>`,
          errors: [error],
        },
        { code: `${message("Try again. Contact")} + ' ' + ${message("support")}`, errors: [error] },
        {
          code: "`${" + message("Try again. Contact") + "} ${" + message("support") + "}`",
          errors: [error],
        },
        {
          code: `<p><FormattedMessage defaultMessage="Try again. Contact" /> <a><FormattedMessage defaultMessage="support" /></a>.</p>`,
          errors: [error],
        },
        {
          code: `const messages = defineMessages({ a: { defaultMessage: 'Try again. Contact' }, b: { defaultMessage: 'support' } }); <p>{intl.formatMessage(messages.a)} <a>{intl.formatMessage(messages.b)}</a>.</p>`,
          errors: [error],
        },
        {
          code: `const m = defineMessage({ defaultMessage: 'Try again. Contact' }); <p>{intl.formatMessage(m)} <Content component="a">support</Content>.</p>`,
          errors: [error],
        },
        {
          code: `<p>{${message("再試行してください。連絡先")}} <a>{${message("サポート")}}</a>。</p>`,
          errors: [error],
        },
      ],
    });
  });
});
