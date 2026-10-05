import { describe, expect, it } from "vitest";
import {
  argumentMismatchHint,
  describeArgumentMismatch,
  lintSourceCatalog,
  lintSourceMessage,
  lintTargetCatalog,
  lintTargetMessage,
  type Catalog,
} from "../src/index.js";

function rules(pattern: string, locale = "en"): string[] {
  return lintSourceMessage("id", pattern, locale).map((warning) => warning.rule);
}

describe("plural-category-only-arguments", () => {
  it("reports a name rendered only in the one branch", () => {
    const [warning] = lintSourceMessage(
      "removeServiceAccountsText",
      "{count, plural, one {<b>{name}</b> service account} other {<b>#</b> service accounts}} will be removed from <b>{group}</b> group.",
      "en",
    );

    expect(warning?.rule).toBe("plural-category-only-arguments");
    expect(warning?.message).toContain(
      '"removeServiceAccountsText": {name} appears only in the "one" branch of plural {count}',
    );
    expect(warning?.message).toContain('Use an exact "=N" branch');
  });

  it("accepts exact =1 branches", () => {
    expect(
      rules("{count, plural, =1 {{name} account} one {# account} other {# accounts}}"),
    ).toEqual([]);
  });

  it("still reports one when =1 also renders the argument", () => {
    expect(
      rules("{count, plural, =1 {{name} account} one {{name} account} other {# accounts}}"),
    ).toEqual(["plural-category-only-arguments"]);
  });

  it("does not call an argument category-only when it also appears outside the plural", () => {
    expect(rules("{name} has {count, plural, one {{name} item} other {# items}}")).toEqual([]);
    expect(
      rules("{kind, select, other {{name}} x {{count, plural, one {{name}} other {#}}}}"),
    ).toEqual([]);
  });

  it("ignores the plural argument itself and arguments shared with other", () => {
    expect(rules("{count, plural, one {# role in {group}} other {# roles in {group}}}")).toEqual(
      [],
    );
  });

  it("checks nested plurals and arguments inside tags and selects", () => {
    const warnings = lintSourceMessage(
      "id",
      "{kind, select, user {{count, plural, one {<b>{gender, select, other {{name}}}</b>} other {#}}} other {x}}",
      "en",
    );

    expect(warnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining(
        '{gender}, {name} appears only in the "one" branch of plural {count}',
      ),
    ]);
  });

  it("checks selectordinal", () => {
    expect(
      rules("{place, selectordinal, one {#st by {name}} two {#nd} few {#rd} other {#th}}"),
    ).toEqual(["plural-category-only-arguments"]);
  });

  it("does not recommend =1 for zero or few category branches", () => {
    for (const [category, locale] of [
      ["zero", "en"],
      ["few", "ru"],
    ]) {
      const [warning] = lintSourceMessage(
        "id",
        `{count, plural, ${category} {{name}} other {#}}`,
        locale,
      );
      expect(warning?.message).toContain('Use an exact "=N" branch');
      expect(warning?.message).not.toContain('Use an exact "=1" branch');
    }
  });

  it("ignores invalid ICU", () => {
    expect(rules("{count, plural, one {{name}}")).toEqual([]);
  });
});

describe("unused-plural-category", () => {
  it("reports categories the source locale never selects", () => {
    const [warning] = lintSourceMessage(
      "items",
      "{count, plural, zero {No items} one {# item} other {# items}}",
      "en",
    );

    expect(warning?.rule).toBe("unused-plural-category");
    expect(warning?.message).toContain(
      '"zero" branch, but source locale "en" never selects "zero"',
    );
    expect(warning?.message).toContain('"=0" instead of "zero"');
  });

  it("uses the source locale's categories", () => {
    expect(
      rules("{count, plural, one {# item} few {# items} many {# items} other {# items}}", "ru"),
    ).toEqual([]);
    expect(rules("{count, plural, one {# item} other {# items}}", "zh_CN")).toEqual([
      "unused-plural-category",
    ]);
  });

  it("uses ordinal categories for selectordinal", () => {
    expect(rules("{place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}")).toEqual([]);
  });

  it("skips locales Intl cannot resolve", () => {
    expect(rules("{count, plural, zero {none} other {#}}", "und")).toEqual([]);
    expect(rules("{count, plural, zero {none} other {#}}", "not a locale")).toEqual([]);
  });
});

