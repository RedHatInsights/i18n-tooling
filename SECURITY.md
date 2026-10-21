# Security Policy

## Supported Versions

Only the latest code on the default branch (`main`) and the latest published release of each npm package are actively supported with security fixes. Consumers of the reusable GitHub Actions workflows pin a reviewed commit SHA; move the pin forward to pick up fixes.

| Version               | Supported |
| --------------------- | --------- |
| `main`                | Yes       |
| Latest npm release    | Yes       |
| Older releases / tags | No        |

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues or pull requests.

This covers the repository, the published npm packages `@redhat-cloud-services/i18n-pipeline` and `@redhat-cloud-services/eslint-plugin-i18n`, the container image, and the reusable GitHub Actions workflows.

### GitHub Private Vulnerability Reporting (Preferred)

To report a vulnerability privately through GitHub:

1. Navigate to the repository's main page on GitHub.
2. Click the **Security** tab.
3. Click **Report a vulnerability** to open the advisory form.
4. Fill in the details (description, steps to reproduce, potential impact) and click **Submit report**.

Maintainers will review the submission, provide updates directly within the advisory, and coordinate any fixes in a private fork before disclosure.

### Alternative Contact

If private reporting is unavailable via the Security tab, please report security issues to Red Hat Product Security at [secalert@redhat.com](mailto:secalert@redhat.com). For more information, see [Red Hat Product Security Contact](https://access.redhat.com/security/team/contact).

## Scope Notes

- The `validate` and `validate-ci` commands deliberately run repository-configured generator commands and custom catalog adapter modules. Run them only in CI jobs without secrets, as the shipped reusable workflow does.
- The `tms` commands run with Phrase and GitHub write credentials and load built-in catalog adapters only.
