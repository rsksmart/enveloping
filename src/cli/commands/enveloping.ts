#!/usr/bin/env node

import commander from 'commander'
import { version } from '../../../package.json'

commander
  .version(version)
  .command('boot-test', 'all-on-one: deploy all contracts, start relay. Warning: This should be used only for testing')
  .command('deploy', 'deploy RelayHub and other Enveloping contracts instances')
  .command('relayer-register', 'stake for a relayer and fund it')
  .command('relayer-run', 'launch a relayer server')
  .command('status', 'status of the Enveloping network')
  .command('registry', 'VersionRegistry management')
  .parse(process.argv)
