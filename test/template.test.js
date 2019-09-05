const assertRevert = require('@aragon/templates-shared/helpers/assertRevert')(web3)

const { hash: namehash } = require('eth-ens-namehash')
const { APP_IDS } = require('@aragon/templates-shared/helpers/apps')
const { randomId } = require('@aragon/templates-shared/helpers/aragonId')
const { getEventArgument } = require('@aragon/test-helpers/events')
const { deployedAddresses } = require('@aragon/templates-shared/lib/arapp-file')(web3)
const { getInstalledApps, getInstalledAppsById } = require('@aragon/templates-shared/helpers/events')(artifacts)
const { assertRole, assertMissingRole } = require('@aragon/templates-shared/helpers/assertRole')(web3)
const { EMPTY_SCRIPT, encodeCallScript } = require('@aragon/test-helpers/evmScript')

const DecentralandTemplate = artifacts.require('DecentralandTemplate')

const ENS = artifacts.require('ENS')
const ACL = artifacts.require('ACL')
const Kernel = artifacts.require('Kernel')
const Agent = artifacts.require('Agent')
const Voting = artifacts.require('Voting')
const TokenWrapper = artifacts.require('TokenWrapper')
const ERC20 = artifacts.require('ERC20Sample')
const MultiSigMock = artifacts.require('MultiSigMock')
const MiniMeToken = artifacts.require('MiniMeToken')
const PublicResolver = artifacts.require('PublicResolver')
const EVMScriptRegistry = artifacts.require('EVMScriptRegistry')

const ONE_DAY = 60 * 60 * 24
const ONE_WEEK = ONE_DAY * 7
const THIRTY_DAYS = ONE_DAY * 30
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

