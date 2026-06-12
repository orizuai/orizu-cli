export interface AgentSetupPromptOptions {
  workspacePath?: string | null
}

export function renderAgentSetupPrompt(options?: AgentSetupPromptOptions): string {
  const workspaceLine = options?.workspacePath
    ? `- Local Orizu artifacts belong under ${options.workspacePath} (gitignored). Keep secrets out of the repo; credentials live in ~/.config/orizu.`
    : '- If local Orizu artifacts are needed, suggest creating a gitignored .orizu/ workspace (orizu setup can do this).'

  return `Help me embed Orizu (eval-first LLM optimization) into this repository's workflow.

Start by learning the Orizu workflow:
1. Run \`orizu skills path --json\` and read the SKILL.md it points to, plus the references it links.
2. Run \`orizu --version\` and \`orizu whoami\` to confirm the CLI is installed and authenticated. If either fails, pause and tell me how to fix it (npm i -g orizu, orizu login) before continuing.

Then inspect this repository and propose how Orizu should fit it:
- Identify the LLM application surfaces worth evaluating (prompts, agents, pipelines) and where their inputs/outputs live.
- Propose Orizu team(s) and project(s) that match how this repo is organized.
- Propose datasets: existing data that can be uploaded now, or a concrete plan to collect examples if none exists.
- Propose which prompts to version in Orizu, and which scorers or LLM judges would capture quality for them.
- Propose runner artifacts where local execution is needed.
${workspaceLine}

Important boundaries:
- Present your plan and get my approval before creating anything on the Orizu server or changing repo files.
- Never duplicate Orizu runtime behavior (scoring, optimization, auth) in repo code; always go through the orizu CLI.`
}
