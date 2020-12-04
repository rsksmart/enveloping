import Web3 from 'web3'
import { Contract, SendOptions } from 'web3-eth-contract'
import HDWalletProvider from '@truffle/hdwallet-provider'
import BN from 'bn.js'
import { HttpProvider, TransactionReceipt } from 'web3-core'
import { merge } from 'lodash'
// @ts-ignore
import io from 'console-read-write'

import { ether, sleep } from '../common/Utils'

// compiled folder populated by "prepublish"
import StakeManager from './compiled/StakeManager.json'
import RelayHub from './compiled/RelayHub.json'
import Penalizer from './compiled/Penalizer.json'
import Paymaster from './compiled/TestPaymasterEverythingAccepted.json'
import SmartWallet from './compiled/SmartWallet.json'
import ProxyFactory from './compiled/ProxyFactory.json'
import VersionRegistryAbi from './compiled/VersionRegistry.json'
import { Address, notNull } from '../relayclient/types/Aliases'
import ContractInteractor from '../relayclient/ContractInteractor'
import { GSNConfig } from '../relayclient/GSNConfigurator'
import HttpClient from '../relayclient/HttpClient'
import HttpWrapper from '../relayclient/HttpWrapper'
import { constants } from '../common/Constants'
import { RelayHubConfiguration } from '../relayclient/types/RelayHubConfiguration'
import { string32 } from '../common/VersionRegistry'

interface RegisterOptions {
  from: Address
  stake: string | BN
  funds: string | BN
  relayUrl: string
  unstakeDelay: string
}

interface DeployOptions {
  from: Address
  gasPrice: string
  deployPaymaster?: boolean
  factoryAddress?: string
  sWalletTemplateAddress?: string
  relayHubAddress?: string
  stakeManagerAddress?: string
  penalizerAddress?: string
  registryAddress?: string
  registryHubId?: string
  verbose?: boolean
  skipConfirmation?: boolean
  relayHubConfiguration: RelayHubConfiguration
}

export interface DeploymentResult {
  relayHubAddress: Address
  stakeManagerAddress: Address
  penalizerAddress: Address
  sWalletTemplateAddress: Address
  factoryAddress: Address
  versionRegistryAddress: Address
  naivePaymasterAddress: Address
}

interface RegistrationResult {
  success: boolean
  transactions?: string[]
  error?: string
}

export default class CommandsLogic {
  private readonly contractInteractor: ContractInteractor
  private readonly httpClient: HttpClient
  private readonly config: GSNConfig
  private readonly web3: Web3

  constructor (host: string, config: GSNConfig, mnemonic?: string) {
    let provider: HttpProvider | HDWalletProvider = new Web3.providers.HttpProvider(host)
    if (mnemonic != null) {
      // web3 defines provider type quite narrowly
      provider = new HDWalletProvider(mnemonic, provider) as unknown as HttpProvider
    }
    this.contractInteractor = new ContractInteractor(provider, config)
    this.httpClient = new HttpClient(new HttpWrapper(), config)
    this.config = config
    this.web3 = new Web3(provider)
  }

  async findWealthyAccount (requiredBalance = ether('0.01')): Promise<string> {
    let accounts: string[] = []
    try {
      accounts = await this.web3.eth.getAccounts()
      for (const account of accounts) {
        const balance = new BN(await this.web3.eth.getBalance(account))
        if (balance.gte(requiredBalance)) {
          console.log(`Found funded account ${account}`)
          return account
        }
      }
    } catch (error) {
      console.error('Failed to retrieve accounts and balances:', error)
    }
    throw new Error(`could not find unlocked account with sufficient balance; all accounts:\n - ${accounts.join('\n - ')}`)
  }

  async isRelayReady (relayUrl: string): Promise<boolean> {
    const response = await this.httpClient.getPingResponse(relayUrl)
    return response.ready
  }

  async waitForRelay (relayUrl: string, timeout = 60): Promise<void> {
    console.error(`Will wait up to ${timeout}s for the relay to be ready`)

    const endTime = Date.now() + timeout * 1000
    while (Date.now() < endTime) {
      let isReady = false
      try {
        isReady = await this.isRelayReady(relayUrl)
      } catch (e) {
        console.log(e.message)
      }
      if (isReady) {
        return
      }
      await sleep(3000)
    }
    throw Error(`Relay not ready after ${timeout}s`)
  }

