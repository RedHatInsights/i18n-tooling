# Harness notes

Use the same workflow in Claude Code, Codex CLI, opencode, and Pi. Ask the wizard through the harness's structured question tool when the current session lists one. A tool that caps the questions per call gets consecutive calls, all sent before any edit. The wizard is required input: when a call returns no answers, ask again or stop, and make no edits on assumed answers.

- **Claude Code:** `AskUserQuestion` takes up to four questions per call, each with two to four options, plus a free-text "Other". Put the applicable questions in two consecutive calls. Use `multiSelect` for the tracks question. Mark a preselected answer by listing it first with "(Recommended)" in its label.
- **Codex CLI:** use `request_user_input` when it is listed for the turn. Codex offers it in Plan mode, and in Default mode only when the session was started with `codex --enable default_mode_request_user_input`. When it is not listed, use the text form below, and tell the developer once that this flag gives a choice UI. The reply arrives as a new user message.
- **opencode and Pi:** use the session's question tool when one is listed. Otherwise use the text form below.

## Text form

When no question tool is available, send the whole wizard as one message:

- One short heading per question, with lettered options on separate lines.
- Mark each preselected option with `(default)`. A question without a default says "choose one".
- End with one reply line showing how to answer, for example: `Reply "ok" to accept the defaults, plus your answers to 2 and 4 (e.g. "ok, 2c, 4a"). Free text works for anything else.`

## Jira

To find Jira support, inspect the tools or integrations configured for the current session and the available command-line tools. Use an available Jira integration or the `acli` CLI only after the developer chose ticket creation. If no Jira tool is available, write Markdown drafts in the working tree and report that fallback. Never guess a tool name; use only tools the session lists.
