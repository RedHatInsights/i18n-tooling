# Harness notes

Use the same workflow in Claude Code, Codex CLI, opencode, and Pi. Send the plan as message text first; option labels are too short to carry it. Then ask the approval question through the harness's structured question tool when the current session lists one: one question with the options **Proceed**, **Adjust**, and **Stop**. Ask the wizard the same way, only after the developer chose to adjust. A tool that caps the questions per call gets consecutive calls for the wizard, all sent before any edit. When the plan has no tracking ticket key, ask the ticket question in the same call as the approval (the text form adds it to the reply line). Approval and the ticket choice are required input: when a call returns no answer to either, ask again or stop, and make no edits on an assumed answer.

- **Claude Code:** `AskUserQuestion` takes up to four questions per call, each with two to four options, plus a free-text "Other" that carries a reply naming its own changes. For the approval question, list **Proceed (Recommended)** first. For the wizard, put the applicable questions in two consecutive calls, use `multiSelect` for the tracks question, and mark each plan value by listing it first with "(Recommended)" in its label.
- **Codex CLI:** use `request_user_input` when it is listed for the turn. Codex offers it in Plan mode, and in Default mode only when the session was started with `codex --enable default_mode_request_user_input`. When it is not listed, use the text form below, and tell the developer once that this flag gives a choice UI. The reply arrives as a new user message.
- **opencode and Pi:** use the session's question tool when one is listed. Otherwise use the text form below.

## Text form

When no question tool is available, end the plan message with one reply line, for example: `Reply "go" to proceed, "adjust" to change anything, or "stop". You can also name changes directly, e.g. "go, fr only".` When the tracking ticket is open, add it to that line: `Also name the tracking ticket: a key such as RHCLOUD-12345, "create", "draft", or "none" (e.g. "go, create").`

When the developer chooses to adjust, send the whole wizard as one message:

- One short heading per question, with lettered options on separate lines.
- Mark each plan value with `(plan)`.
- End with one reply line showing how to answer, for example: `Reply "ok" to keep the plan, or list only what changes (e.g. "ok, 4c"). Free text works for anything else.`

## Jira

The ticket question offers **Create** (naming the project), **Draft**, and **None**; an existing key arrives as free text ("Other" in `AskUserQuestion`). To find Jira support, inspect the tools or integrations configured for the current session and the available command-line tools. Reading an existing ticket to confirm its key and title is allowed at any time. Create a ticket with an available Jira integration or the `acli` CLI only after the approved plan includes ticket creation. If no Jira tool is available, write Markdown drafts in the working tree and report that fallback. Never guess a tool name; use only tools the session lists.
