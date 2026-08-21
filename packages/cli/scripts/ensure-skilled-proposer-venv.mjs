#!/usr/bin/env node

import { runManagerCli } from '../src/skilled-proposer-venv-manager.mjs'

process.exitCode = await runManagerCli(process.argv.slice(2))
