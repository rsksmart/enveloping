import log from 'loglevel'
import { EventData, PastEventOptions } from 'web3-eth-contract'
import { EventEmitter } from 'events'
import { PrefixedHexString } from 'ethereumjs-tx'
import { toBN, toHex } from 'web3-utils'

import { Address } from '../relayclient/types/Aliases'
import { AmountRequired } from '../common/AmountRequired'
import {
  address2topic,
  getLatestEventData,
  isRegistrationValid,
  isSecondEventLater,
  boolString
} from '../common/Utils'
import { defaultEnvironment } from '../common/Environments'
import ContractInteractor, {
  RelayWorkersAdded,
  StakeAdded,
  StakeUnlocked,
  StakeWithdrawn
} from '../common/ContractInteractor'

import { SendTransactionDetails, TransactionManager } from './TransactionManager'
import { ServerConfigParams } from './ServerConfigParams'
import { TxStoreManager } from './TxStoreManager'
import { ServerAction } from './StoredTransaction'
import chalk from 'chalk'
import { RelayData } from '../relayclient/types/RelayData'

export interface RelayServerRegistryInfo {
  url: string
}

const mintxgascost = defaultEnvironment.mintxgascost

export class RegistrationManager {
  balanceRequired: AmountRequired
  stakeRequired: AmountRequired
  _isStakeLocked = false

  isInitialized = false
  hubAddress: Address

  managerAddress: Address
  workerAddress: Address

  eventEmitter: EventEmitter

  contractInteractor: ContractInteractor
  ownerAddress?: Address
  transactionManager: TransactionManager
  config: ServerConfigParams
  txStoreManager: TxStoreManager
  relayData: RelayData | undefined
  lastWorkerAddedTransaction?: EventData
  private delayedEvents: Array<{ block: number, eventData: EventData }> = []

  get isStakeLocked (): boolean {
    return this._isStakeLocked
  }

  set isStakeLocked (newValue: boolean) {
    const oldValue = this._isStakeLocked
    this._isStakeLocked = newValue
    if (newValue !== oldValue) {
      log.info(`Manager stake is ${newValue ? 'now' : 'no longer'} locked`)
      this.printNotRegisteredMessage()
    }
  }

  constructor (
    contractInteractor: ContractInteractor,
    transactionManager: TransactionManager,
    txStoreManager: TxStoreManager,
    eventEmitter: EventEmitter,
    config: ServerConfigParams,
    // exposed from key manager?
    managerAddress: Address,
    workerAddress: Address
  ) {
    const listener = (): void => {
      this.printNotRegisteredMessage()
    }
    this.balanceRequired = new AmountRequired('Balance', toBN(config.managerMinBalance), listener)
    this.stakeRequired = new AmountRequired('Stake', toBN(config.managerMinStake), listener)

    this.contractInteractor = contractInteractor
    this.hubAddress = config.relayHubAddress
    this.managerAddress = managerAddress
    this.workerAddress = workerAddress
    this.eventEmitter = eventEmitter
    this.transactionManager = transactionManager
    this.txStoreManager = txStoreManager
    this.config = config
  }

  async init (): Promise<void> {
    if (this.lastWorkerAddedTransaction == null) {
      this.lastWorkerAddedTransaction = await this._queryLatestWorkerAddedEvent()
    }

    this.isInitialized = true
  }

