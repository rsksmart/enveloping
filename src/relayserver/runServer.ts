// TODO: convert to 'commander' format
import fs from 'fs'
import Web3 from 'web3'
import { HttpServer } from './HttpServer'
import { RelayServer } from './RelayServer'
import { KeyManager } from './KeyManager'
import { TxStoreManager, TXSTORE_FILENAME } from './TxStoreManager'
import ContractInteractor from '../common/ContractInteractor'
import { configure } from '../relayclient/Configurator'
import { parseServerConfig, resolveServerConfig, ServerConfigParams, ServerDependencies } from './ServerConfigParams'

function error (err: string): never {
  console.error(err)
  process.exit(1)
}

async function run (): Promise<void> {
  let config: ServerConfigParams
  let web3provider
  let trustedVerifiers: string[] = []
  console.log('Starting Enveloping Relay Server process...\n')
  try {
    const conf = await parseServerConfig(process.argv.slice(2), process.env)
    console.log(conf)
    if (conf.rskNodeUrl == null) {
      error('missing rskNodeUrl')
    }
    if (conf.trustedVerifiers !== undefined && conf.trustedVerifiers != null && conf.trustedVerifiers !== '') {
      trustedVerifiers = JSON.parse(conf.trustedVerifiers)
    }

    web3provider = new Web3.providers.HttpProvider(conf.rskNodeUrl)
    config = await resolveServerConfig(conf, web3provider) as ServerConfigParams
    if (trustedVerifiers.length > 0) {
      config.trustedVerifiers = trustedVerifiers
    }
  } catch (e) {
    error(e.message)
  }
  const { devMode, workdir } = config
  if (devMode) {
    if (fs.existsSync(`${workdir}/${TXSTORE_FILENAME}`)) {
      fs.unlinkSync(`${workdir}/${TXSTORE_FILENAME}`)
    }
  }

  const managerKeyManager = new KeyManager(1, workdir + '/manager')
  const workersKeyManager = new KeyManager(1, workdir + '/workers')
  const txStoreManager = new TxStoreManager({ workdir })
  const contractInteractor = new ContractInteractor(web3provider, configure({
    relayHubAddress: config.relayHubAddress,
    deployVerifierAddress: config.deployVerifierAddress,
    relayVerifierAddress: config.relayVerifierAddress
  }))
  await contractInteractor.init()

  const dependencies: ServerDependencies = {
    txStoreManager,
    managerKeyManager,
    workersKeyManager,
    contractInteractor
  }

  const relayServer = new RelayServer(config, dependencies)
  await relayServer.init()
  const httpServer = new HttpServer(config.port, relayServer)
  httpServer.start()
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
run()
