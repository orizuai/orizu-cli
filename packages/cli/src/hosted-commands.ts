import { runHostedGepaOptimization } from './hosted-gepa-cli.js'
import { hostedCommand } from './hosted-session-cli.js'
import type { GepaEngineDispatch } from './gepa-engine-dispatch.js'

export function applyHostedInstructionSetProfileOverride(
  dispatch: GepaEngineDispatch
): GepaEngineDispatch {
  const profileVersionId = process.env.ORIZU_HOSTED_INSTRUCTION_SET_PROFILE_VERSION_ID
  if (process.env.ORIZU_HOSTED_OPTIMIZATION_RUN_ID && profileVersionId) {
    dispatch.environment.ORIZU_INSTRUCTION_SET_PROFILE_VERSION_ID = profileVersionId
  }
  const proposerConfig = process.env.ORIZU_HOSTED_SKILLED_PROPOSER_CONFIG
  if (process.env.ORIZU_HOSTED_OPTIMIZATION_RUN_ID && proposerConfig) {
    dispatch.environment.ORIZU_SKILLED_PROPOSER_CONFIG = proposerConfig
  }
  return dispatch
}

interface HostedCommandContext { environment: NodeJS.ProcessEnv; getArg: (name: string) => string | null; json: boolean; printJson: (value: Record<string, unknown>) => void; printLine: (value?: string) => void; printErr: (value: string) => void; resolveProjectSlug: (projectArg: string | null) => Promise<string>; setExitCode: (code: number) => void }
export async function dispatchHostedCommands(args: string[], context: HostedCommandContext): Promise<boolean> { const [command, subcommand] = args; if (command === 'optimizations' && subcommand === 'run-gepa' && args.includes('--hosted')) { const project = context.getArg('--project') || await context.resolveProjectSlug(null); await runHostedGepaOptimization({ args: args.slice(2), project, environment: context.environment, json: context.json, printJson: context.printJson, printLine: context.printLine }); return true } if (command === 'internal' || (command === 'session' && subcommand === 'start' && args.includes('--hosted'))) { context.setExitCode(await hostedCommand(args, { json: context.json, print: context.printLine, printErr: context.printErr })); return true } return false }
