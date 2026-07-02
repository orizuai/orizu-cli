export interface AgentSetupPromptOptions {
  workspacePath?: string | null
}

export function renderAgentSetupPrompt(options?: AgentSetupPromptOptions): string {
  const workspaceLine = options?.workspacePath
    ? `- The Orizu workbench root is ${options.workspacePath}. Read AGENTS.md, Memory.md, project READMEs, and orizu.*.json manifests before changing anything.`
    : '- If this repo is not initialized yet, suggest running `orizu setup --team <slug>` from the desired directory to create the local Orizu workbench contract.'

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
- Use root AGENTS.md, CLAUDE.md, and Memory.md for team context. Discover project and primitive context through README files and orizu.<kind>.json manifests.
- Keep Git-tracked source/context separate from Orizu DB state, object-storage bytes, and local/ephemeral files. Treat .orizu/ as ignored cache/generated state.
${workspaceLine}

Important boundaries:
- Present your plan and get my approval before creating anything on the Orizu server or changing repo files.
- Never duplicate Orizu runtime behavior (scoring, optimization, auth) in repo code; always go through the orizu CLI.`
}
