import Common from 'ethereumjs-common'
import Web3 from 'web3'
import { BlockTransactionString } from 'web3-eth'
import { EventData, PastEventOptions } from 'web3-eth-contract'
import { PrefixedHexString, TransactionOptions } from 'ethereumjs-tx'
import {
  BlockNumber,
  HttpProvider,
  IpcProvider,
  provider,
  Transaction,
  TransactionReceipt,
  WebsocketProvider
} from 'web3-core'

import { DeployRequest, RelayRequest } from './EIP712/RelayRequest'
import relayVerifierAbi from './interfaces/IRelayVerifier.json'
import deployVerifierAbi from './interfaces/IDeployVerifier.json'

import relayHubAbi from './interfaces/IRelayHub.json'
import forwarderAbi from './interfaces/IForwarder.json'
import smartWalletFactoryAbi from './interfaces/IWalletFactory.json'
import tokenHandlerAbi from './interfaces/ITokenHandler.json'

import { event2topic } from './Utils'
import { constants } from './Constants'
import replaceErrors from './ErrorReplacerJSON'
import VersionsManager from './VersionsManager'
import {
  IForwarderInstance,
  IRelayVerifierInstance,
  IRelayHubInstance,
  IDeployVerifierInstance,
  IWalletFactoryInstance,
  ITokenHandlerInstance
} from '../../types/truffle-contracts'

import { Address, IntString } from '../relayclient/types/Aliases'
import { EnvelopingConfig } from '../relayclient/Configurator'
import EnvelopingTransactionDetails from '../relayclient/types/EnvelopingTransactionDetails'
import { toBN, toHex } from 'web3-utils'
import BN from 'bn.js'
import { DeployTransactionRequest, RelayTransactionRequest } from '../relayclient/types/RelayTransactionRequest'

// Truffle Contract typings seem to be completely out of their minds
import TruffleContract = require('@truffle/contract')
import Contract = Truffle.Contract

require('source-map-support').install({ errorFormatterForce: true })

type EventName = string

export interface EstimateGasParams {
  from: Address
  to: Address
  data: PrefixedHexString
  gasPrice?: PrefixedHexString
}

export const RelayServerRegistered: EventName = 'RelayServerRegistered'
export const RelayWorkersAdded: EventName = 'RelayWorkersAdded'
export const TransactionRelayed: EventName = 'TransactionRelayed'
export const TransactionRejectedByRecipient: EventName = 'TransactionRelayedButRevertedByRecipient'

const ActiveManagerEvents = [RelayServerRegistered, RelayWorkersAdded, TransactionRelayed, TransactionRejectedByRecipient]

export const StakeAdded: EventName = 'StakeAdded'
export const StakeUnlocked: EventName = 'StakeUnlocked'
export const StakeWithdrawn: EventName = 'StakeWithdrawn'
export const StakePenalized: EventName = 'StakePenalized'

export type Web3Provider =
  | HttpProvider
  | IpcProvider
  | WebsocketProvider

export default class ContractInteractor {
  private readonly VERSION = '2.0.1'

  private readonly IRelayVerifierContract: Contract<IRelayVerifierInstance>
  private readonly IDeployVerifierContract: Contract<IDeployVerifierInstance>
  private readonly ITokenHandlerContract: Contract<ITokenHandlerInstance>

  private readonly IRelayHubContract: Contract<IRelayHubInstance>
  private readonly IForwarderContract: Contract<IForwarderInstance>
  private readonly IWalletFactoryContract: Contract<IWalletFactoryInstance>

  private relayVerifierInstance!: IRelayVerifierInstance
  private deployVerifierInstance!: IDeployVerifierInstance

  relayHubInstance!: IRelayHubInstance

  readonly web3: Web3
  private readonly provider: Web3Provider
  private readonly config: EnvelopingConfig
  private readonly versionManager: VersionsManager

  private rawTxOptions?: TransactionOptions
  chainId!: number
  private networkId?: number
  private networkType?: string