  async getPaymasterBalance (paymaster: Address): Promise<BN> {
    const relayHub = await this.contractInteractor._createRelayHub(this.config.relayHubAddress)
    return await relayHub.balanceOf(paymaster)
  }

  /**
   * Send enough ether from the {@param from} to the RelayHub to make {@param paymaster}'s gas deposit exactly {@param amount}.
   * Does nothing if current paymaster balance exceeds amount.
   * @param from
   * @param paymaster
   * @param amount
   * @return deposit of the paymaster after
   */
  async fundPaymaster (
    from: Address, paymaster: Address, amount: string | BN
  ): Promise<BN> {
    const relayHub = await this.contractInteractor._createRelayHub(this.config.relayHubAddress)
    const targetAmount = new BN(amount)
    const currentBalance = await relayHub.balanceOf(paymaster)
    if (currentBalance.lt(targetAmount)) {
      const value = targetAmount.sub(currentBalance)
      await relayHub.depositFor(paymaster, {
        value,
        from
      })
      return targetAmount
    } else {
      return currentBalance
    }
  }

  async registerRelay (options: RegisterOptions): Promise<RegistrationResult> {
    try {
      if (await this.isRelayReady(options.relayUrl)) {
        return {
          success: false,
          error: 'Already registered'
        }
      }
    } catch (error) {
      return {
        success: false,
        error: `Could not reach the relay at ${options.relayUrl}, is it running?`
      }
    }

    let stakeTx: Truffle.TransactionResponse | undefined
    let authorizeTx: Truffle.TransactionResponse | undefined
    let fundTx: TransactionReceipt | undefined
    try {
      console.error(`Funding GSN relay at ${options.relayUrl}`)

      const response = await this.httpClient.getPingResponse(options.relayUrl)
      const relayAddress = response.relayManagerAddress
      const relayHubAddress = this.config.relayHubAddress ?? response.relayHubAddress

      const relayHub = await this.contractInteractor._createRelayHub(relayHubAddress)
      const stakeManagerAddress = await relayHub.stakeManager()
      const stakeManager = await this.contractInteractor._createStakeManager(stakeManagerAddress)
      stakeTx = await stakeManager
        .stakeForAddress(relayAddress, options.unstakeDelay.toString(), {
          value: options.stake,
          from: options.from,
          gas: 1e6,
          gasPrice: 1e9
        })
      authorizeTx = await stakeManager
        .authorizeHubByOwner(relayAddress, relayHubAddress, {
          from: options.from,
          gas: 1e6,
          gasPrice: 1e9
        })
      const _fundTx = await this.web3.eth.sendTransaction({
        from: options.from,
        to: relayAddress,
        value: options.funds,
        gas: 1e6,
        gasPrice: 1e9
      })

      fundTx = _fundTx as TransactionReceipt
      if (fundTx.transactionHash == null) {
        return {
          success: false,
          error: `Fund transaction reverted: ${JSON.stringify(_fundTx)}`
        }
      }
      await this.waitForRelay(options.relayUrl)
      return {
        success: true,
        transactions: [stakeTx.tx, authorizeTx.tx, fundTx.transactionHash]
      }
    } catch (error) {
      return {
        success: false,
        transactions: [stakeTx?.tx, authorizeTx?.tx, fundTx?.transactionHash].filter(notNull),
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        error: `Failed to fund relay: '${error}'`
      }
    }
  }

  contract (file: any, address?: string): Contract {
    return new this.web3.eth.Contract(file.abi, address, { data: file.bytecode })
  }