describe("lintSourceCatalog", () => {
  it("lints every message in ID order with the catalog locale", () => {
    const catalog: Catalog = {
      locale: "en",
      messages: {
        b: { pattern: "{count, plural, zero {none} other {#}}", metadata: {} },
        a: { pattern: "{count, plural, one {{name}} other {#}}", metadata: {} },
        c: { pattern: "Hello {name}", metadata: {} },
      },
    };

    expect(lintSourceCatalog(catalog).map(({ id, rule }) => [id, rule])).toEqual([
      ["a", "plural-category-only-arguments"],
      ["b", "unused-plural-category"],
    ]);
  });
});

describe("argument mismatch diagnostics", () => {
  const source = "{count, plural, one {{name} account} other {# accounts}} in {group}";

  it("explains arguments a target lost because the source used a plural category", () => {
    const mismatch = {
      id: "remove",
      source: ["count", "group", "name"],
      target: ["count", "group"],
    };

    expect(describeArgumentMismatch(source, mismatch)).toBe(
      '"remove": source [count, group, name], target [count, group] ' +
        '(source renders {name} only in the "one" branch of plural {count}, which can be dropped ' +
        'in locales without that category; use an exact "=N" source branch for count-specific content)',
    );
  });

  it("does not claim that a target locale lacks a category without knowing its locale", () => {
    const hint = argumentMismatchHint(source, {
      id: "remove",
      source: ["count", "group", "name"],
      target: ["count", "group"],
    });
    expect(hint).not.toContain("this locale does not use");
  });

  it("omits the hint when the source does not explain the mismatch", () => {
    const mismatch = {
      id: "remove",
      source: ["count", "group", "name"],
      target: ["count", "name"],
    };

    expect(argumentMismatchHint(source, mismatch)).toBeUndefined();
    expect(argumentMismatchHint("{count, plural", mismatch)).toBeUndefined();
    expect(describeArgumentMismatch(source, mismatch)).toBe(
      '"remove": source [count, group, name], target [count, name]',
    );
  });
});

describe("unformatted-count-argument", () => {
  it("reports plural selectors and count-like names printed without number formatting", () => {
    const findings = lintSourceMessage(
      "id",
      "{count, plural, one {# role} other {# roles}} ({count}) of {total} for {userCount} in {name}",
      "en",
    );

    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("{count} prints a number as raw digits"),
      expect.stringContaining("{total} prints a number as raw digits"),
      expect.stringContaining("{userCount} prints a number as raw digits"),
    ]);
    expect(findings.every((finding) => finding.severity === "warning")).toBe(true);
  });

  it("accepts number arguments and #", () => {
    expect(rules("{count, plural, other {# roles}} of {total, number}")).toEqual([]);
  });
});

function targetRules(source: string, target: string, locale: string): string[] {
  return lintTargetMessage("id", source, target, locale).map(
    (finding) => `${finding.severity}:${finding.rule}`,
  );
}

describe("target plural checks", () => {
  it("fails when a translation drops an exact branch", () => {
    const [finding] = lintTargetMessage(
      "remove",
      "{count, plural, =1 {Remove {name}?} other {Remove # accounts?}}",
      "{count, plural, other {删除 # 个帐户？}}",
      "zh-CN",
    );

    expect(finding).toMatchObject({ rule: "missing-exact-plural-selector", severity: "error" });
    expect(finding?.message).toContain("plural {count} lost exact branch =1");
  });

  it("fails when a translation removes the entire plural but keeps its argument", () => {
    expect(
      targetRules("{count, plural, =1 {one item} other {# items}}", "{count, number} items", "fr"),
    ).toEqual(["error:missing-exact-plural-selector"]);
    expect(
      targetRules(
        "{count, plural, =1 {one item} other {# items}}",
        "{count, select, other {items}}",
        "en",
      ),
    ).toEqual(["error:missing-exact-plural-selector"]);
  });

  it("warns when the other branch no longer shows the count", () => {
    expect(
      targetRules("{count, plural, other {# accounts}}", "{count, plural, other {帐户}}", "zh"),
    ).toEqual(["warning:plural-count-dropped"]);
    expect(
      targetRules(
        "{count, plural, other {# accounts}}",
        "{count, plural, other {{count} 个}}",
        "zh",
      ),
    ).toEqual([]);
    // FormatJS parses # inside a nested select as literal text.
    expect(
      targetRules(
        "{count, plural, other {# accounts}}",
        "{count, plural, other {{kind, select, other {<b>#</b> 个}}}}",
        "zh",
      ),
    ).toEqual(["warning:plural-count-dropped"]);
  });

  it("does not count # of a nested plural over another argument", () => {
    expect(
      targetRules(
        "{count, plural, other {# in {groups, plural, other {# groups}}}}",
        "{count, plural, other {{groups, plural, other {# 组}}}}",
        "zh",
      ),
    ).toEqual(["warning:plural-count-dropped"]);
  });

  it("warns about categories the target locale never selects", () => {
    const findings = lintTargetMessage(
      "id",
      "{count, plural, one {# account} other {# accounts}}",
      "{count, plural, one {# 个} other {# 个}}",
      "ja",
    );

    expect(findings.map((finding) => finding.rule)).toEqual(["unused-plural-category"]);
    expect(findings[0]?.message).toContain('target locale "ja" never selects "one"');
    expect(
      targetRules(
        "{count, plural, one {# account} other {# accounts}}",
        "{count, plural, one {# compte} many {# comptes} other {# comptes}}",
        "fr",
      ),
    ).toEqual([]);
  });

  it("ignores invalid ICU", () => {
    expect(targetRules("{count, plural", "{count}", "zh")).toEqual([]);
  });
});