  async handlePastEvents (hubEventsSinceLastScan: EventData[], lastScannedBlock: number, currentBlock: number, forceRegistration: boolean): Promise<PrefixedHexString[]> {
    if (!this.isInitialized) {
      throw new Error('RegistrationManager not initialized')
    }
    const topics = [address2topic(this.managerAddress)]
    const options: PastEventOptions = {
      fromBlock: lastScannedBlock + 1,
      toBlock: 'latest'
    }
    const eventNames = [StakeAdded, StakeUnlocked, StakeWithdrawn]
    const decodedEvents = await this.contractInteractor.getPastEventsForStakeManagement(eventNames, topics, options)
    this.printEvents(decodedEvents, options)
    let transactionHashes: PrefixedHexString[] = []
    // TODO: what about 'penalize' events? should send balance to owner, I assume
    for (const eventData of decodedEvents) {
      switch (eventData.event) {
        case StakeAdded:
          await this.refreshStake()
          break
        case StakeUnlocked:
          await this.refreshStake()
          this.delayedEvents.push({ block: eventData.returnValues.withdrawBlock.toString(), eventData })
          break
        case StakeWithdrawn:
          await this.refreshStake()
          transactionHashes = transactionHashes.concat(await this._handleStakeWithdrawnEvent(eventData, currentBlock))
          break
      }
    }

    this.relayData = await this.getRelayData()

    for (const eventData of hubEventsSinceLastScan) {
      switch (eventData.event) {
        case RelayWorkersAdded:
          if (this.lastWorkerAddedTransaction == null || isSecondEventLater(this.lastWorkerAddedTransaction, eventData)) {
            this.lastWorkerAddedTransaction = eventData
          }
          break
      }
    }

    // handle HubUnauthorized only after the due time
    for (const eventData of this._extractDuePendingEvents(currentBlock)) {
      switch (eventData.event) {
        case StakeUnlocked:
          transactionHashes = transactionHashes.concat(await this._handleStakeUnlockedEvent(eventData, currentBlock))
          break
      }
    }

    const isRegistrationCorrect = await this._isRegistrationCorrect()
    const isRegistrationPending = await this.txStoreManager.isActionPending(ServerAction.REGISTER_SERVER)
    if (!(isRegistrationPending || isRegistrationCorrect) || forceRegistration) {
      transactionHashes = transactionHashes.concat(await this.attemptRegistration(currentBlock))
    }
    return transactionHashes
  }

  async getRelayData (): Promise<RelayData> {
    const relayData: RelayData[] = await this.contractInteractor.getRelayData([this.managerAddress])
    if (relayData.length > 0) {
      return relayData[0]
    }
    throw new Error('No relay found for manager ' + this.managerAddress)
  }

  _extractDuePendingEvents (currentBlock: number): EventData[] {
    const ret = this.delayedEvents.filter(event => event.block <= currentBlock).map(e => e.eventData)
    this.delayedEvents = [...this.delayedEvents.filter(event => event.block > currentBlock)]
    return ret
  }

  _isRegistrationCorrect (): boolean {
    return isRegistrationValid(this.relayData, this.config, this.managerAddress)
  }

