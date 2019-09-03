const encodeCall = require('@aragon/templates-shared/helpers/encodeCall')
const assertRevert = require('@aragon/templates-shared/helpers/assertRevert')(web3)

const { hash: namehash } = require('eth-ens-namehash')
const { randomId } = require('@aragon/templates-shared/helpers/aragonId')
const { getEventArgument } = require('@aragon/test-helpers/events')
const { deployedAddresses } = require('@aragon/templates-shared/lib/arapp-file')(web3)

const DecentralandTemplate = artifacts.require('DecentralandTemplate')

const ENS = artifacts.require('ENS')
const ACL = artifacts.require('ACL')
const Kernel = artifacts.require('Kernel')
const MiniMeToken = artifacts.require('MiniMeToken')
const PublicResolver = artifacts.require('PublicResolver')

contract('DecentralandTemplate', ([_, owner]) => {
  let daoID, template, dao, acl, ens

  const TOKEN_NAME = 'Decentraland Token'
  const TOKEN_SYMBOL = 'DCL'

  before('fetch template and ENS', async () => {
    const { registry, address } = await deployedAddresses()
    ens = ENS.at(registry)
    template = DecentralandTemplate.at(address)
  })

  const newInstance = (...params) => {
    const lastParam = params[params.length - 1]
    const txParams = (!Array.isArray(lastParam) && typeof lastParam === 'object') ? params.pop() : {}
    const newInstanceFn = DecentralandTemplate.abi.find(({ name, inputs }) => name === 'newInstance' && inputs.length === params.length)
    return template.sendTransaction(encodeCall(newInstanceFn, params, txParams))
  }

  const loadDAO = async (tokenReceipt, instanceReceipt) => {
    dao = Kernel.at(getEventArgument(instanceReceipt, 'DeployDao', 'dao'))
    token = MiniMeToken.at(getEventArgument(tokenReceipt, 'DeployToken', 'token'))
    acl = ACL.at(await dao.acl())

    assert.equal(dao.address, getEventArgument(instanceReceipt, 'SetupDao', 'dao'), 'should have emitted a SetupDao event')
  }

  const itSetupsDAOCorrectly = () => {
    it('registers a new DAO on ENS', async () => {
      const aragonIdNameHash = namehash(`${daoID}.aragonid.eth`)
      const resolvedAddress = await PublicResolver.at(await ens.resolver(aragonIdNameHash)).addr(aragonIdNameHash)
      assert.equal(resolvedAddress, dao.address, 'aragonId ENS name does not match')
    })

    it('creates a new token', async () => {
      assert.equal(await token.name(), TOKEN_NAME)
      assert.equal(await token.symbol(), TOKEN_SYMBOL)
      assert.equal(await token.transfersEnabled(), true)
      assert.equal((await token.decimals()).toString(), 18)
    })
  }

  context('when creating instances with a single transaction', () => {
    context('when the creation fails', () => {})
    context('when the creation succeeds', () => {})
  })

  context('when creating instances with separate transactions', () => {
    context('when the creation fails', () => {
      context('a token was not created before creating the instance', () => {})
    })

    context('when the creation succeeds', () => {
      const itCostsUpTo = (expectedDaoCreationCost) => {
        const expectedTokenCreationCost = 1.8e6
        const expectedTotalCost = expectedTokenCreationCost + expectedDaoCreationCost

        it(`gas costs must be up to ~${expectedTotalCost} gas`, async () => {
          const tokenCreationCost = tokenReceipt.receipt.gasUsed
          assert.isAtMost(tokenCreationCost, expectedTokenCreationCost, `token creation call should cost up to ${tokenCreationCost} gas`)

          const daoCreationCost = instanceReceipt.receipt.gasUsed
          assert.isAtMost(daoCreationCost, expectedDaoCreationCost, `dao creation call should cost up to ${expectedDaoCreationCost} gas`)

          const totalCost = tokenCreationCost + daoCreationCost
          assert.isAtMost(totalCost, expectedTotalCost, `total costs should be up to ${expectedTotalCost} gas`)
        })
      }

      const createDAO = () => {
        before('create entity', async () => {
          daoID = randomId()
          tokenReceipt = await template.newToken(TOKEN_NAME, TOKEN_SYMBOL, { from: owner })
          instanceReceipt = await newInstance(daoID, { from: owner })
          await loadDAO(tokenReceipt, instanceReceipt)
        })
      }

      createDAO()
      itCostsUpTo(5e6)
      itSetupsDAOCorrectly()
    })
  })
})