  async deployGsnContracts (deployOptions: DeployOptions): Promise<DeploymentResult> {
    const options: Required<SendOptions> = {
      from: deployOptions.from,
      gas: 0, // gas limit will be filled in at deployment
      value: 0,
      gasPrice: deployOptions.gasPrice ?? (1e9).toString()
    }

    const sInstance = await this.getContractInstance(StakeManager, {}, deployOptions.stakeManagerAddress, Object.assign({}, options), deployOptions.skipConfirmation)
    const pInstance = await this.getContractInstance(Penalizer, {}, deployOptions.penalizerAddress, Object.assign({}, options), deployOptions.skipConfirmation)
    const swtInstance = await this.getContractInstance(SmartWallet, {}, deployOptions.sWalletTemplateAddress, Object.assign({}, options), deployOptions.skipConfirmation)
    const pfInstance = await this.getContractInstance(ProxyFactory, {
      arguments: [
        swtInstance.options.address,
        '0xad7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5' // domain version hash (version=2)
      ]
    }, deployOptions.factoryAddress, Object.assign({}, options), deployOptions.skipConfirmation)

    const rInstance = await this.getContractInstance(RelayHub, {
      arguments: [
        sInstance.options.address,
        pInstance.options.address,
        deployOptions.relayHubConfiguration.maxWorkerCount,
        deployOptions.relayHubConfiguration.gasReserve,
        deployOptions.relayHubConfiguration.postOverhead,
        deployOptions.relayHubConfiguration.gasOverhead,
        deployOptions.relayHubConfiguration.maximumRecipientDeposit,
        deployOptions.relayHubConfiguration.minimumUnstakeDelay,
        deployOptions.relayHubConfiguration.minimumStake]
    }, deployOptions.relayHubAddress, merge({}, options, { gas: 5e6 }), deployOptions.skipConfirmation)

    const regInstance = await this.getContractInstance(VersionRegistryAbi, {}, deployOptions.registryAddress, Object.assign({}, options), deployOptions.skipConfirmation)
    if (deployOptions.registryHubId != null) {
      await regInstance.methods.addVersion(string32(deployOptions.registryHubId), string32('1'), rInstance.options.address).send({ from: deployOptions.from })
      console.log(`== Saved RelayHub address at HubId:"${deployOptions.registryHubId}" to VersionRegistry`)
    }

    let paymasterAddress = constants.ZERO_ADDRESS
    if (deployOptions.deployPaymaster === true) {
      const pmInstance = await this.deployPaymaster(Object.assign({}, options), rInstance.options.address, deployOptions.from, deployOptions.skipConfirmation)
      paymasterAddress = pmInstance.options.address

      // Overriding saved configuration with newly deployed instances
      this.config.paymasterAddress = paymasterAddress
    }
    this.config.relayHubAddress = rInstance.options.address

    return {
      relayHubAddress: rInstance.options.address,
      stakeManagerAddress: sInstance.options.address,
      penalizerAddress: pInstance.options.address,
      sWalletTemplateAddress: swtInstance.options.address,
      factoryAddress: pfInstance.options.address,
      versionRegistryAddress: regInstance.options.address,
      naivePaymasterAddress: paymasterAddress
    }
  }

  private async getContractInstance (json: any, constructorArgs: any, address: Address | undefined, options: Required<SendOptions>, skipConfirmation: boolean = false): Promise<Contract> {
    const contractName: string = json.contractName
    let contractInstance
    if (address == null) {
      const sendMethod = this
        .contract(json)
        .deploy(constructorArgs)
      options.gas = await sendMethod.estimateGas()
      const maxCost = new BN(options.gasPrice).muln(options.gas)
      const oneEther = ether('1')
      console.log(`Deploying ${contractName} contract with gas limit of ${options.gas.toLocaleString()} and maximum cost of ~ ${maxCost.toNumber() / parseFloat(oneEther.toString())} ETH`)
      if (!skipConfirmation) {
        await this.confirm()
      }
      const deployPromise = sendMethod.send(merge(options, { gas: 5e6 }))
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      deployPromise.on('transactionHash', function (hash) {
        console.log(`Transaction broadcast: ${hash}`)
      })
      contractInstance = await deployPromise
      console.log(`Deployed ${contractName} at address ${contractInstance.options.address}\n\n`)
    } else {
      console.log(`Using ${contractName} at given address ${address}\n\n`)
      contractInstance = this.contract(json, address)
    }
    return contractInstance
  }

  async deployPaymaster (options: Required<SendOptions>, hub: Address, from: string, skipConfirmation: boolean | undefined): Promise<Contract> {
    const pmInstance = await this.getContractInstance(Paymaster, {}, undefined, Object.assign({}, options), skipConfirmation)
    await pmInstance.methods.setRelayHub(hub).send(options)
    return pmInstance
  }

  async confirm (): Promise<void> {
    let input
    while (true) {
      console.log('Confirm (yes/no)?')
      input = await io.read()
      if (input === 'yes') {
        return
      } else if (input === 'no') {
        throw new Error('User rejected')
      }
    }
  }
}