contract('DecentralandTemplate', ([_, owner, holder, someone]) => {
  let daoID, template, dao, acl, ens, dclMultiSig
  let voting, tokenWrapper, agent
  let mana, token

  const TOKEN_NAME = 'Decentraland Token'
  const TOKEN_SYMBOL = 'DCL'

  const VOTE_DURATION = ONE_WEEK
  const SUPPORT_REQUIRED = 50e16
  const MIN_ACCEPTANCE_QUORUM = 5e16
  const VOTING_SETTINGS = [SUPPORT_REQUIRED, MIN_ACCEPTANCE_QUORUM, VOTE_DURATION]

  before('simulate mana', async () => {
    mana = await ERC20.new({ from: holder }) // mints 1e18 tokens to sender
  })

  before('simulate dclMultiSig', async () => {
    dclMultiSig = await MultiSigMock.new()
  })

  before('fetch template and ENS', async () => {
    const { registry, address } = await deployedAddresses()
    ens = ENS.at(registry)
    template = DecentralandTemplate.at(address)
  })

  describe('when the creation fails', () => {
    context('when a token was not created before creating the instance', () => {
      it('reverts', async () => {
        await assertRevert(
          template.newInstance(randomId(), mana.address, dclMultiSig.address, VOTING_SETTINGS),
          'TEMPLATE_MISSING_TOKEN_CACHE'
        )
      })
    })

    context('when a token was previously created', () => {
      before('create token', async () => {
        await template.newToken(TOKEN_NAME, TOKEN_SYMBOL, { from: owner })
      })

      it('revertes when using an invalid id', async () => {
        await assertRevert(
          template.newInstance('', mana.address, dclMultiSig.address, VOTING_SETTINGS),
          'TEMPLATE_INVALID_ID'
        )
      })

      it('reverts when using an invalid mana token address', async () => {
        await assertRevert(
          template.newInstance(randomId(), someone, dclMultiSig.address, VOTING_SETTINGS, { from: owner }),
          'DECENTRALAND_BAD_MANA_TOKEN'
        )
      })

      it('reverts when using an invalid dclMultiSig', async () => {
        await assertRevert(
          template.newInstance(randomId(), mana.address, someone, VOTING_SETTINGS, { from: owner }),
          'DECENTRALAND_BAD_MULTISIG'
        )
      })
    })
  })

  describe('when the creation succeeds', () => {
    let tokenReceipt, instanceReceipt

    const expectedDaoCreationCost = 5e6
    const expectedTokenCreationCost = 1.8e6
    const expectedTotalCost = expectedTokenCreationCost + expectedDaoCreationCost

    before('create token and entity', async () => {
      daoID = randomId()

      tokenReceipt = await template.newToken(TOKEN_NAME, TOKEN_SYMBOL, { from: owner })
      instanceReceipt = await template.newInstance(daoID, mana.address, dclMultiSig.address, VOTING_SETTINGS, { from: owner })

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

    it('sets up DAO and ACL permissions correctly', async () => {
      await assertRole(acl, dao, dclMultiSig, 'APP_MANAGER_ROLE')
      await assertRole(acl, acl, dclMultiSig, 'CREATE_PERMISSIONS_ROLE')
    })

    it('sets up EVM scripts registry permissions correctly', async () => {
      const reg = await EVMScriptRegistry.at(await acl.getEVMScriptRegistry())
      await assertRole(acl, reg, voting, 'REGISTRY_ADD_EXECUTOR_ROLE')
      await assertRole(acl, reg, voting, 'REGISTRY_MANAGER_ROLE')
    })

    it(`gas costs must be up to ~${expectedTotalCost} gas`, async () => {
      const tokenCreationCost = tokenReceipt.receipt.gasUsed
      assert.isAtMost(tokenCreationCost, expectedTokenCreationCost, `token creation call should cost up to ${tokenCreationCost} gas`)

      const daoCreationCost = instanceReceipt.receipt.gasUsed
      assert.isAtMost(daoCreationCost, expectedDaoCreationCost, `dao creation call should cost up to ${expectedDaoCreationCost} gas`)

      const totalCost = tokenCreationCost + daoCreationCost
      assert.isAtMost(totalCost, expectedTotalCost, `total costs should be up to ${expectedTotalCost} gas`)
    })

    it('should have voting app correctly setup', async () => {
      assert.isTrue(await voting.hasInitialized(), 'voting not initialized')
      assert.equal((await voting.supportRequiredPct()).toString(), SUPPORT_REQUIRED)
      assert.equal((await voting.minAcceptQuorumPct()).toString(), MIN_ACCEPTANCE_QUORUM)
      assert.equal((await voting.voteTime()).toString(), VOTE_DURATION)
      assert.equal((await voting.votesLength()).toNumber(), 0, `no vote should exist`)

      await assertRole(acl, voting, dclMultiSig, 'CREATE_VOTES_ROLE', tokenWrapper)
      await assertRole(acl, voting, dclMultiSig, 'MODIFY_QUORUM_ROLE', voting)
      await assertRole(acl, voting, dclMultiSig, 'MODIFY_SUPPORT_ROLE', voting)
    })

    it('should have agent app correctly setup', async () => {
      assert.isTrue(await agent.hasInitialized(), 'agent not initialized')
      assert.equal(await agent.designatedSigner(), ZERO_ADDRESS)

      assert.equal(await dao.recoveryVaultAppId(), APP_IDS.agent, 'agent app is not being used as the vault app of the DAO')
      assert.equal(web3.toChecksumAddress(await dao.getRecoveryVault()), agent.address, 'agent app is not being used as the vault app of the DAO')

      await assertRole(acl, agent, dclMultiSig, 'EXECUTE_ROLE')
      await assertRole(acl, agent, dclMultiSig, 'RUN_SCRIPT_ROLE')
      await assertRole(acl, agent, dclMultiSig, 'EXECUTE_ROLE', voting)
      await assertRole(acl, agent, dclMultiSig, 'RUN_SCRIPT_ROLE', voting)

      await assertMissingRole(acl, agent, 'DESIGNATE_SIGNER_ROLE')
      await assertMissingRole(acl, agent, 'ADD_PRESIGNED_HASH_ROLE')
    })
  })

  describe('when inspecting the token-wrapper app', () => {
    it('has an erc20 and a minime token', async () => {
      assert.isTrue(await tokenWrapper.isForwarder())
      assert.equal(await tokenWrapper.erc20(), mana.address)
      assert.equal(await tokenWrapper.token(), token.address)
    })

    it('can mint tokens', async () => {
      await mana.approve(tokenWrapper.address, 2e18, { from: holder })
      await tokenWrapper.lock(2e18, { from: holder })

      assert.isTrue(await tokenWrapper.canForward(holder, '0x'))
      assert.equal((await tokenWrapper.getLockedAmount(holder)).toString(), 2e18)
      assert.equal((await token.balanceOf(holder)).toString(), 2e18)
      assert.equal((await mana.balanceOf(holder)).toString(), 999998e18)
    })

    it('can not mint invalid amounts', async () => {
      await assertRevert(tokenWrapper.lock(0, { from: holder }), 'TW_LOCK_AMOUNT_ZERO')
      await assertRevert(tokenWrapper.lock(1e30, { from: holder }), 'TW_ERC20_TRANSFER_FROM_FAILED')
    })

    it('can burn tokens', async () => {
      await tokenWrapper.unlock(1e18, { from: holder })

      assert.equal((await tokenWrapper.getLockedAmount(holder)).toString(), 1e18)
      assert.equal((await token.balanceOf(holder)).toString(), 1e18)
      assert.equal((await mana.balanceOf(holder)).toString(), 999999e18)
    })

    it('can not burn invalid amounts', async () => {
      await assertRevert(tokenWrapper.unlock(0, { from: holder }), 'TW_UNLOCK_AMOUNT_ZERO')
      await assertRevert(tokenWrapper.unlock(1e30, { from: holder }), 'TW_INVALID_UNLOCK_AMOUNT')
    })

    it('does not allow to transfer tokens', async () => {
      await assertRevert(token.transfer(someone, 1e16, { from: holder }))
    })

    it('does not allow to approve tokens', async () => {
      await assertRevert(token.approve(someone, 1e16, { from: holder }))
    })

    describe('when creating votes', () => {
      let holderBalance

      before('check holder token balance', async () => {
        holderBalance = (await token.balanceOf(holder)).toNumber()
        assert.equal(holderBalance > 0, true, `holder has no token balance`)
      })

      before('forward a script that creates a vote via the token wrapper', async () => {
        const action = { to: voting.address, calldata: voting.contract.newVote.getData(EMPTY_SCRIPT, 'Vote metadata') }
        const script = encodeCallScript([action])
        await tokenWrapper.forward(script, { from: holder })
      })

      it('creates a vote', async () => {
        assert.equal((await voting.votesLength()).toNumber(), 1, `a vote should exist`)
      })

      it('does not allow a non holder to vote', async () => {
        await assertRevert(
          voting.vote(0, true, false, { from: someone }),
          'VOTING_CAN_NOT_VOTE'
        )
      })

      it('allows a token holder to vote', async () => {
        await voting.vote(0, true, false, { from: holder })
      })
    })
  })
})