  constructor (provider: Web3Provider, config: EnvelopingConfig) {
    this.versionManager = new VersionsManager(this.VERSION)
    this.web3 = new Web3(provider)
    this.config = config
    this.provider = provider
    this.chainId = config.chainId
    // @ts-ignore
    this.IRelayVerifierContract = TruffleContract({
      contractName: 'IRelayVerifier',
      abi: relayVerifierAbi
    })
    // @ts-ignore
    this.IDeployVerifierContract = TruffleContract({
      contractName: 'IDeployVerifier',
      abi: deployVerifierAbi
    })
    // @ts-ignore
    this.IRelayHubContract = TruffleContract({
      contractName: 'IRelayHub',
      abi: relayHubAbi
    })
    // @ts-ignore
    this.IForwarderContract = TruffleContract({
      contractName: 'IForwarder',
      abi: forwarderAbi
    })
    // @ts-ignore
    this.IWalletFactoryContract = TruffleContract({
      contractName: 'IWalletFactory',
      abi: smartWalletFactoryAbi
    })
    // @ts-ignore
    this.ITokenHandlerContract = TruffleContract({
      contractName: 'ITokenHandler',
      abi: tokenHandlerAbi
    })
    this.IRelayHubContract.setProvider(this.provider, undefined)
    this.IRelayVerifierContract.setProvider(this.provider, undefined)
    this.IDeployVerifierContract.setProvider(this.provider, undefined)
    this.IForwarderContract.setProvider(this.provider, undefined)
    this.IWalletFactoryContract.setProvider(this.provider, undefined)
    this.ITokenHandlerContract.setProvider(this.provider, undefined)
  }

  getProvider (): provider { return this.provider }

  async init (): Promise<void> {
    if (this.isInitialized()) {
      throw new Error('_init was already called')
    }
    await this._initializeContracts()
    await this._validateCompatibility().catch(err => console.log('WARNING: beta ignore version compatibility', err.message))
    const chain = await this.web3.eth.net.getNetworkType()
    this.chainId = await this.getAsyncChainId()
    this.networkId = await this.web3.eth.net.getId()
    this.networkType = await this.web3.eth.net.getNetworkType()
    // chain === 'private' means we're on ganache, and ethereumjs-tx.Transaction doesn't support that chain type
    this.rawTxOptions = getRawTxOptions(this.chainId, this.networkId, chain)
  }

  isInitialized (): boolean {
    return this.rawTxOptions != null
  }

  async getAsyncChainId (): Promise<number> {
    return await this.web3.eth.getChainId()
  }

  async _validateCompatibility (): Promise<void> {
    if (this.config.relayHubAddress === constants.ZERO_ADDRESS) {
      return
    }
    const hub = this.relayHubInstance
    const version = await hub.versionHub()
    this._validateVersion(version)
  }

  _validateVersion (version: string): void {
    const isNewer = this.versionManager.isMinorSameOrNewer(version)
    if (!isNewer) {
      throw new Error(`Provided Hub version(${version}) is not supported by the current interactor(${this.versionManager.componentVersion})`)
    }
  }

  async _initializeContracts (): Promise<void> {
    if (this.config.relayHubAddress !== constants.ZERO_ADDRESS) {
      this.relayHubInstance = await this._createRelayHub(this.config.relayHubAddress)
    }
    if (this.config.relayVerifierAddress !== constants.ZERO_ADDRESS) {
      this.relayVerifierInstance = await this._createRelayVerifier(this.config.relayVerifierAddress)
    }
    if (this.config.deployVerifierAddress !== constants.ZERO_ADDRESS) {
      this.deployVerifierInstance = await this._createDeployVerifier(this.config.deployVerifierAddress)
    }

    console.log('Contracts initialized correctly')
  }

  // must use these options when creating Transaction object
  getRawTxOptions (): TransactionOptions {
    if (this.rawTxOptions == null) {
      throw new Error('_init not called')
    }
    return this.rawTxOptions
  }

  async _createRelayVerifier (address: Address): Promise<IRelayVerifierInstance> {
    return await this.IRelayVerifierContract.at(address)
  }

  async _createDeployVerifier (address: Address): Promise<IDeployVerifierInstance> {
    return await this.IDeployVerifierContract.at(address)
  }

