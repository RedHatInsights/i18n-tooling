# Harness notes

Use the same workflow in Claude Code, Codex CLI, opencode, and Pi. Ask the consolidated wizard through the harness's user-facing question mechanism. If it cannot show structured multi-choice fields, present the numbered questions together with detected defaults and wait for one reply. Do not split them into follow-up prompts.

To find Jira support, inspect the tools or integrations configured for the current session and the available command-line tools. Use an available Jira integration or the `acli` CLI only after the developer chose ticket creation. If no Jira tool is available, write Markdown drafts in the working tree and report that fallback. Never guess a harness-specific tool name.

- **Claude Code:** use its question UI when available; otherwise present one numbered prompt. Inspect connected MCP tools and available CLIs for Jira.
- **Codex CLI:** use the current session's user-input or prompt flow; inspect available MCP tools and CLIs for Jira.
- **opencode:** use its configured prompt/question flow; inspect available tools and CLIs for Jira.
- **Pi:** use its available question mechanism or one numbered prompt; inspect registered tools and CLIs for Jira.
