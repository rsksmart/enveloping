require('ts-node/register/transpile-only')

var HDWalletProvider = require('truffle-hdwallet-provider')
var mnemonic = 'digital unknown jealous mother legal hedgehog save glory december universe spread figure custom found six'

const secretMnemonicFile = './secret_mnemonic'
const fs = require('fs')
let secretMnemonic
if (fs.existsSync(secretMnemonicFile)) {
  secretMnemonic = fs.readFileSync(secretMnemonicFile, { encoding: 'utf8' })
}

module.exports = {
  // See <http://truffleframework.com/docs/advanced/configuration>
  // to customize your Truffle configuration!
  networks: {

    development: {
      provider: undefined,
      verbose: process.env.VERBOSE,
      host: '127.0.0.1',
      port: 8545,
      network_id: '*'
    },
    coverage: { // coverage/trace provider. note that it currently can't run extrnal-process relay.
      provider: require('./coverage-prov.js'),
      verbose: process.env.VERBOSE,
      network_id: '*'
    },
    npmtest: { // used from "npm test". see pakcage.json
      verbose: process.env.VERBOSE,
      host: '127.0.0.1',
      port: 8544,
      network_id: '*'
    },
    mainnet: {
      provider: function () {
        return new HDWalletProvider(mnemonic, 'https://mainnet.infura.io/v3/f40be2b1a3914db682491dc62a19ad43')
      },
      network_id: 1
    },
    rsktestnet: {
      provider: function () {
        return new HDWalletProvider(mnemonic, 'https://public-node.testnet.rsk.co')
      },
      network_id: '*',
      gas: 6300000,
      gasPrice: 60000000 // 0.06 gwei
    },
    kovan: {
      provider: function () {
        return new HDWalletProvider(mnemonic, 'https://kovan.infura.io/v3/f40be2b1a3914db682491dc62a19ad43')
      },
      network_id: 42
    },
    rinkeby: {
      provider: function () {
        return new HDWalletProvider(mnemonic, 'https://rinkeby.infura.io/v3/f40be2b1a3914db682491dc62a19ad43')
      },
      network_id: 4
    },
    ropsten: {
      provider: function () {
        return new HDWalletProvider(mnemonic, 'https://ropsten.infura.io/v3/f40be2b1a3914db682491dc62a19ad43')
      },
      network_id: 3
    },
    xdai_poa_mainnet: {
      provider: function () {
        const wallet = new HDWalletProvider(secretMnemonic, 'https://dai.poa.network')
        return wallet
      },
      network_id: 100
    },
    rsk: {
      verbose: process.env.VERBOSE,
      host: '127.0.0.1',
      port: 4444,
      network_id: '*',
      gas: 6300000,
      gasPrice: 60000000 // 0.06 gwei
    }
  },
  mocha: {
    slow: 1000,
    reporter: 'eth-gas-reporter',
    reporterOptions: {
      currency: 'USD',
      onlyCalledMethods: true,
      showTimeSpent: true,
      excludeContracts: []
    }
  },
  compilers: {
    solc: {
      version: '0.6.12',
      settings: {
        evmVersion: 'istanbul',
        optimizer: {
          enabled: true,
          runs: 200 // Optimize for how many times you intend to run the code
        }
      }
    }
  }
}
