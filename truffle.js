const config = require('@aragon/os/truffle-config')

const HDWalletProvider = require('truffle-hdwallet-provider')
// const MNEMONIC = 'stumble story behind hurt patient ball whisper art swift tongue ice alien'
const MNEMONIC = 'another powder crowd summer tongue anxiety require multiply wise actor junk armed'
config.networks.rinkeby.provider = function() {
  return new HDWalletProvider(MNEMONIC, 'https://rinkeby.infura.io/v3/faf059296e4a41c28449a9cb95846c8d')
}

module.exports = config
