const SmartWallet = artifacts.require('SmartWallet')
const ProxyFactory = artifacts.require('ProxyFactory')
const DeployPaymaster = artifacts.require('DeployPaymaster')
const RelayPaymaster = artifacts.require('RelayPaymaster')

module.exports = async function (deployer) {
  // Template of the smart wallets to create with the factory
  await deployer.deploy(SmartWallet)
  // Factory to create Smart Wallets
  // keccak256('2') = ad7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5
  // ProxyFactory(SmartWalletTemplate:address, versionHash:bytes32)
  await deployer.deploy(ProxyFactory, SmartWallet.address, '0xad7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5')
  await deployer.deploy(DeployPaymaster, ProxyFactory.address)
  await deployer.deploy(RelayPaymaster, ProxyFactory.address)
}