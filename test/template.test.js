/* global contract artifacts web3 assert */

const { hash: namehash } = require('eth-ens-namehash')

const { APP_IDS } = require('@aragon/templates-shared/helpers/apps')
const { randomId } = require('@aragon/templates-shared/helpers/aragonId')
const { assertRole, assertMissingRole } = require('@aragon/templates-shared/helpers/assertRole')(web3)
const assertRevert = require('@aragon/templates-shared/helpers/assertRevert')(web3)
const { getInstalledApps, getInstalledAppsById } = require('@aragon/templates-shared/helpers/events')(artifacts)
const { getENS, getTemplateAddress } = require('@aragon/templates-shared/lib/ens')(web3, artifacts)

const { getEventArgument } = require('@aragon/test-helpers/events')
const { EMPTY_SCRIPT, encodeCallScript } = require('@aragon/test-helpers/evmScript')

// Misc.
const ERC20 = artifacts.require('ERC20Sample')
const MiniMeToken = artifacts.require('MiniMeToken')

// ENS
const PublicResolver = artifacts.require('PublicResolver')

// aragonOS core
const ACL = artifacts.require('ACL')
const EVMScriptRegistry = artifacts.require('EVMScriptRegistry')
const Kernel = artifacts.require('Kernel')

// aragon-apps
const Agent = artifacts.require('Agent')
const TokenManager = artifacts.require('TokenManager')
const Voting = artifacts.require('Voting')

// aragonone-apps
const TokenWrapper = artifacts.require('TokenWrapper')
const VotingAggregator = artifacts.require('VotingAggregator')

const MockDecentralandTemplate = artifacts.require('MockDecentralandTemplate')

const ONE_DAY = 60 * 60 * 24
const ONE_WEEK = ONE_DAY * 7
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MAX_ADDRESS = '0xffffffffffffffffffffffffffffffffffffffff'
const MAX_UINT256 = new web3.BigNumber(2).toPower(256).minus(1)

const bigExp = (x, y) => new web3.BigNumber(x).times(new web3.BigNumber(10).toPower(y))
const pct16 = x => bigExp(x, 16)

