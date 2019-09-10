/* global web3 artifacts */

const TokenWrapper = artifacts.require('TokenWrapper')
const Mana = artifacts.require('ERC20')
const MiniMeToken = artifacts.require('MiniMeToken')

async function run() {
  const user = web3.currentProvider.address
  console.log(`user:`, user)

  const mana = Mana.at('0x28BcE5263f5d7F4EB7e8C6d5d78275CA455BAc63')
  console.log(`mana:`, mana.address)

  const proxyAddress = '0xE4D47793160d71C65Ab58c5A9dADA35C878AAcBc'
  const tokenWrapper = TokenWrapper.at(proxyAddress)
  console.log(`tokenWrapper:`, tokenWrapper.address)

  const orgTokenAddress = await tokenWrapper.token()
  const orgToken = MiniMeToken.at(orgTokenAddress)
  console.log(`org token:`, orgTokenAddress)

  const orgTokenBalance = (await orgToken.balanceOf(user)).toNumber()
  console.log(`user org token:`, orgTokenBalance)

  const balance = ( await mana.balanceOf(user) ).toNumber()
  console.log(`user mana:`, balance)

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
}

module.exports = callback => {
  run()
    .then(callback)
    .catch(callback)
}
