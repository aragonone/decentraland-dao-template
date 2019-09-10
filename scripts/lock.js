/* global web3 artifacts */

const AppProxyUpgradeable = artifacts.require('AppProxyUpgradeable')
const TokenWrapper = artifacts.require('TokenWrapper')
const Mana = artifacts.require('ERC20')
const MiniMeToken = artifacts.require('MiniMeToken')

console.log(`WARNING: This script is only intended to run in rinkeby right now...`)

async function run() {
  const user = web3.currentProvider.address
  console.log(`user address:`, user)

  const mana = Mana.at('0x28BcE5263f5d7F4EB7e8C6d5d78275CA455BAc63')
  console.log(`mana address:`, mana.address)

  const proxyAddress = '0xE4D47793160d71C65Ab58c5A9dADA35C878AAcBc'
  const tokenWrapper = TokenWrapper.at(proxyAddress)
  const proxy = AppProxyUpgradeable.at(proxyAddress)
  const baseTokenWrapper = await proxy.implementation()
  console.log(`tokenWrapper address (via proxy):`, tokenWrapper.address)
  console.log(`tokenWrapper base implementation address:`, baseTokenWrapper)

  const orgTokenAddress = await tokenWrapper.token()
  console.log(`org token address:`, orgTokenAddress)
  const orgToken = MiniMeToken.at(orgTokenAddress)

  let balance = ( await mana.balanceOf(user) ).toNumber()
  console.log(`user mana balance:`, balance)

  const allowance = ( await mana.allowance(user, tokenWrapper.address) ).toNumber()
  if (allowance === 0) {
    console.log(`Approving mana for tokenWrapper...`)
    await mana.approve(tokenWrapper.address, 100000000000)
  }
  console.log(`user allowance on tokenWrapper:`, allowance)

  const amount = 500
  console.log(`Locking ${amount} mana...`)
  const receipt = await tokenWrapper.lock(amount)
  console.log(receipt)

  const lockedAmount = ( await tokenWrapper.getLockedAmount(user) ).toNumber()
  console.log(`Total locked amount for ${user}:`, lockedAmount)

  const orgTokenBalance = (await orgToken.balanceOf(user)).toNumber()
  balance = ( await mana.balanceOf(user) ).toNumber()
  console.log(`user mana balance:`, balance)
  console.log(`user org token balance:`, orgTokenBalance)
}

module.exports = callback => {
  run()
    .then(callback)
    .catch(callback)
}