  async createTokenHandler (address: Address): Promise<ITokenHandlerInstance> {
    return await this.ITokenHandlerContract.at(address)
  }

  async _createRelayHub (address: Address): Promise<IRelayHubInstance> {
    return await this.IRelayHubContract.at(address)
  }

  async _createForwarder (address: Address): Promise<IForwarderInstance> {
    return await this.IForwarderContract.at(address)
  }

  async _createFactory (address: Address): Promise<IWalletFactoryInstance> {
    return await this.IWalletFactoryContract.at(address)
  }

  async getSenderNonce (sWallet: Address): Promise<IntString> {
    const forwarder = await this._createForwarder(sWallet)
    const nonce = await forwarder.nonce()
    return nonce.toString()
  }

  async getFactoryNonce (factoryAddr: Address, from: Address): Promise<IntString> {
    const factory = await this._createFactory(factoryAddr)
    const nonce = await factory.nonce(from)
    return nonce.toString()
  }

  async _getBlockGasLimit (): Promise<number> {
    const latestBlock = await this.web3.eth.getBlock('latest')
    return latestBlock.gasLimit
  }

  async validateAcceptRelayCall (
    relayRequest: RelayRequest,
    signature: PrefixedHexString): Promise<{ verifierAccepted: boolean, returnValue: string, reverted: boolean, revertedInDestination: boolean }> {
    const relayHub = this.relayHubInstance
    const externalGasLimit: number = await this.getMaxViewableRelayGasLimit(relayRequest, signature)
    if (externalGasLimit === 0) {
      // The relayWorker does not have enough balance for this transaction
      return {
        verifierAccepted: false,
        reverted: false,
        returnValue: `relayWorker ${relayRequest.relayData.relayWorker} does not have enough balance to cover the maximum possible gas for this transaction`,
        revertedInDestination: false
      }
    }

    // First call the verifier
    try {
      await this.relayVerifierInstance.contract.methods.verifyRelayedCall(relayRequest, signature).call({
        from: relayRequest.relayData.relayWorker
      }, 'pending')
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e, replaceErrors)
      return {
        verifierAccepted: false,
        reverted: false,
        returnValue: `view call to 'relayCall' reverted in verifier: ${message}`,
        revertedInDestination: false
      }
    }