describe("korean-particle-after-argument", () => {
  const source = "Remove {name}?";

  it("warns about consonant-dependent particles after runtime values", () => {
    expect(targetRules(source, "{name}을 삭제하시겠습니까?", "ko")).toEqual([
      "warning:korean-particle-after-argument",
    ]);
    expect(targetRules(source, "<b>{name}</b>이 삭제됩니다.", "ko")).toEqual([
      "warning:korean-particle-after-argument",
    ]);
    expect(
      targetRules("{count, plural, other {# groups}}", "{count, plural, other {#는}}", "ko"),
    ).toEqual(["warning:korean-particle-after-argument"]);
    expect(targetRules(source, "{group}로 이동", "ko")[0]).toBe(
      "warning:korean-particle-after-argument",
    );
  });

  it("accepts combined particle forms, words, and other locales", () => {
    expect(targetRules(source, "{name}을(를) 삭제하시겠습니까?", "ko")).toEqual([]);
    expect(targetRules(source, "{name}(으)로 이동", "ko")).toEqual([]);
    expect(targetRules(source, "{name} 이름을 변경", "ko")).toEqual([]);
    expect(targetRules(source, "{name}이름", "ko")).toEqual([]);
    expect(targetRules(source, "{name}님", "ko")).toEqual([]);
    expect(targetRules(source, "{name}を削除しますか?", "ja")).toEqual([]);
  });
});

describe("french-punctuation-space", () => {
  const source = "Remove {name}? Note: this is final.";

  it("warns once per message about breaking spaces before high punctuation", () => {
    const findings = lintTargetMessage(
      "id",
      source,
      "Supprimer {name} ? Remarque : « définitif » !",
      "fr",
    );

    expect(findings.map((finding) => finding.rule)).toEqual(["french-punctuation-space"]);
    expect(findings[0]?.message).toContain("U+00A0");
  });

  it("accepts non-breaking spaces, other locales, and Canadian French", () => {
    expect(targetRules(source, "Supprimer {name}\u202f? Remarque\u00a0: définitif.", "fr")).toEqual(
      [],
    );
    expect(targetRules(source, "Supprimer {name} ?", "fr_CA")).toEqual([]);
    expect(targetRules(source, "Remove {name} ?", "en")).toEqual([]);
  });
});

describe("lintTargetCatalog", () => {
  it("lints shared messages with the target locale", () => {
    const source: Catalog = {
      locale: "en",
      messages: {
        b: { pattern: "Remove {name}?", metadata: {} },
        a: { pattern: "{count, plural, =1 {{name}} other {#}}", metadata: {} },
        sourceOnly: { pattern: "x", metadata: {} },
      },
    };
    const target: Catalog = {
      locale: "fr",
      messages: {
        a: { pattern: "{count, plural, one {#} other {#}}", metadata: {} },
        b: { pattern: "Supprimer {name} ?", metadata: {} },
      },
    };

    expect(lintTargetCatalog(source, target).map(({ id, rule }) => [id, rule])).toEqual([
      ["a", "missing-exact-plural-selector"],
      ["b", "french-punctuation-space"],
    ]);
  });
});
