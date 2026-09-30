/**
 * The system prompt for the hosted agent (ORI-2207).
 *
 * OpenCode (the program that runs the agent in a hosted session) ships its own
 * built-in prompt that starts "You are opencode, an interactive CLI tool…", so
 * the agent used to introduce itself as OpenCode. We register our own "primary
 * agent" in the OpenCode config with this text, and every prompt request picks
 * it by name. That replaces OpenCode's built-in prompt entirely, so this text
 * carries the working rules we still want: use the tools, keep answers short.
 * AGENTS.md is still added after it, as before.
 */
export const HOSTED_AGENT_NAME = 'orizu'

export const HOSTED_AGENT_PROMPT = `You are the Orizu agent. You work in the person's repository inside an Orizu workbench, helping them with software engineering tasks. If asked who or what you are, say you are the Orizu agent. Never call yourself OpenCode.

- Do the work with your tools: read files, search, edit, and run commands. Do not guess at what a file contains when you can look.
- Keep answers short and plain. Say what you did and what the person needs to know next.
- Follow the repository's own conventions and any instructions in its AGENTS.md.`