    // If the verified passed, try relaying the transaction (in local view call)
    try {
      const res = await relayHub.contract.methods.relayCall(
        relayRequest,
        signature
      )
        .call({
          from: relayRequest.relayData.relayWorker,
          gasPrice: relayRequest.relayData.gasPrice,
          gas: toHex(externalGasLimit)
        })

      // res is destinationCallSuccess
      return {
        verifierAccepted: true,
        reverted: false,
        returnValue: '',
        revertedInDestination: !(res as boolean)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e, replaceErrors)
      return {
        verifierAccepted: true,
        reverted: true,
        returnValue: `view call to 'relayCall' reverted in client: ${message}`,
        revertedInDestination: false
      }
    }
  }

  async validateAcceptDeployCall (
    request: DeployTransactionRequest): Promise<{ verifierAccepted: boolean, returnValue: string, reverted: boolean }> {
    const relayHub = this.relayHubInstance
    const externalGasLimit = await this.getMaxViewableDeployGasLimit(request)

    if (externalGasLimit.eq(toBN(0))) {
      // The relayWorker does not have enough balance for this transaction
      return {
        verifierAccepted: false,
        reverted: false,
        returnValue: `relayWorker ${request.relayRequest.relayData.relayWorker} does not have enough balance to cover the maximum possible gas for this transaction`
      }
    }

    // First call the verifier
    try {
      await this.deployVerifierInstance.contract.methods.verifyRelayedCall(request.relayRequest, request.metadata.signature).call({
        from: request.relayRequest.relayData.relayWorker
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e, replaceErrors)
      return {
        verifierAccepted: false,
        reverted: false,
        returnValue: `view call to 'deploy call' reverted in verifier: ${message}`
      }
    }

    // If the verified passed, try relaying the transaction (in local view call)
    try {
      const res = await relayHub.contract.methods.deployCall(
        request.relayRequest,
        request.metadata.signature
      )
        .call({
          from: request.relayRequest.relayData.relayWorker,
          gasPrice: request.relayRequest.relayData.gasPrice,
          gas: externalGasLimit
        })

      return {
        verifierAccepted: true,
        reverted: false,
        returnValue: res.returnValue
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e, replaceErrors)
      return {
        verifierAccepted: true,
        reverted: true,
        returnValue: `view call to 'deployCall' reverted in client: ${message}`
      }
    }
  }

  async getMaxViewableDeployGasLimit (request: DeployTransactionRequest): Promise<BN> {
    const gasPrice = toBN(request.relayRequest.relayData.gasPrice)
    let gasLimit = toBN(0)

    if (!gasPrice.eq(toBN(0))) {
      const maxEstimatedGas = toBN(await this.walletFactoryEstimateGasOfDeployCall(request))
      const workerBalanceAsUnitsOfGas = toBN(await this.getBalance(request.relayRequest.relayData.relayWorker)).div(gasPrice)

      if (workerBalanceAsUnitsOfGas.gte(maxEstimatedGas)) {
        gasLimit = maxEstimatedGas
      }
    }

    return gasLimit
  }

  async estimateRelayTransactionMaxPossibleGas (relayRequest: RelayRequest, signature: PrefixedHexString): Promise<number> {
    const maxPossibleGas = await this.estimateGas({
      from: relayRequest.relayData.relayWorker,
      to: relayRequest.request.relayHub,
      data: this.relayHubInstance.contract.methods.relayCall(relayRequest, signature).encodeABI(),
      gasPrice: relayRequest.relayData.gasPrice
    })

    // TODO RIF Team: Once the exactimator is available on the RSK node, then ESTIMATED_GAS_CORRECTION_FACTOR can be removed (in our tests it is 1.0 anyway, so it's not active)
    return Math.ceil(maxPossibleGas * constants.ESTIMATED_GAS_CORRECTION_FACTOR)
  }

  async estimateRelayTransactionMaxPossibleGasWithTransactionRequest (request: RelayTransactionRequest): Promise<number> {
    if (request.metadata.relayHubAddress === undefined || request.metadata.relayHubAddress === null || request.metadata.relayHubAddress === constants.ZERO_ADDRESS) {
      throw new Error('calculateDeployCallGas: RelayHub must be defined')
    }

    const rHub = await this._createRelayHub(request.metadata.relayHubAddress)
    const method = rHub.contract.methods.relayCall(request.relayRequest, request.metadata.signature)

    const maxPossibleGas = await method.estimateGas({
      from: request.relayRequest.relayData.relayWorker,
      gasPrice: request.relayRequest.relayData.gasPrice
    })

    // TODO RIF Team: Once the exactimator is available on the RSK node, then ESTIMATED_GAS_CORRECTION_FACTOR can be removed (in our tests it is 1.0 anyway, so it's not active)
    return Math.ceil(maxPossibleGas * constants.ESTIMATED_GAS_CORRECTION_FACTOR)
  }

  async estimateDestinationContractCallGas (transactionDetails: EstimateGasParams, addCushion: boolean = true): Promise<number> {
    // For relay calls, transactionDetails.gas is only the portion of gas sent to the destination contract, the tokenPayment
    // Part is done before, by the SmartWallet

    const estimated = await this.estimateGas({
      from: transactionDetails.from,
      to: transactionDetails.to,
      gasPrice: transactionDetails.gasPrice,
      data: transactionDetails.data
    })
    let internalCallCost = estimated > constants.INTERNAL_TRANSACTION_ESTIMATE_CORRECTION ? estimated - constants.INTERNAL_TRANSACTION_ESTIMATE_CORRECTION : estimated

    // The INTERNAL_TRANSACTION_ESTIMATE_CORRECTION is substracted because the estimation is done using web3.eth.estimateGas which
    // estimates the call as if it where an external call, and in our case it will be called internally (it's not the same cost).
    // Because of this, the estimated maxPossibleGas in the server (which estimates the whole transaction) might not be enough to successfully pass
    // the following verification made in the SmartWallet:
    // require(gasleft() > req.gas, "Not enough gas left"). This is done right before calling the destination internally

    if (addCushion) {
      internalCallCost = internalCallCost * constants.ESTIMATED_GAS_CORRECTION_FACTOR
    }

    return internalCallCost
  }

  async getMaxViewableRelayGasLimit (relayRequest: RelayRequest, signature: PrefixedHexString): Promise<number> {
    const gasPrice = toBN(relayRequest.relayData.gasPrice)
    let gasLimit = 0

    if (gasPrice.gt(toBN(0))) {
      const maxEstimatedGas: number = await this.estimateRelayTransactionMaxPossibleGas(relayRequest, signature)
      const workerBalanceAsUnitsOfGas = toBN(await this.getBalance(relayRequest.relayData.relayWorker)).div(gasPrice)

      if (workerBalanceAsUnitsOfGas.gte(toBN(maxEstimatedGas))) {
        gasLimit = maxEstimatedGas
      }
    }

    return gasLimit
  }

  encodeRelayCallABI (relayRequest: RelayRequest, sig: PrefixedHexString): PrefixedHexString {
    // TODO: check this works as expected
    // @ts-ignore
    const relayHub = new this.IRelayHubContract('')
    return relayHub.contract.methods.relayCall(relayRequest, sig).encodeABI()
  }

  encodeDeployCallABI (relayRequest: DeployRequest, sig: PrefixedHexString): PrefixedHexString {
    // TODO: check this works as expected
    // @ts-ignore
    const relayHub = new this.IRelayHubContract('')
    return relayHub.contract.methods.deployCall(relayRequest, sig).encodeABI()
  }

  async getPastEventsForHub (extraTopics: string[], options: PastEventOptions, names: EventName[] = ActiveManagerEvents): Promise<EventData[]> {
    return await this._getPastEvents(this.relayHubInstance.contract, names, extraTopics, options)
  }

  async getPastEventsForStakeManagement (names: EventName[], extraTopics: string[], options: PastEventOptions): Promise<EventData[]> {
    const relayHub = this.relayHubInstance
    return await this._getPastEvents(relayHub.contract, names, extraTopics, options)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _getPastEvents (contract: any, names: EventName[], extraTopics: string[], options: PastEventOptions): Promise<EventData[]> {
    const topics: string[][] = []
    const eventTopic = event2topic(contract, names)
    topics.push(eventTopic)
    if (extraTopics.length > 0) {
      topics.push(extraTopics)
    }
    return contract.getPastEvents('allEvents', Object.assign({}, options, { topics }))
  }

  async getBalance (address: Address, defaultBlock: BlockNumber = 'latest'): Promise<string> {
    return await this.web3.eth.getBalance(address, defaultBlock)
  }

  async getBlockNumber (): Promise<number> {
    return await this.web3.eth.getBlockNumber()
  }

  async sendSignedTransaction (rawTx: string): Promise<TransactionReceipt> {
    // noinspection ES6RedundantAwait - PromiEvent makes lint less happy about this line
    return await this.web3.eth.sendSignedTransaction(rawTx)
  }

  async estimateGas (transactionDetails: EnvelopingTransactionDetails): Promise<number> {
    return await this.web3.eth.estimateGas(transactionDetails)
  }

  // TODO: cache response for some time to optimize. It doesn't make sense to optimize these requests in calling code.
  async getGasPrice (): Promise<string> {
    return await this.web3.eth.getGasPrice()
  }

  async getTransactionCount (address: string, defaultBlock?: BlockNumber): Promise<number> {
    // @ts-ignore (web3 does not define 'defaultBlock' as optional)
    return await this.web3.eth.getTransactionCount(address, defaultBlock)
  }

  async getTransaction (transactionHash: string): Promise<Transaction> {
    return await this.web3.eth.getTransaction(transactionHash)
  }

  async getBlock (blockHashOrBlockNumber: BlockNumber): Promise<BlockTransactionString> {
    return await this.web3.eth.getBlock(blockHashOrBlockNumber)
  }

  validateAddress (address: string, exceptionTitle = 'invalid address:'): void {
    if (!this.web3.utils.isAddress(address)) { throw new Error(exceptionTitle + ' ' + address) }
  }

  async getCode (address: string): Promise<string> {
    return await this.web3.eth.getCode(address)
  }

  getChainId (): number {
    if (this.chainId == null) {
      throw new Error('_init not called')
    }
    return this.chainId
  }

  getNetworkId (): number {
    if (this.networkId == null) {
      throw new Error('_init not called')
    }
    return this.networkId
  }

  getNetworkType (): string {
    if (this.networkType == null) {
      throw new Error('_init not called')
    }
    return this.networkType
  }

  async isContractDeployed (address: Address): Promise<boolean> {
    const code = await this.web3.eth.getCode(address)
    // Check added for RSKJ: when the contract does not exist in RSKJ it replies to the getCode call with 0x00
    return code !== '0x' && code !== '0x00'
  }

  async getStakeInfo (managerAddress: Address): Promise<{
    stake: string
    unstakeDelay: string
    withdrawBlock: string
    owner: string
  }> {
    return await this.relayHubInstance.getStakeInfo(managerAddress)
  }

  async walletFactoryDeployEstimateGasForInternalCall (request: DeployRequest, factory: Address, domainHash: string,
    suffixData: string, signature: string, testCall: boolean = false): Promise<number> {
    const pFactory = await this._createFactory(factory)

    const method = pFactory.contract.methods.relayedUserSmartWalletCreation(request.request, domainHash,
      suffixData, signature)

    if (testCall) {
      await method.call({ from: request.request.relayHub })
    }

    return method.estimateGas({
      from: request.request.relayHub,
      gasPrice: request.relayData.gasPrice
    })
  }

  async walletFactoryEstimateGasOfDeployCall (request: DeployTransactionRequest): Promise<number> {
    if (request.metadata.relayHubAddress === undefined || request.metadata.relayHubAddress === null || request.metadata.relayHubAddress === constants.ZERO_ADDRESS) {
      throw new Error('calculateDeployCallGas: RelayHub must be defined')
    }
    const rHub = await this._createRelayHub(request.metadata.relayHubAddress)
    const method = rHub.contract.methods.deployCall(request.relayRequest, request.metadata.signature)

    return method.estimateGas({
      from: request.relayRequest.relayData.relayWorker,
      gasPrice: request.relayRequest.relayData.gasPrice
    })
  }

  // TODO: a way to make a relay hub transaction with a specified nonce without exposing the 'method' abstraction
  async getRegisterRelayMethod (url: string): Promise<any> {
    const hub = this.relayHubInstance
    return hub.contract.methods.registerRelayServer(url)
  }

  async getAddRelayWorkersMethod (workers: Address[]): Promise<any> {
    const hub = this.relayHubInstance
    return hub.contract.methods.addRelayWorkers(workers)
  }

  /**
   * Web3.js as of 1.2.6 (see web3-core-method::_confirmTransaction) does not allow
   * broadcasting of a transaction without waiting for it to be mined.
   * This method sends the RPC call directly
   * @param signedTransaction - the raw signed transaction to broadcast
   */
  async broadcastTransaction (signedTransaction: PrefixedHexString): Promise<PrefixedHexString> {
    return await new Promise((resolve, reject) => {
      if (this.provider == null) {
        throw new Error('provider is not set')
      }
      this.provider.send({
        jsonrpc: '2.0',
        method: 'eth_sendRawTransaction',
        params: [
          signedTransaction
        ],
        id: Date.now()
      }, (e: Error | null, r: any) => {
        if (e != null) {
          reject(e)
        } else if (r.error != null) {
          reject(r.error)
        } else {
          resolve(r.result)
        }
      })
    })
  }
}

/**
 * Ganache does not seem to enforce EIP-155 signature. Buidler does, though.
 * This is how {@link Transaction} constructor allows support for custom and private network.
 * @param chainId
 * @param networkId
 * @param chain
 * @return {{common: Common}}
 */
export function getRawTxOptions (chainId: number, networkId: number, chain?: string): TransactionOptions {
  if (chain == null || chain === 'main' || chain === 'private') {
    chain = 'mainnet'
  }
  return {
    common: Common.forCustomChain(
      chain,
      {
        chainId,
        networkId
      }, 'istanbul')
  }
}
