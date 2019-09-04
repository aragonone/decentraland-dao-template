const assertRevert = require('@aragon/templates-shared/helpers/assertRevert')(web3)

const { hash: namehash } = require('eth-ens-namehash')
const { APP_IDS } = require('@aragon/templates-shared/helpers/apps')
const { randomId } = require('@aragon/templates-shared/helpers/aragonId')
const { getEventArgument } = require('@aragon/test-helpers/events')
const { deployedAddresses } = require('@aragon/templates-shared/lib/arapp-file')(web3)
const { getInstalledApps, getInstalledAppsById } = require('@aragon/templates-shared/helpers/events')(artifacts)
const { assertRole, assertMissingRole } = require('@aragon/templates-shared/helpers/assertRole')(web3)

const DecentralandTemplate = artifacts.require('DecentralandTemplate')

const ENS = artifacts.require('ENS')
const ACL = artifacts.require('ACL')
const Kernel = artifacts.require('Kernel')
const Agent = artifacts.require('Agent')
const Voting = artifacts.require('Voting')
const TokenWrapper = artifacts.require('TokenWrapper')
const ERC20 = artifacts.require('ERC20Sample')
const MiniMeToken = artifacts.require('MiniMeToken')
const PublicResolver = artifacts.require('PublicResolver')
const EVMScriptRegistry = artifacts.require('EVMScriptRegistry')

const ONE_DAY = 60 * 60 * 24
const ONE_WEEK = ONE_DAY * 7
const THIRTY_DAYS = ONE_DAY * 30
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

