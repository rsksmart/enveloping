import {
  SmartWalletInstance,
  TestTokenInstance,
  ProxyFactoryInstance
} from '../types/truffle-contracts'
  // @ts-ignore
import { EIP712TypedData, signTypedData_v4, TypedDataUtils } from 'eth-sig-util'
import { bufferToHex, privateToAddress, toBuffer } from 'ethereumjs-util'
import { expectRevert, expectEvent } from '@openzeppelin/test-helpers'
import { toChecksumAddress, soliditySha3Raw } from 'web3-utils'
import { ethers } from 'ethers'
import chai from 'chai'
import { addr, bytes32, getTestingEnvironment, stripHex } from './TestUtils'
import { Environment } from '../src/common/Environments'
import { EIP712DomainType, ForwardRequestType } from '../src/common/EIP712/TypedRequestData'
import { constants } from '../src/common/Constants'

const keccak256 = web3.utils.keccak256

const SmartWallet = artifacts.require('SmartWallet')
const TestToken = artifacts.require('TestToken')
const ProxyFactory = artifacts.require('ProxyFactory')

contract('ProxyFactory', ([from]) => {
  let fwd: SmartWalletInstance
  let token: TestTokenInstance
  let factory: ProxyFactoryInstance

  const ownerPrivateKey = toBuffer(bytes32(1))
  const ownerAddress = toChecksumAddress(bufferToHex(privateToAddress(ownerPrivateKey)))

  const recipientPrivateKey = toBuffer(bytes32(1))
  const recipientAddress = toChecksumAddress(bufferToHex(privateToAddress(recipientPrivateKey)))
  const FORWARDER_PARAMS = 'address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data,address tokenRecipient,address tokenContract,uint256 tokenAmount,address factory,address recoverer,uint256 index'

  let env: Environment

  before(async () => {
    env = await getTestingEnvironment()
    fwd = await SmartWallet.new()
    await fwd.registerDomainSeparator('Test Domain', '1')
  })

  beforeEach(async () => {
    // A new factory for new create2 addresses each
    factory = await ProxyFactory.new(fwd.address)
    await factory.registerDomainSeparator('Test Domain', '1')
  })

  describe('#getCreationBytecode', () => {
    it('should return the expected bytecode', async () => {
      const expectedCode = '0x602D3D8160093D39F3363D3D373D3D3D3D363D73' +
            stripHex(fwd.address) + '5AF43D923D90803E602B57FD5BF3'

      const code = await factory.getCreationBytecode()
      chai.expect(web3.utils.toBN(expectedCode)).to.be.bignumber.equal(web3.utils.toBN(code))
    })
  })

  describe('#getRuntimeCodeHash', () => {
    it('should return the expected code hash', async () => {
      let expectedCode = '0x363D3D373D3D3D3D363D73' + stripHex(fwd.address) + '5AF43D923D90803E602B57FD5BF3'
      const expectedCodeHash = keccak256(expectedCode)

      const code = await factory.runtimeCodeHash()
      chai.expect(web3.utils.toBN(expectedCodeHash)).to.be.bignumber.equal(web3.utils.toBN(code))
    })
  })

  describe('#getSmartWalletAddress', () => {
    it('should create the correct create2 Address', async () => {
      const logicAddress = addr(0)
      const initParamsHash = constants.SHA3_NULL_S
      const recoverer = addr(0)
      const index = '0'
      const create2Address = await factory.getSmartWalletAddress(ownerAddress, recoverer, logicAddress, initParamsHash, index)
      const creationByteCode = await factory.getCreationBytecode()

      const salt: string = web3.utils.soliditySha3(
        { t: 'address', v: ownerAddress },
        { t: 'address', v: recoverer },
        { t: 'address', v: logicAddress },
        { t: 'bytes32', v: initParamsHash },
        { t: 'uint256', v: index }
      ) ?? ''

      const bytecodeHash: string = web3.utils.soliditySha3(
        { t: 'bytes', v: creationByteCode }
      ) ?? ''

      const _data: string = web3.utils.soliditySha3(
        { t: 'bytes1', v: '0xff' },
        { t: 'address', v: factory.address },
        { t: 'bytes32', v: salt },
        { t: 'bytes32', v: bytecodeHash }
      ) ?? ''

      const expectedAddress = toChecksumAddress('0x' + _data.slice(26, _data.length))
      assert.equal(create2Address, expectedAddress)
    })
  })

  describe('#createUserSmartWallet', () => {
    it('should create the Smart Wallet in the expected address', async () => {
      const logicAddress = addr(0)
      const initParams = '0x'
      const recoverer = addr(0)
      const index = '0'

      const toSign: string = web3.utils.soliditySha3(
        { t: 'bytes2', v: '0x1910' },
        { t: 'address', v: ownerAddress },
        { t: 'address', v: recoverer },
        { t: 'address', v: logicAddress },
        { t: 'uint256', v: index },
        { t: 'bytes', v: initParams }// Init params is empty
      ) ?? ''

      const toSignAsBinaryArray = ethers.utils.arrayify(toSign)
      const signingKey = new ethers.utils.SigningKey(ownerPrivateKey)
      const signature = signingKey.signDigest(toSignAsBinaryArray)
      const signatureCollapsed = ethers.utils.joinSignature(signature)

      const { logs } = await factory.createUserSmartWallet(ownerAddress, recoverer, logicAddress,
        index, initParams, signatureCollapsed)

      const expectedAddress = await factory.getSmartWalletAddress(ownerAddress, recoverer,
        logicAddress, soliditySha3Raw({ t: 'bytes', v: initParams }), index)

      const salt = web3.utils.soliditySha3(
        { t: 'address', v: ownerAddress },
        { t: 'address', v: recoverer },
        { t: 'address', v: logicAddress },
        { t: 'bytes32', v: soliditySha3Raw({ t: 'bytes', v: initParams }) },
        { t: 'uint256', v: index }
      ) ?? ''

      const expectedSalt = web3.utils.toBN(salt).toString()

      expectEvent.inLogs(logs, 'Deployed', {
        addr: expectedAddress,
        salt: expectedSalt
      })
    })

    it('should create the Smart Wallet with the expected proxy code', async () => {
      const logicAddress = addr(0)
      const initParams = '0x'
      const recoverer = addr(0)
      const index = '0'

      const expectedAddress = await factory.getSmartWalletAddress(ownerAddress, recoverer,
        logicAddress, soliditySha3Raw({ t: 'bytes', v: initParams }), index)

      const toSign: string = web3.utils.soliditySha3(
        { t: 'bytes2', v: '0x1910' },
        { t: 'address', v: ownerAddress },
        { t: 'address', v: recoverer },
        { t: 'address', v: logicAddress },
        { t: 'uint256', v: index },
        { t: 'bytes', v: initParams }
      ) ?? ''

      const toSignAsBinaryArray = ethers.utils.arrayify(toSign)
      const signingKey = new ethers.utils.SigningKey(ownerPrivateKey)
      const signature = signingKey.signDigest(toSignAsBinaryArray)
      const signatureCollapsed = ethers.utils.joinSignature(signature)

      // expectedCode = runtime code only
      let expectedCode = await factory.getCreationBytecode()
      expectedCode = '0x' + expectedCode.slice(20, expectedCode.length)

      const { logs } = await factory.createUserSmartWallet(ownerAddress, recoverer, logicAddress,
        index, initParams, signatureCollapsed)

      const code = await web3.eth.getCode(expectedAddress, logs[0].blockNumber)

      chai.expect(web3.utils.toBN(expectedCode)).to.be.bignumber.equal(web3.utils.toBN(code))
    })

    it('should revert for an invalid signature', async () => {
      const logicAddress = addr(0)
      const initParams = '0x00'
      const recoverer = addr(0)
      const index = '0'

      const toSign: string = web3.utils.soliditySha3(
        { t: 'bytes2', v: '0x1910' },
        { t: 'address', v: ownerAddress },
        { t: 'address', v: recoverer },
        { t: 'address', v: logicAddress },
        { t: 'uint256', v: index },
        { t: 'bytes', v: initParams }
      ) ?? ''

      const toSignAsBinaryArray = ethers.utils.arrayify(toSign)
      const signingKey = new ethers.utils.SigningKey(ownerPrivateKey)
      const signature = signingKey.signDigest(toSignAsBinaryArray)
      let signatureCollapsed: string = ethers.utils.joinSignature(signature)

      signatureCollapsed = signatureCollapsed.substr(0, signatureCollapsed.length - 1).concat('0')

      await expectRevert.unspecified(factory.createUserSmartWallet(ownerAddress, recoverer, logicAddress,
        index, initParams, signatureCollapsed))
    })

    it('should not initialize if a second initialize() call to the Smart Wallet is attempted', async () => {
      const logicAddress = addr(0)
      const initParams = '0x'
      const recoverer = addr(0)
      const index = '0'

      const expectedAddress = await factory.getSmartWalletAddress(ownerAddress, recoverer,
        logicAddress, soliditySha3Raw({ t: 'bytes', v: initParams }), index)

      const toSign: string = web3.utils.soliditySha3(
        { t: 'bytes2', v: '0x1910' },
        { t: 'address', v: ownerAddress },
        { t: 'address', v: recoverer },
        { t: 'address', v: logicAddress },
        { t: 'uint256', v: index },
        { t: 'bytes', v: initParams }
      ) ?? ''

      const toSignAsBinaryArray = ethers.utils.arrayify(toSign)
      const signingKey = new ethers.utils.SigningKey(ownerPrivateKey)
      const signature = signingKey.signDigest(toSignAsBinaryArray)
      const signatureCollapsed = ethers.utils.joinSignature(signature)

      const { logs } = await factory.createUserSmartWallet(ownerAddress, recoverer, logicAddress,
        index, initParams, signatureCollapsed)

      const salt = web3.utils.soliditySha3(
        { t: 'address', v: ownerAddress },
        { t: 'address', v: recoverer },
        { t: 'address', v: logicAddress },
        { t: 'bytes32', v: soliditySha3Raw({ t: 'bytes', v: initParams }) },
        { t: 'uint256', v: index }
      ) ?? ''

      const expectedSalt = web3.utils.toBN(salt).toString()

      // Check the emitted event
      expectEvent.inLogs(logs, 'Deployed', {
        addr: expectedAddress,
        salt: expectedSalt
      })

      const isInitializedFunc = web3.eth.abi.encodeFunctionCall({
        name: 'isInitialized',
        type: 'function',
        inputs: []
      }, [])

      const trx = await web3.eth.getTransaction(logs[0].transactionHash)

      const newTrx = {
        from: trx.from,
        gas: trx.gas,
        to: expectedAddress,
        gasPrice: trx.gasPrice,
        value: trx.value,
        data: isInitializedFunc
      }

      // Call the initialize function
      let result = await web3.eth.call(newTrx)

      let resultStr = result as string

      // It should be initialized
      chai.expect(web3.utils.toBN(1)).to.be.bignumber.equal(web3.utils.toBN(resultStr))

      const initFunc = await web3.eth.abi.encodeFunctionCall({
        name: 'initialize',
        type: 'function',
        inputs: [{
          type: 'address',
          name: 'owner'
        },
        {
          type: 'address',
          name: 'logic'
        },
        {
          type: 'address',
          name: 'tokenAddr'
        },
        {
          type: 'bytes',
          name: 'initParams'
        },
        {
          type: 'bytes',
          name: 'transferData'
        }
        ]
      }, [ownerAddress, logicAddress, addr(0), initParams, '0x00'])

      newTrx.data = initFunc

      // Trying to manually call the initialize function again (it was called during deploy)
      result = await web3.eth.call(newTrx)
      resultStr = result as string

      // It should return false since it was already initialized
      chai.expect(web3.utils.toBN(0)).to.be.bignumber.equal(web3.utils.toBN(resultStr))

      newTrx.data = isInitializedFunc

      result = await web3.eth.call(newTrx)
      resultStr = result as string

      // The smart wallet should be still initialized
      chai.expect(web3.utils.toBN(1)).to.be.bignumber.equal(web3.utils.toBN(resultStr))
    })
  })

  describe('#relayedUserSmartWalletCreation', () => {
    it('should create the Smart Wallet in the expected address', async () => {
      const logicAddress = addr(0)
      const initParams = '0x'
      const deployPrice = '0x01' // 1 token
      const recoverer = addr(0)
      const index = '0'

      const expectedAddress = await factory.getSmartWalletAddress(ownerAddress, recoverer,
        logicAddress, soliditySha3Raw({ t: 'bytes', v: initParams }), index)

      token = await TestToken.new()
      await token.mint('200', expectedAddress)

      const originalBalance = await token.balanceOf(expectedAddress)
      const typeName = `ForwardRequest(${FORWARDER_PARAMS})`
      const typeHash = keccak256(typeName)

      const req = {
        from: ownerAddress,
        to: logicAddress,
        value: 0,
        gas: 400000,
        nonce: 0,
        data: initParams,
        tokenRecipient: recipientAddress,
        tokenContract: token.address,
        tokenAmount: deployPrice,
        factory: addr(0), // param only needed by RelayHub
        recoverer: recoverer,
        index: index
      }

      const data: EIP712TypedData = {
        domain: {
          name: 'Test Domain',
          version: '1',
          chainId: env.chainId,
          verifyingContract: factory.address
        },
        primaryType: 'ForwardRequest',
        types: {
          EIP712Domain: EIP712DomainType,
          ForwardRequest: ForwardRequestType
        },
        message: req
      }

      const sig = signTypedData_v4(ownerPrivateKey, { data })
      const domainSeparator = bufferToHex(TypedDataUtils.hashStruct('EIP712Domain', data.domain, data.types))

      const { logs } = await factory.relayedUserSmartWalletCreation(req, domainSeparator, typeHash, '0x', sig)

      const salt = web3.utils.soliditySha3(
        { t: 'address', v: ownerAddress },
        { t: 'address', v: recoverer },
        { t: 'address', v: logicAddress },
        { t: 'bytes32', v: soliditySha3Raw({ t: 'bytes', v: initParams }) },
        { t: 'uint256', v: index }
      ) ?? ''

      const expectedSalt = web3.utils.toBN(salt).toString()

      // Check the emitted event
      expectEvent.inLogs(logs, 'Deployed', {
        addr: expectedAddress,
        salt: expectedSalt
      })

      // The Smart Wallet should have been charged for the deploy
      const newBalance = await token.balanceOf(expectedAddress)
      const expectedBalance = originalBalance.sub(web3.utils.toBN(deployPrice))
      chai.expect(expectedBalance).to.be.bignumber.equal(newBalance)
    })

    it('should create the Smart Wallet with the expected proxy code', async () => {
      const logicAddress = addr(0)
      const initParams = '0x'
      const deployPrice = '0x01' // 1 token
      const recoverer = addr(0)
      const index = '0'

      const expectedAddress = await factory.getSmartWalletAddress(ownerAddress, recoverer,
        logicAddress, soliditySha3Raw({ t: 'bytes', v: initParams }), index)

      token = await TestToken.new()
      await token.mint('200', expectedAddress)

      const typeName = `ForwardRequest(${FORWARDER_PARAMS})`
      const typeHash = keccak256(typeName)

      const req = {
        from: ownerAddress,
        to: logicAddress,
        value: 0,
        gas: 400000,
        nonce: 0,
        data: initParams,
        tokenRecipient: recipientAddress,
        tokenContract: token.address,
        tokenAmount: deployPrice,
        factory: addr(0), // param only needed by RelayHub
        recoverer: recoverer,
        index: index
      }

      const data: EIP712TypedData = {
        domain: {
          name: 'Test Domain',
          version: '1',
          chainId: env.chainId,
          verifyingContract: factory.address
        },
        primaryType: 'ForwardRequest',
        types: {
          EIP712Domain: EIP712DomainType,
          ForwardRequest: ForwardRequestType
        },
        message: req
      }

      const sig = signTypedData_v4(ownerPrivateKey, { data })
      const domainSeparator = bufferToHex(TypedDataUtils.hashStruct('EIP712Domain', data.domain, data.types))

      // expectedCode = runtime code only
      let expectedCode = await factory.getCreationBytecode()
      expectedCode = '0x' + expectedCode.slice(20, expectedCode.length)

      const { logs } = await factory.relayedUserSmartWalletCreation(req, domainSeparator, typeHash, '0x', sig)

      const code = await web3.eth.getCode(expectedAddress, logs[0].blockNumber)

      chai.expect(web3.utils.toBN(expectedCode)).to.be.bignumber.equal(web3.utils.toBN(code))
    })

    it('should revert for an invalid signature', async () => {
      const logicAddress = addr(0)
      const initParams = '0x'
      const deployPrice = '0x01' // 1 token
      const recoverer = addr(0)
      const index = '0'

      const expectedAddress = await factory.getSmartWalletAddress(ownerAddress, recoverer,
        logicAddress, soliditySha3Raw({ t: 'bytes', v: initParams }), index)

      const originalBalance = await token.balanceOf(expectedAddress)
      const typeName = `ForwardRequest(${FORWARDER_PARAMS})`
      const typeHash = keccak256(typeName)

      const req = {
        from: ownerAddress,
        to: logicAddress,
        value: 0,
        gas: 400000,
        nonce: 0,
        data: initParams,
        tokenRecipient: recipientAddress,
        tokenContract: token.address,
        tokenAmount: deployPrice,
        factory: addr(0), // param only needed by RelayHub
        recoverer: recoverer,
        index: index
      }

      const data: EIP712TypedData = {
        domain: {
          name: 'Test Domain',
          version: '1',
          chainId: env.chainId,
          verifyingContract: factory.address
        },
        primaryType: 'ForwardRequest',
        types: {
          EIP712Domain: EIP712DomainType,
          ForwardRequest: ForwardRequestType
        },
        message: req
      }

      const sig = signTypedData_v4(ownerPrivateKey, { data })
      const domainSeparator = bufferToHex(TypedDataUtils.hashStruct('EIP712Domain', data.domain, data.types))

      req.factory = addr(1) // change data after signature

      await expectRevert.unspecified(factory.relayedUserSmartWalletCreation(req, domainSeparator, typeHash, '0x', sig))

      const newBalance = await token.balanceOf(expectedAddress)
      chai.expect(originalBalance).to.be.bignumber.equal(newBalance)
    })

    it('should not initialize if a second initialize() call to the Smart Wallet is attempted', async () => {
      const logicAddress = addr(0)
      const initParams = '0x'
      const deployPrice = '0x01' // 1 token
      const recoverer = addr(0)
      const index = '0'

      const expectedAddress = await factory.getSmartWalletAddress(ownerAddress, recoverer,
        logicAddress, soliditySha3Raw({ t: 'bytes', v: initParams }), index)

      token = await TestToken.new()
      await token.mint('200', expectedAddress)

      const originalBalance = await token.balanceOf(expectedAddress)
      const typeName = `ForwardRequest(${FORWARDER_PARAMS})`
      const typeHash = keccak256(typeName)

      const req = {
        from: ownerAddress,
        to: logicAddress,
        value: 0,
        gas: 400000,
        nonce: 0,
        data: initParams,
        tokenRecipient: recipientAddress,
        tokenContract: token.address,
        tokenAmount: deployPrice,
        factory: addr(0), // param only needed by RelayHub
        recoverer: recoverer,
        index: index
      }

      const data: EIP712TypedData = {
        domain: {
          name: 'Test Domain',
          version: '1',
          chainId: env.chainId,
          verifyingContract: factory.address
        },
        primaryType: 'ForwardRequest',
        types: {
          EIP712Domain: EIP712DomainType,
          ForwardRequest: ForwardRequestType
        },
        message: req
      }

      const sig = signTypedData_v4(ownerPrivateKey, { data })
      const domainSeparator = bufferToHex(TypedDataUtils.hashStruct('EIP712Domain', data.domain, data.types))

      const { logs } = await factory.relayedUserSmartWalletCreation(req, domainSeparator, typeHash, '0x', sig)

      const salt = web3.utils.soliditySha3(
        { t: 'address', v: ownerAddress },
        { t: 'address', v: recoverer },
        { t: 'address', v: logicAddress },
        { t: 'bytes32', v: soliditySha3Raw({ t: 'bytes', v: initParams }) },
        { t: 'uint256', v: index }
      ) ?? ''

      const expectedSalt = web3.utils.toBN(salt).toString()

      // Check the emitted event
      expectEvent.inLogs(logs, 'Deployed', {
        addr: expectedAddress,
        salt: expectedSalt
      })

      // The Smart Wallet should have been charged for the deploy
      const newBalance = await token.balanceOf(expectedAddress)
      const expectedBalance = originalBalance.sub(web3.utils.toBN(deployPrice))
      chai.expect(expectedBalance).to.be.bignumber.equal(newBalance)

      const isInitializedFunc = web3.eth.abi.encodeFunctionCall({
        name: 'isInitialized',
        type: 'function',
        inputs: []
      }, [])

      const trx = await web3.eth.getTransaction(logs[0].transactionHash)

      const newTrx = {
        from: trx.from,
        gas: trx.gas,
        to: expectedAddress,
        gasPrice: trx.gasPrice,
        value: trx.value,
        data: isInitializedFunc
      }

      // Call the initialize function
      let result = await web3.eth.call(newTrx)

      let resultStr = result as string

      // It should be initialized
      chai.expect(web3.utils.toBN(1)).to.be.bignumber.equal(web3.utils.toBN(resultStr))

      const transferFunc = await web3.eth.abi.encodeFunctionCall({
        name: 'transfer',
        type: 'function',
        inputs: [{
          type: 'address',
          name: '_to'
        },
        {
          type: 'uint256',
          name: '_value'
        }
        ]
      }, [
        recipientAddress, deployPrice
      ])

      const initFunc = await web3.eth.abi.encodeFunctionCall({
        name: 'initialize',
        type: 'function',
        inputs: [{
          type: 'address',
          name: 'owner'
        },
        {
          type: 'address',
          name: 'logic'
        },
        {
          type: 'address',
          name: 'tokenAddr'
        },
        {
          type: 'bytes',
          name: 'initParams'
        },
        {
          type: 'bytes',
          name: 'transferData'
        }
        ]
      }, [ownerAddress, logicAddress, token.address, initParams, transferFunc])

      newTrx.data = initFunc

      // Trying to manually call the initialize function again (it was called during deploy)
      result = await web3.eth.call(newTrx)
      resultStr = result as string

      // It should return false since it was already initialized
      chai.expect(web3.utils.toBN(0)).to.be.bignumber.equal(web3.utils.toBN(resultStr))

      newTrx.data = isInitializedFunc

      result = await web3.eth.call(newTrx)
      resultStr = result as string

      // The smart wallet should be still initialized
      chai.expect(web3.utils.toBN(1)).to.be.bignumber.equal(web3.utils.toBN(resultStr))
    })
  })
}

)
