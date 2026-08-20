export interface GepaPythonCommand {
  python: string
  args: string[]
}

export function getGepaPythonCommand(args: string[], environment: NodeJS.ProcessEnv): GepaPythonCommand {
  let python = environment.PYTHON || 'python3'
  const forwarded: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--python') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--python requires a value that does not start with --')
      }
      python = value
      index += 1
      continue
    }
    if (argument.startsWith('--python=')) {
      const value = argument.slice('--python='.length)
      if (!value || value.startsWith('--')) {
        throw new Error('--python requires a value that does not start with --')
      }
      python = value
      continue
    }
    forwarded.push(argument)
  }
  return { python, args: forwarded }
}