  _parseEvent (event: { events: any[], name: string, address: string } | null): any {
    if (event?.events === undefined) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      return `not event: ${event?.toString()}`
    }
    const args: Record<string, any> = {}
    // event arguments is for some weird reason give as ".events"
    for (const eventArgument of event.events) {
      args[eventArgument.name] = eventArgument.value
    }
    return {
      name: event.name,
      address: event.address,
      args: args
    }
  }

  async _handleStakeWithdrawnEvent (dlog: EventData, currentBlock: number): Promise<PrefixedHexString[]> {
    log.warn('Handling StakeWithdrawn event:', dlog)
    return await this.withdrawAllFunds(true, currentBlock)
  }

  async _handleStakeUnlockedEvent (dlog: EventData, currentBlock: number): Promise<PrefixedHexString[]> {
    log.warn('Handling StakeUnlocked event:', dlog)
    return await this.withdrawAllFunds(false, currentBlock)
  }

  /**
   * @param withdrawManager - whether to send the relay manager's balance to the owner.
   *        Note that more than one relay process could be using the same manager account.
   * @param currentBlock
   */
  async withdrawAllFunds (withdrawManager: boolean, currentBlock: number): Promise<PrefixedHexString[]> {
    let transactionHashes: PrefixedHexString[] = []
    transactionHashes = transactionHashes.concat(await this._sendWorkersEthBalancesToOwner(currentBlock))
    if (withdrawManager) {
      transactionHashes = transactionHashes.concat(await this._sendManagerEthBalanceToOwner(currentBlock))
    }

    this.eventEmitter.emit('unstaked')
    return transactionHashes
  }

  async refreshBalance (): Promise<void> {
    const currentBalance = await this.contractInteractor.getBalance(this.managerAddress)
    this.balanceRequired.currentValue = toBN(currentBalance)
  }

  async refreshStake (): Promise<void> {
    const stakeInfo = await this.contractInteractor.getStakeInfo(this.managerAddress)
    const stake = toBN(stakeInfo.stake)
    if (stake.eq(toBN(0))) {
      return
    }

    // a locked stake does not have the 'withdrawBlock' field set
    this.isStakeLocked = stakeInfo.withdrawBlock === '0'
    this.stakeRequired.currentValue = stake

    // first time getting stake, setting owner
    if (this.ownerAddress == null) {
      this.ownerAddress = stakeInfo.owner
      log.info('Got staked for the first time')
      this.printNotRegisteredMessage()
    }
  }

  async addRelayWorker (currentBlock: number): Promise<PrefixedHexString> {
    // register on chain
    const addRelayWorkerMethod = await this.contractInteractor.getAddRelayWorkersMethod([this.workerAddress])
    const gasLimit = await this.transactionManager.attemptEstimateGas('AddRelayWorkers', addRelayWorkerMethod, this.managerAddress)
    const details: SendTransactionDetails = {
      signer: this.managerAddress,
      gasLimit,
      serverAction: ServerAction.ADD_WORKER,
      method: addRelayWorkerMethod,
      destination: this.hubAddress,
      creationBlockNumber: currentBlock
    }
    const { transactionHash } = await this.transactionManager.sendTransaction(details)
    return transactionHash
  }

  // TODO: extract worker registration sub-flow
  async attemptRegistration (currentBlock: number): Promise<PrefixedHexString[]> {
    const allPrerequisitesOk =
      this.isStakeLocked &&
      this.stakeRequired.isSatisfied &&
      this.balanceRequired.isSatisfied
    if (!allPrerequisitesOk) {
      log.info('Not all prerequisites for registration are met yet. Registration attempt cancelled')
      return []
    }

    let transactions: PrefixedHexString[] = []
    // add worker only if not already added
    const workersAdded = this._isWorkerValid()
    const addWorkersPending = await this.txStoreManager.isActionPending(ServerAction.ADD_WORKER)
    if (!(workersAdded || addWorkersPending)) {
      const txHash = await this.addRelayWorker(currentBlock)
      transactions = transactions.concat(txHash)
    }

    const portIncluded: boolean = this.config.url.indexOf(':') > 0
    const registerUrl = this.config.url + ((!portIncluded && this.config.port > 0) ? ':' + this.config.port.toString() : '')
    const registerMethod = await this.contractInteractor.getRegisterRelayMethod(registerUrl)
    const gasLimit = await this.transactionManager.attemptEstimateGas('RegisterRelay', registerMethod, this.managerAddress)
    const details: SendTransactionDetails = {
      serverAction: ServerAction.REGISTER_SERVER,
      gasLimit,
      signer: this.managerAddress,
      method: registerMethod,
      destination: this.hubAddress,
      creationBlockNumber: currentBlock
    }
    const { transactionHash } = await this.transactionManager.sendTransaction(details)
    transactions = transactions.concat(transactionHash)
    log.debug(`Relay ${this.managerAddress} registered on hub ${this.hubAddress}. `)
    return transactions
  }

  async _sendManagerEthBalanceToOwner (currentBlock: number): Promise<PrefixedHexString[]> {
    const gasPrice = await this.contractInteractor.getGasPrice()
    const transactionHashes: PrefixedHexString[] = []
    const gasLimit = mintxgascost
    const txCost = toBN(gasLimit).mul(toBN(gasPrice))

    const managerBalance = toBN(await this.contractInteractor.getBalance(this.managerAddress))
    // sending manager RBTC balance to owner
    if (managerBalance.gte(txCost)) {
      log.info(`Sending manager RBTC balance ${managerBalance.toString()} to owner`)
      const details: SendTransactionDetails = {
        signer: this.managerAddress,
        serverAction: ServerAction.VALUE_TRANSFER,
        destination: this.ownerAddress as string,
        gasLimit,
        gasPrice,
        value: toHex(managerBalance.sub(txCost)),
        creationBlockNumber: currentBlock
      }
      const { transactionHash } = await this.transactionManager.sendTransaction(details)
      transactionHashes.push(transactionHash)
    } else {
      log.error(`manager balance too low: ${managerBalance.toString()}, tx cost: ${gasLimit * parseInt(gasPrice)}`)
    }
    return transactionHashes
  }

  async _sendWorkersEthBalancesToOwner (currentBlock: number): Promise<PrefixedHexString[]> {
    // sending workers' balance to owner (currently one worker, todo: extend to multiple)
    const transactionHashes: PrefixedHexString[] = []
    const gasPrice = await this.contractInteractor.getGasPrice()
    const gasLimit = mintxgascost
    const txCost = toBN(gasLimit * parseInt(gasPrice))
    const workerBalance = toBN(await this.contractInteractor.getBalance(this.workerAddress))
    if (workerBalance.gte(txCost)) {
      log.info(`Sending workers' RBTC balance ${workerBalance.toString()} to owner`)
      const details = {
        signer: this.workerAddress,
        serverAction: ServerAction.VALUE_TRANSFER,
        destination: this.ownerAddress as string,
        gasLimit,
        gasPrice,
        value: toHex(workerBalance.sub(txCost)),
        creationBlockNumber: currentBlock
      }
      const { transactionHash } = await this.transactionManager.sendTransaction(details)
      transactionHashes.push(transactionHash)
    } else {
      log.info(`balance too low: ${workerBalance.toString()}, tx cost: ${gasLimit * parseInt(gasPrice)}`)
    }
    return transactionHashes
  }

  async _queryLatestWorkerAddedEvent (): Promise<EventData | undefined> {
    const workersAddedEvents = await this.contractInteractor.getPastEventsForHub([address2topic(this.managerAddress)],
      {
        fromBlock: 1
      },
      [RelayWorkersAdded])
    return getLatestEventData(workersAddedEvents)
  }

  _isWorkerValid (): boolean {
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
    return this.lastWorkerAddedTransaction != null && this.lastWorkerAddedTransaction.returnValues.newRelayWorkers
      .map((a: string) => a.toLowerCase()).includes(this.workerAddress.toLowerCase())
  }

  async isRegistered (): Promise<boolean> {
    const isRegistrationCorrect = this._isRegistrationCorrect()
    return this.stakeRequired.isSatisfied &&
      this.isStakeLocked &&
      isRegistrationCorrect
  }

  printNotRegisteredMessage (): void {
    if (this._isRegistrationCorrect()) {
      return
    }
    const message = `\nNot registered yet. Prerequisites:
${this.balanceRequired.description}
${this.stakeRequired.description}
Stake locked   | ${boolString(this.isStakeLocked)}
Manager        | ${this.managerAddress}
Worker         | ${this.workerAddress}
Owner          | ${this.ownerAddress ?? chalk.red('unknown')}
`
    log.info(message)
  }

  printEvents (decodedEvents: EventData[], options: PastEventOptions): void {
    if (decodedEvents.length === 0) {
      return
    }
    log.info(`Handling ${decodedEvents.length} events emitted since block: ${options.fromBlock?.toString()}`)
    for (const decodedEvent of decodedEvents) {
      log.info(`
Name      | ${decodedEvent.event.padEnd(25)}
Block     | ${decodedEvent.blockNumber}
TxHash    | ${decodedEvent.transactionHash}
`)
    }
  }
}