contract('DecentralandTemplate', ([someone, owner, holder, member1, member2]) => {
  let ens
  let mana
  let template

  const COMMUNITY_VOTE_DURATION = ONE_WEEK
  const COMMUNITY_SUPPORT_REQUIRED = pct16(50)
  const COMMUNITY_MIN_ACCEPTANCE_QUORUM = pct16(5)
  const COMMUNITY_VOTING_SETTINGS = [
    COMMUNITY_SUPPORT_REQUIRED,
    COMMUNITY_MIN_ACCEPTANCE_QUORUM,
    COMMUNITY_VOTE_DURATION
  ]

  const SAB_MEMBERS = [member1, member2]
  const SAB_VOTE_DURATION = ONE_DAY
  const SAB_SUPPORT_REQUIRED = pct16(50)
  const SAB_MIN_ACCEPTANCE_QUORUM = pct16(50)
  const SAB_VOTING_SETTINGS = [SAB_SUPPORT_REQUIRED, SAB_MIN_ACCEPTANCE_QUORUM, SAB_VOTE_DURATION]

  // Use base aragonpm.eth namehashes for these two apps as they're deployed to the base aragonPM
  // instance in the tests
  const MOCK_TOKEN_WRAPPER_NAMEHASH = namehash('token-wrapper.aragonpm.eth')
  const MOCK_VOTING_AGGREGATOR_NAMEHASH = namehash('voting-aggregator.aragonpm.eth')

  const WRAPPED_TOKEN_NAME = 'Wrapped Decentraland Mana'
  const WRAPPED_TOKEN_SYMBOL = 'wMANA'

  const AGGREGATE_TOKEN_NAME = 'Decentraland Voting Token'
  const AGGREGATE_TOKEN_SYMBOL = 'DVT'

  const prepareInstance = (manaAddress, options) => {
    return template.prepareInstanceWithVotingConnectors(
      manaAddress,
      WRAPPED_TOKEN_NAME,
      WRAPPED_TOKEN_SYMBOL,
      AGGREGATE_TOKEN_NAME,
      AGGREGATE_TOKEN_SYMBOL,
      options
    )
  }

  before('simulate mana', async () => {
    mana = await ERC20.new({ from: holder }) // mints 1e18 tokens to sender
  })

  before('fetch template and ENS', async () => {
    ens = await getENS()
    template = MockDecentralandTemplate.at(await getTemplateAddress())
  })

  context('when the creation fails', () => {
    context('when there was no instance prepared before', () => {
      it('reverts when trying to prepare an instance with a bad token', async () => {
        await assertRevert(
          prepareInstance(someone), // someone is a normal EOA account
          'DECENTRALAND_BAD_EXTERNAL_TOKEN'
        )
      })

      it('reverts when there was no instance prepared before', async () => {
        await assertRevert(
          template.finalizeInstance(
            randomId(),
            COMMUNITY_VOTING_SETTINGS,
            SAB_MEMBERS,
            SAB_VOTING_SETTINGS
          ),
          'DECENTRALAND_MISSING_CACHE'
        )
      })
    })

    context('when there was an instance already prepared', () => {
      before('prepare instance', async () => {
        await prepareInstance(mana.address, { from: owner })
      })

      it('reverts when no sab members were given', async () => {
        await assertRevert(
          template.finalizeInstance(randomId(), COMMUNITY_VOTING_SETTINGS, [], SAB_VOTING_SETTINGS, { from: owner }),
          'DECENTRALAND_MISSING_SAB_MEMBERS'
        )
      })

      it('reverts when an empty id is provided', async () => {
        await assertRevert(
          template.finalizeInstance('', COMMUNITY_VOTING_SETTINGS, SAB_MEMBERS, SAB_VOTING_SETTINGS, { from: owner }),
          'TEMPLATE_INVALID_ID'
        )
      })

      // Note that missing voting settings are always filled in by solidity as 0
    })
  })

  context('when the creation succeeds', () => {
    let daoId
    let prepareReceipt, finalizeReceipt
    let dao, acl, sabToken
    let agent, communityVoting, sabTokenManager, sabVoting, tokenWrapper, votingAggregator

    before('create dao', async () => {
      async function loadDAO(prepareReceipt, finalizeReceipt) {
        dao = Kernel.at(getEventArgument(prepareReceipt, 'DeployDao', 'dao'))
        acl = ACL.at(await dao.acl())

        sabToken = MiniMeToken.at(getEventArgument(finalizeReceipt, 'DeployToken', 'token', 0))

        const installedApps = getInstalledAppsById(finalizeReceipt)
        // These apps aren't in the default set of apps, so getInstalledAppsById doesn't pick them up
        installedApps['token-wrapper'] = getInstalledApps(prepareReceipt, MOCK_TOKEN_WRAPPER_NAMEHASH)
        installedApps['voting-aggregator'] = getInstalledApps(prepareReceipt, MOCK_VOTING_AGGREGATOR_NAMEHASH)

        assert.equal(installedApps.agent.length, 1, 'should have installed 1 agent app')
        agent = Agent.at(installedApps.agent[0])

        assert.equal(installedApps['token-manager'].length, 1, 'should have installed 1 token manager app')
        sabTokenManager = TokenManager.at(installedApps['token-manager'][0])

        assert.equal(installedApps.voting.length, 2, 'should have installed 2 voting apps')
        sabVoting = Voting.at(installedApps.voting[0])
        communityVoting = Voting.at(installedApps.voting[1])

        assert.equal(installedApps['token-wrapper'].length, 1, 'should have installed 1 token wrapper app')
        tokenWrapper = TokenWrapper.at(installedApps['token-wrapper'][0])

        assert.equal(installedApps['voting-aggregator'].length, 1, 'should have installed 1 voting aggregator app')
        votingAggregator = VotingAggregator.at(installedApps['voting-aggregator'][0])

        assert.equal(dao.address, getEventArgument(finalizeReceipt, 'SetupDao', 'dao'), 'should have emitted a SetupDao event')
      }

      daoId = randomId()
      prepareReceipt = await prepareInstance(mana.address, { from: owner })
      finalizeReceipt = await template.finalizeInstance(
        daoId,
        COMMUNITY_VOTING_SETTINGS,
        SAB_MEMBERS,
        SAB_VOTING_SETTINGS,
        { from: owner }
      )
      await loadDAO(prepareReceipt, finalizeReceipt)
    })

    const itCostsUpTo = () => {
      const expectedPrepareCost = 2.8e6
      const expectedFinalizeCost = 5.4e6

      it(`prepare's gas costs must be up to ~${expectedPrepareCost} gas`, async () => {
        const prepareCost = prepareReceipt.receipt.gasUsed
        assert.isAtMost(prepareCost, expectedPrepareCost, `dao creation call should cost up to ${expectedPrepareCost} gas`)
      })

      it(`finalize's gas costs must be up to ~${expectedFinalizeCost} gas`, async () => {
        const finalizeCost = finalizeReceipt.receipt.gasUsed
        assert.isAtMost(finalizeCost, expectedFinalizeCost, `dao creation call should cost up to ${expectedFinalizeCost} gas`)
      })
    }

    const itSetsUpDAOCorrectly = () => {
      it('registers a new DAO on ENS', async () => {
        const aragonIdNameHash = namehash(`${daoId}.aragonid.eth`)
        const resolvedAddress = await PublicResolver.at(await ens.resolver(aragonIdNameHash)).addr(aragonIdNameHash)
        assert.equal(resolvedAddress, dao.address, 'aragonId ENS name does not match')
      })

      it('sets up DAO and ACL permissions correctly', async () => {
        await assertRole(acl, dao, sabVoting, 'APP_MANAGER_ROLE')
        await assertRole(acl, acl, sabVoting, 'CREATE_PERMISSIONS_ROLE')
      })

      it('sets up EVM scripts registry permissions correctly', async () => {
        const reg = await EVMScriptRegistry.at(await acl.getEVMScriptRegistry())
        await assertRole(acl, reg, sabVoting, 'REGISTRY_ADD_EXECUTOR_ROLE')
        await assertRole(acl, reg, sabVoting, 'REGISTRY_MANAGER_ROLE')
      })
    }

    const itSetsUpAgentCorrectly = () => {
      it('should setup agent app correctly', async () => {
        assert.isTrue(await agent.hasInitialized(), 'agent not initialized')
        assert.equal(await agent.designatedSigner(), ZERO_ADDRESS)

        assert.equal(await dao.recoveryVaultAppId(), APP_IDS.agent, 'agent app is not being used as the vault app of the DAO')
        assert.equal(web3.toChecksumAddress(await dao.getRecoveryVault()), agent.address, 'agent app is not being used as the vault app of the DAO')

        await assertRole(acl, agent, sabVoting, 'EXECUTE_ROLE')
        await assertRole(acl, agent, sabVoting, 'RUN_SCRIPT_ROLE')
        await assertRole(acl, agent, sabVoting, 'EXECUTE_ROLE', communityVoting)
        await assertRole(acl, agent, sabVoting, 'RUN_SCRIPT_ROLE', communityVoting)

        await assertMissingRole(acl, agent, 'DESIGNATE_SIGNER_ROLE')
        await assertMissingRole(acl, agent, 'ADD_PRESIGNED_HASH_ROLE')
      })
    }

    const itSetsUpCommunityVotingCorrectly = () => {
      it('should setup community voting app correctly', async () => {
        assert.isTrue(await communityVoting.hasInitialized(), 'voting not initialized')
        assert.equal((await communityVoting.supportRequiredPct()).toString(), COMMUNITY_SUPPORT_REQUIRED)
        assert.equal((await communityVoting.minAcceptQuorumPct()).toString(), COMMUNITY_MIN_ACCEPTANCE_QUORUM)
        assert.equal((await communityVoting.voteTime()).toString(), COMMUNITY_VOTE_DURATION)
        assert.equal((await communityVoting.votesLength()).toNumber(), 0, 'no vote should exist')

        await assertRole(acl, communityVoting, sabVoting, 'CREATE_VOTES_ROLE', votingAggregator)
        await assertRole(acl, communityVoting, sabVoting, 'MODIFY_QUORUM_ROLE')
        await assertRole(acl, communityVoting, sabVoting, 'MODIFY_SUPPORT_ROLE')
      })
    }

    const itSetsUpSabTokenManagerCorrectly = () => {
      it('should setup sab token manager app correctly', async () => {
        assert.isTrue(await sabTokenManager.hasInitialized(), 'token manager not initialized')
        assert.equal(await sabTokenManager.token(), sabToken.address)

        await assertRole(acl, sabTokenManager, sabVoting, 'MINT_ROLE', communityVoting)
        await assertRole(acl, sabTokenManager, sabVoting, 'BURN_ROLE', communityVoting)

        await assertMissingRole(acl, sabTokenManager, 'ISSUE_ROLE')
        await assertMissingRole(acl, sabTokenManager, 'ASSIGN_ROLE')
        await assertMissingRole(acl, sabTokenManager, 'REVOKE_VESTINGS_ROLE')
      })
    }

    const itSetsUpSabVotingCorrectly = () => {
      it('should setup sab voting app correctly', async () => {
        assert.isTrue(await sabVoting.hasInitialized(), 'voting not initialized')
        assert.equal((await sabVoting.supportRequiredPct()).toString(), SAB_SUPPORT_REQUIRED)
        assert.equal((await sabVoting.minAcceptQuorumPct()).toString(), SAB_MIN_ACCEPTANCE_QUORUM)
        assert.equal((await sabVoting.voteTime()).toString(), SAB_VOTE_DURATION)
        assert.equal((await sabVoting.votesLength()).toNumber(), 0, 'no vote should exist')

        await assertRole(acl, sabVoting, sabVoting, 'CREATE_VOTES_ROLE', sabTokenManager)
        await assertRole(acl, sabVoting, sabVoting, 'MODIFY_QUORUM_ROLE')
        await assertRole(acl, sabVoting, sabVoting, 'MODIFY_SUPPORT_ROLE')
      })
    }

    const itSetsUpTokenWrapperCorrectly = () => {
      it('should setup mana token wrapper correctly', async () => {
        assert.isTrue(await tokenWrapper.hasInitialized(), 'token wrapper not initialized')
        assert.equal(await tokenWrapper.depositedToken(), mana.address, 'attached to correct token')
        assert.equal(await tokenWrapper.name(), WRAPPED_TOKEN_NAME)
        assert.equal(await tokenWrapper.symbol(), WRAPPED_TOKEN_SYMBOL)

        // ERC20Sample doesn't implement decimals
        await assertRevert(tokenWrapper.decimals())

        // Check that the "install" permission was granted
        async function assertRole(acl, app, manager, permission, grantee = manager) {
          const managerAddress = await acl.getPermissionManager(app.address, permission)

          assert.equal(web3.toChecksumAddress(managerAddress), web3.toChecksumAddress(manager.address), `${app.address} ${permission} Manager should match`)
          assert.isTrue(await acl.hasPermission(grantee.address, app.address, permission), `Grantee should have ${app.address} role ${permission}`)
        }
        await assertRole(acl, tokenWrapper, sabVoting, MAX_UINT256, { address: MAX_ADDRESS })
      })
    }

    const itSetsUpVotingAggregatorCorrectly = () => {
    }

    const itOperatesCorrectly = () => {
    }

    itCostsUpTo()
    itSetsUpDAOCorrectly()
    itSetsUpAgentCorrectly()
    itSetsUpCommunityVotingCorrectly()
    itSetsUpSabTokenManagerCorrectly()
    itSetsUpSabVotingCorrectly()
    itSetsUpTokenWrapperCorrectly()
    itSetsUpVotingAggregatorCorrectly()
    itOperatesCorrectly()
  })
})