contract('DecentralandTemplate', ([_, owner, holder]) => {
  let daoID, template, dao, acl, ens
  let voting, tokenWrapper, agent
  let mana

  const TOKEN_NAME = 'Decentraland Token'
  const TOKEN_SYMBOL = 'DCL'

  const VOTE_DURATION = ONE_WEEK
  const SUPPORT_REQUIRED = 50e16
  const MIN_ACCEPTANCE_QUORUM = 5e16
  const VOTING_SETTINGS = [SUPPORT_REQUIRED, MIN_ACCEPTANCE_QUORUM, VOTE_DURATION]

  before('simulate mana', async () => {
    mana = await ERC20.new({ from: holder }) // mints 1e18 tokens to sender
  })

  before('fetch template and ENS', async () => {
    const { registry, address } = await deployedAddresses()
    ens = ENS.at(registry)
    template = DecentralandTemplate.at(address)
  })

  // TODO
  context('when the creation fails', () => {
    context('a token was not created before creating the instance', () => {})
  })

  context('when the creation succeeds', () => {
    let tokenReceipt, instanceReceipt

    const expectedDaoCreationCost = 5e6
    const expectedTokenCreationCost = 1.8e6
    const expectedTotalCost = expectedTokenCreationCost + expectedDaoCreationCost

    before('create entity', async () => {
      daoID = randomId()

      tokenReceipt = await template.newToken(TOKEN_NAME, TOKEN_SYMBOL, { from: owner })
      instanceReceipt = await template.newInstance(daoID, mana.address, VOTING_SETTINGS, { from: owner })

      dao = Kernel.at(getEventArgument(instanceReceipt, 'DeployDao', 'dao'))
      token = MiniMeToken.at(getEventArgument(tokenReceipt, 'DeployToken', 'token'))
      acl = ACL.at(await dao.acl())

      const installedApps = getInstalledAppsById(instanceReceipt)
      installedApps['token-wrapper'] = getInstalledApps(instanceReceipt, namehash('token-wrapper.aragonpm.eth'))

      assert.equal(dao.address, getEventArgument(instanceReceipt, 'SetupDao', 'dao'), 'should have emitted a SetupDao event')

      assert.equal(installedApps.voting.length, 1, 'should have installed 1 voting app')
      voting = Voting.at(installedApps.voting[0])

      assert.equal(installedApps.agent.length, 1, 'should have installed 1 agent app')
      agent = Agent.at(installedApps.agent[0])

      assert.equal(installedApps['token-wrapper'].length, 1, 'should have installed 1 token wrapper app')
      tokenWrapper = TokenWrapper.at(installedApps['token-wrapper'][0])
    })

    it('registers a new DAO on ENS', async () => {
      const aragonIdNameHash = namehash(`${daoID}.aragonid.eth`)
      const resolvedAddress = await PublicResolver.at(await ens.resolver(aragonIdNameHash)).addr(aragonIdNameHash)
      assert.equal(resolvedAddress, dao.address, 'aragonId ENS name does not match')
    })

    it('creates a new token', async () => {
      assert.equal(await token.name(), TOKEN_NAME)
      assert.equal(await token.symbol(), TOKEN_SYMBOL)
      assert.equal(await token.transfersEnabled(), false)
      assert.equal((await token.decimals()).toString(), 18)
    })

    it('should have voting app correctly setup', async () => {
      assert.isTrue(await voting.hasInitialized(), 'voting not initialized')
      assert.equal((await voting.supportRequiredPct()).toString(), SUPPORT_REQUIRED)
      assert.equal((await voting.minAcceptQuorumPct()).toString(), MIN_ACCEPTANCE_QUORUM)
      assert.equal((await voting.voteTime()).toString(), VOTE_DURATION)

      await assertRole(acl, voting, voting, 'CREATE_VOTES_ROLE', tokenWrapper)
      await assertRole(acl, voting, voting, 'MODIFY_QUORUM_ROLE')
      await assertRole(acl, voting, voting, 'MODIFY_SUPPORT_ROLE')
    })

    it('sets up DAO and ACL permissions correctly', async () => {
      await assertRole(acl, dao, voting, 'APP_MANAGER_ROLE')
      await assertRole(acl, acl, voting, 'CREATE_PERMISSIONS_ROLE')
    })

    it('sets up EVM scripts registry permissions correctly', async () => {
      const reg = await EVMScriptRegistry.at(await acl.getEVMScriptRegistry())
      await assertRole(acl, reg, voting, 'REGISTRY_ADD_EXECUTOR_ROLE')
      await assertRole(acl, reg, voting, 'REGISTRY_MANAGER_ROLE')
    })

    it('should have agent app correctly setup', async () => {
      assert.isTrue(await agent.hasInitialized(), 'agent not initialized')
      assert.equal(await agent.designatedSigner(), ZERO_ADDRESS)

      assert.equal(await dao.recoveryVaultAppId(), APP_IDS.agent, 'agent app is not being used as the vault app of the DAO')
      assert.equal(web3.toChecksumAddress(await dao.getRecoveryVault()), agent.address, 'agent app is not being used as the vault app of the DAO')

      await assertRole(acl, agent, voting, 'EXECUTE_ROLE')
      await assertRole(acl, agent, voting, 'RUN_SCRIPT_ROLE')

      await assertMissingRole(acl, agent, 'DESIGNATE_SIGNER_ROLE')
      await assertMissingRole(acl, agent, 'ADD_PRESIGNED_HASH_ROLE')
    })

    it(`gas costs must be up to ~${expectedTotalCost} gas`, async () => {
      const tokenCreationCost = tokenReceipt.receipt.gasUsed
      assert.isAtMost(tokenCreationCost, expectedTokenCreationCost, `token creation call should cost up to ${tokenCreationCost} gas`)

      const daoCreationCost = instanceReceipt.receipt.gasUsed
      assert.isAtMost(daoCreationCost, expectedDaoCreationCost, `dao creation call should cost up to ${expectedDaoCreationCost} gas`)

      const totalCost = tokenCreationCost + daoCreationCost
      assert.isAtMost(totalCost, expectedTotalCost, `total costs should be up to ${expectedTotalCost} gas`)
    })
  })
})
