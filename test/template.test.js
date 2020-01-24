/* global contract artifacts web3 assert */

const { hash: namehash } = require('eth-ens-namehash')

const { APP_IDS } = require('@aragon/templates-shared/helpers/apps')
const { randomId } = require('@aragon/templates-shared/helpers/aragonId')
const {
  assertRole,
  assertMissingRole,
  assertRoleNotGranted
} = require('@aragon/templates-shared/helpers/assertRole')(web3)
const assertRevert = require('@aragon/templates-shared/helpers/assertRevert')(web3)
const { getInstalledApps, getInstalledAppsById } = require('@aragon/templates-shared/helpers/events')(artifacts)
const { getENS, getTemplateAddress } = require('@aragon/templates-shared/lib/ens')(web3, artifacts)

const { getEventArgument } = require('@aragon/test-helpers/events')
const { EMPTY_SCRIPT, encodeCallScript } = require('@aragon/test-helpers/evmScript')

const { decodeEventsOfType } = require('./helpers')

// Misc.
const ERC20 = artifacts.require('ERC20Sample')
const MiniMeToken = artifacts.require('MiniMeToken')

// ENS
const PublicResolver = artifacts.require('PublicResolver')

// aragonOS core
const ACL = artifacts.require('ACL')
const EVMScriptRegistry = artifacts.require('EVMScriptRegistry')
const Kernel = artifacts.require('Kernel')

// aragonId
const FIFSResolvingRegistrar = artifacts.require('FIFSResolvingRegistrar')

// aragon-apps
const Agent = artifacts.require('Agent')
const Finance = artifacts.require('Finance')
const TokenManager = artifacts.require('TokenManager')
const Voting = artifacts.require('Voting')

// aragonone-apps
const TokenWrapper = artifacts.require('TokenWrapper')
const VotingAggregator = artifacts.require('VotingAggregator')

const MockDecentralandTemplate = artifacts.require('MockDecentralandTemplate')

const ONE_DAY = 60 * 60 * 24
const ONE_WEEK = ONE_DAY * 7
const THIRTY_DAYS = ONE_DAY * 30
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MAX_ADDRESS = '0xffffffffffffffffffffffffffffffffffffffff'
const MAX_UINT256 = new web3.BigNumber(2).toPower(256).minus(1)

const DEFAULT_FINANCE_PERIOD = 0

const bn = x => new web3.BigNumber(x)
const bigExp = (x, y) => bn(x).times(bn(10).toPower(y))
const pct16 = x => bigExp(x, 16)

function assertAddressesEqual(address1, address2, message) {
  const checksummedAddress1 = web3.toChecksumAddress(address1)
  const checksummedAddress2 = web3.toChecksumAddress(address2)

  return assert.equal(checksummedAddress1, checksummedAddress2, message)
}

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

  const VOTING_AGGREGATOR_POWER_SOURCE_TYPES = {
    Invalid: '0',
    ERC20WithCheckpointing: '1',
    ERC900: '2',
  }

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
            SAB_VOTING_SETTINGS,
            DEFAULT_FINANCE_PERIOD
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
          template.finalizeInstance(
            randomId(),
            COMMUNITY_VOTING_SETTINGS,
            [],
            SAB_VOTING_SETTINGS,
            DEFAULT_FINANCE_PERIOD,
            { from: owner }
          ),
          'DECENTRALAND_MISSING_SAB_MEMBERS'
        )
      })

      // Note that missing voting settings are always filled in by solidity as 0
    })
  })

  context('when the creation succeeds', () => {
    let prepareReceipt, finalizeReceipt
    let dao, acl, sabToken
    let agent, communityVoting, finance, sabTokenManager, sabVoting, tokenWrapper, votingAggregator

    const createDAO = async (daoId, financePeriod) => {
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

        assert.equal(installedApps.finance.length, 1, 'should have installed 1 finance app')
        finance = Finance.at(installedApps.finance[0])

        assert.equal(installedApps['token-manager'].length, 1, 'should have installed 1 token manager app')
        sabTokenManager = TokenManager.at(installedApps['token-manager'][0])

        assert.equal(installedApps.voting.length, 2, 'should have installed 2 voting apps')
        sabVoting = Voting.at(installedApps.voting[0])
        communityVoting = Voting.at(installedApps.voting[1])

        assert.equal(installedApps['token-wrapper'].length, 1, 'should have installed 1 token wrapper app')
        tokenWrapper = TokenWrapper.at(installedApps['token-wrapper'][0])

        assert.equal(installedApps['voting-aggregator'].length, 1, 'should have installed 1 voting aggregator app')
        votingAggregator = VotingAggregator.at(installedApps['voting-aggregator'][0])

        assertAddressesEqual(dao.address, getEventArgument(finalizeReceipt, 'SetupDao', 'dao'), 'should have emitted a SetupDao event')
      }

      prepareReceipt = await prepareInstance(mana.address, { from: owner })
      finalizeReceipt = await template.finalizeInstance(
        daoId,
        COMMUNITY_VOTING_SETTINGS,
        SAB_MEMBERS,
        SAB_VOTING_SETTINGS,
        financePeriod,
        { from: owner }
      )
      await loadDAO(prepareReceipt, finalizeReceipt)

      return {
        prepareReceipt,
        finalizeReceipt
      }
    }

    const itCostsUpTo = (expectedCosts) => {
      const { expectedPrepareCost, expectedFinalizeCost } = expectedCosts

      it(`prepare's gas costs must be up to ~${expectedPrepareCost} gas`, async () => {
        const prepareCost = prepareReceipt.receipt.gasUsed
        assert.isAtMost(prepareCost, expectedPrepareCost, `dao creation call should cost up to ${expectedPrepareCost} gas`)
      })

      it(`finalize's gas costs must be up to ~${expectedFinalizeCost} gas`, async () => {
        const finalizeCost = finalizeReceipt.receipt.gasUsed
        assert.isAtMost(finalizeCost, expectedFinalizeCost, `dao creation call should cost up to ${expectedFinalizeCost} gas`)
      })
    }

    describe('when assigning id', () => {
      describe('when using default finance period', () => {
        const daoId = randomId()

        before('create dao', async () => {
          await createDAO(daoId, DEFAULT_FINANCE_PERIOD)
        })

        const itSetsUpDAOCorrectly = () => {
          it('registers a new DAO on ENS', async () => {
            // Check ENS
            const aragonIdNameHash = namehash(`${daoId}.aragonid.eth`)
            const resolvedAddress = await PublicResolver.at(await ens.resolver(aragonIdNameHash)).addr(aragonIdNameHash)
            assertAddressesEqual(resolvedAddress, dao.address, 'aragonId ENS name does not match')

            // Check aragonId
            const rawFinalizeReceipt = await web3.eth.getTransactionReceipt(finalizeReceipt.tx)
            const aragonIdClaimSubdomainEvent = decodeEventsOfType(rawFinalizeReceipt, FIFSResolvingRegistrar.abi, 'ClaimSubdomain')
            assert.equal(aragonIdClaimSubdomainEvent.length, 1, 'aragonId should have emitted claim subdomain event')
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
            assertAddressesEqual(await agent.designatedSigner(), ZERO_ADDRESS)

            assert.equal(await dao.recoveryVaultAppId(), APP_IDS.agent, 'agent app is not being used as the vault app of the DAO')
            assertAddressesEqual(await dao.getRecoveryVault(), agent.address, 'agent app is not being used as the vault app of the DAO')

            await assertRole(acl, agent, sabVoting, 'EXECUTE_ROLE')
            await assertRole(acl, agent, sabVoting, 'RUN_SCRIPT_ROLE')
            await assertRole(acl, agent, sabVoting, 'EXECUTE_ROLE', communityVoting)
            await assertRole(acl, agent, sabVoting, 'RUN_SCRIPT_ROLE', communityVoting)

            await assertMissingRole(acl, agent, 'DESIGNATE_SIGNER_ROLE')
            await assertMissingRole(acl, agent, 'ADD_PRESIGNED_HASH_ROLE')
          })
        }

        const itSetsUpFinanceCorrectly = () => {
          it('should have finance app correctly setup', async () => {
            assert.isTrue(await finance.hasInitialized(), 'finance not initialized')

            assert.equal((await finance.getPeriodDuration()).toString(), THIRTY_DAYS, 'finance period should be 30 days')

            await assertRole(acl, finance, sabVoting, 'CREATE_PAYMENTS_ROLE')
            await assertRole(acl, finance, sabVoting, 'EXECUTE_PAYMENTS_ROLE')
            await assertRole(acl, finance, sabVoting, 'MANAGE_PAYMENTS_ROLE')

            await assertMissingRole(acl, finance, 'CHANGE_PERIOD_ROLE')
            await assertMissingRole(acl, finance, 'CHANGE_BUDGETS_ROLE')
          })
        }

        const itSetsUpCommunityVotingCorrectly = () => {
          it('should setup community voting app correctly', async () => {
            assert.isTrue(await communityVoting.hasInitialized(), 'voting not initialized')
            assertAddressesEqual(await communityVoting.token(), votingAggregator.address)
            assert.equal((await communityVoting.supportRequiredPct()).toString(), COMMUNITY_SUPPORT_REQUIRED)
            assert.equal((await communityVoting.minAcceptQuorumPct()).toString(), COMMUNITY_MIN_ACCEPTANCE_QUORUM)
            assert.equal((await communityVoting.voteTime()).toString(), COMMUNITY_VOTE_DURATION)
            assert.equal(await communityVoting.votesLength(), '0', 'no vote should exist')

            await assertRole(acl, communityVoting, sabVoting, 'CREATE_VOTES_ROLE', sabTokenManager)
            await assertRole(acl, communityVoting, sabVoting, 'MODIFY_QUORUM_ROLE')
            await assertRole(acl, communityVoting, sabVoting, 'MODIFY_SUPPORT_ROLE')
          })
        }

        const itSetsUpSabTokenManagerCorrectly = () => {
          it('should setup sab token manager app correctly', async () => {
            assert.isTrue(await sabTokenManager.hasInitialized(), 'sab token manager not initialized')
            assertAddressesEqual(await sabTokenManager.token(), sabToken.address)
            assert.equal((await sabTokenManager.maxAccountTokens()).toString(), '1', 'sab token manager should only allow one token per holder')
            assert.isFalse(await sabToken.transfersEnabled(), 'sab token should disallow transfers')

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
            assertAddressesEqual(await sabVoting.token(), sabToken.address)
            assert.equal((await sabVoting.supportRequiredPct()).toString(), SAB_SUPPORT_REQUIRED)
            assert.equal((await sabVoting.minAcceptQuorumPct()).toString(), SAB_MIN_ACCEPTANCE_QUORUM)
            assert.equal((await sabVoting.voteTime()).toString(), SAB_VOTE_DURATION)
            assert.equal(await sabVoting.votesLength(), '0', 'no vote should exist')

            await assertRole(acl, sabVoting, sabVoting, 'CREATE_VOTES_ROLE', sabTokenManager)
            await assertRole(acl, sabVoting, sabVoting, 'MODIFY_QUORUM_ROLE')
            await assertRole(acl, sabVoting, sabVoting, 'MODIFY_SUPPORT_ROLE')
          })
        }

        const itSetsUpTokenWrapperCorrectly = () => {
          it('should setup mana token wrapper correctly', async () => {
            assert.isTrue(await tokenWrapper.hasInitialized(), 'token wrapper not initialized')
            assertAddressesEqual(await tokenWrapper.depositedToken(), mana.address, 'attached to correct token')
            assert.equal(await tokenWrapper.name(), WRAPPED_TOKEN_NAME)
            assert.equal(await tokenWrapper.symbol(), WRAPPED_TOKEN_SYMBOL)

            // ERC20Sample doesn't implement decimals
            await assertRevert(tokenWrapper.decimals())

            // Check that the "install" permission was granted
            async function assertRole(acl, app, manager, permission, grantee = manager) {
              const managerAddress = await acl.getPermissionManager(app.address, permission)

              assertAddressesEqual(managerAddress, manager.address, `${app.address} ${permission} Manager should match`)
              assert.isTrue(await acl.hasPermission(grantee.address, app.address, permission), `Grantee should have ${app.address} role ${permission}`)
            }
            await assertRole(acl, tokenWrapper, sabVoting, MAX_UINT256, { address: MAX_ADDRESS })
          })
        }

        const itSetsUpVotingAggregatorCorrectly = () => {
          it('should setup voting aggregator correctly', async () => {
            assert.isTrue(await votingAggregator.hasInitialized(), 'voting aggregator not initialized')
            assert.equal(await votingAggregator.decimals(), '18')
            assert.equal(await votingAggregator.name(), AGGREGATE_TOKEN_NAME)
            assert.equal(await votingAggregator.symbol(), AGGREGATE_TOKEN_SYMBOL)

            // Has added token wrapper as a source
            const sourceAddress = await votingAggregator.powerSources(0)
            assertAddressesEqual(sourceAddress, tokenWrapper.address, 'voting aggregator\'s initial source is not token wrapper')

            const [sourceType, sourceEnabled, sourceWeight] = await votingAggregator.getPowerSourceDetails(tokenWrapper.address)
            assert.equal(sourceType, VOTING_AGGREGATOR_POWER_SOURCE_TYPES.ERC20WithCheckpointing, 'voting aggregator\'s initial type is not checkpointed erc20')
            assert.isTrue(sourceEnabled, 'voting aggregator\'s initial status is not enabled')
            assert.equal(sourceWeight, '1', 'voting aggregator\'s token wrapper source weight is not 1')
            assert.equal(await votingAggregator.getPowerSourcesLength(), '1', 'voting aggregator should only have one source initially')

            await assertRole(acl, votingAggregator, sabVoting, 'ADD_POWER_SOURCE_ROLE')
            await assertRole(acl, votingAggregator, sabVoting, 'MANAGE_POWER_SOURCE_ROLE')
            await assertRole(acl, votingAggregator, sabVoting, 'MANAGE_WEIGHTS_ROLE')
          })
        }

        const itOperatesCorrectly = () => {
          // NOTE: these tests are not exhaustive, are all sequential and rely entirely on being run in order!

          describe('when interacting with token wrapper', () => {
            let account

            describe('when account is not a holder of MANA', () => {
              before(() => {
                account = someone
              })

              it('does not start with any voting power', async () => {
                assert.equal((await tokenWrapper.balanceOf(account)).toString(), '0', 'account should not hold wMANA')
                assert.equal((await votingAggregator.balanceOf(account)).toString(), '0', 'account should not hold any aggregated voting power')
              })

              it('does not allow account to wrap tokens', async () => {
                // Sanity checks
                assert.equal((await mana.balanceOf(account)).toString(), '0', 'account should not hold MANA')

                // Act
                await mana.approve(tokenWrapper.address, 1, { from: account })
                await assertRevert(tokenWrapper.deposit(1, { from: account }))
              })
            })

            describe('when account is holder of MANA', () => {
              let currentBalance
              let currentWrappedBalance

              before(async () => {
                account = holder
                currentBalance = bn(await mana.balanceOf(account))
                currentWrappedBalance = bn(await tokenWrapper.balanceOf(account))
              })

              it('has existing token balance', async () => {
                assert.isAbove(currentBalance.toNumber(), 0, 'account should hold MANA')
              })

              it('does not start with any voting power', async () => {
                assert.equal(currentWrappedBalance, '0', 'account should not hold wMANA yet')
                assert.equal((await votingAggregator.balanceOf(account)).toString(), '0', 'account should not hold any aggregated voting power yet')
              })

              it('can wrap tokens to gain voting power', async () => {
                const wrappedAmount = '100'
                const previousBalance = currentBalance

                await mana.approve(tokenWrapper.address, wrappedAmount, { from: account })
                await tokenWrapper.deposit(wrappedAmount, { from: account })

                currentBalance = bn(await mana.balanceOf(account))
                currentWrappedBalance = bn(await tokenWrapper.balanceOf(account))
                assert.equal(currentWrappedBalance, wrappedAmount, 'account should have correct wMANA balance')
                assert.equal(
                  (await votingAggregator.balanceOf(account)).toString(),
                  currentWrappedBalance.toString(),
                  'account should have correct aggregated voting power'
                )
                assert.equal(
                  (await mana.balanceOf(account)).toString(),
                  previousBalance.minus(wrappedAmount).toString(),
                  'account should have correct MANA balance'
                )
              })

              it('can unwrap tokens', async () => {
                const withdrawAmount = '10'
                const previousBalance = currentBalance
                const previousWrappedBalance = currentWrappedBalance

                await tokenWrapper.withdraw(withdrawAmount, { from: account })

                currentBalance = bn(await mana.balanceOf(account))
                currentWrappedBalance = bn(await tokenWrapper.balanceOf(account))
                assert.equal(
                  currentWrappedBalance.toString(),
                  previousWrappedBalance.minus(withdrawAmount).toString(),
                  'account should have correct wMANA balance'
                )
                assert.equal(
                  (await votingAggregator.balanceOf(account)).toString(),
                  currentWrappedBalance.toString(),
                  'account should have correct wMANA balance'
                )
                assert.equal(
                  (await mana.balanceOf(account)).toString(),
                  previousBalance.plus(withdrawAmount).toString(),
                  'account should have correct MANA balance'
                )
              })

              it('cannot wrap invalid amounts', async () => {
                await assertRevert(tokenWrapper.deposit(0, { from: account }), 'TW_DEPOSIT_AMOUNT_ZERO')

                // When approval is set to 0
                await mana.approve(tokenWrapper.address, 0, { from: account })
                await assertRevert(tokenWrapper.deposit('1', { from: account }), 'TW_TOKEN_TRANSFER_FROM_FAILED')

                // When approval is high enough but balance not enough
                await mana.approve(tokenWrapper.address, MAX_UINT256, { from: account })
                await assertRevert(tokenWrapper.deposit(currentBalance.plus(1), { from: account }), 'TW_TOKEN_TRANSFER_FROM_FAILED')

                // Clean up
                await mana.approve(tokenWrapper.address, 0, { from: account })
              })

              it('can not unwrap invalid amounts', async () => {
                await assertRevert(tokenWrapper.withdraw(0, { from: account }), 'TW_WITHDRAW_AMOUNT_ZERO')

                const currentWrappedBalance = new web3.BigNumber(await tokenWrapper.balanceOf(account))
                await assertRevert(tokenWrapper.withdraw(currentWrappedBalance.plus(1), { from: account }), 'TW_INVALID_WITHDRAW_AMOUNT')
              })
            })
          })

          describe('when interacting with community voting', () => {
            let votingInstance
            let createVoteScript

            before(() => {
              votingInstance = communityVoting

              const action = {
                to: votingInstance.address,
                calldata: votingInstance.contract.newVote.getData(EMPTY_SCRIPT, 'Vote metadata')
              }
              createVoteScript = encodeCallScript([action])
            })

            for (const [account, name] of [[someone, 'someone'], [holder, 'holder'], [member1, 'sab member']]) {
              it(`does not allow ${name} to create votes directly`, async () => {
                await assertRoleNotGranted(acl, votingInstance, 'CREATE_VOTES_ROLE', { address: account })
                await assertRevert(votingInstance.newVote(EMPTY_SCRIPT, 'Vote metadata', { from: account }))
              })
            }

            for (const [account, name] of [[someone, 'someone'], [holder, 'holder']]) {
              it(`does not allow ${name} to create votes by forwarding through sab token manager`, async () => {
                assert.equal((await sabToken.balanceOf(account)).toString(), '0')
                assert.isFalse(await sabTokenManager.canForward(account, createVoteScript))
                await assertRevert(sabTokenManager.forward(createVoteScript, { from: account }))
              })
            }

            it('does not allow holder to create votes by forwarding through voting aggregator', async () => {
              assert.isTrue(await votingAggregator.canForward(holder, createVoteScript))
              // Even though holder can forward through the VotingAggregator, they can't create new votes
              await assertRevert(votingAggregator.forward(createVoteScript, { from: holder }))
            })

            it('sab member can create votes by forwarding through sab token manager', async () => {
              assert.isTrue(await sabTokenManager.canForward(member1, createVoteScript))
              await sabTokenManager.forward(createVoteScript, { from: member1 })

              assert.equal(await votingInstance.votesLength(), '1', 'a vote should exist')
            })

            it('allows a holder to vote', async () => {
              await votingInstance.vote(0, true, false, { from: holder })
            })

            it('does not allow a non holder to vote', async () => {
              await assertRevert(
                votingInstance.vote(0, true, false, { from: someone }),
                'VOTING_CAN_NOT_VOTE'
              )
            })
          })

          describe('when interacting with sab voting', () => {
            let votingInstance
            let createVoteScript

            before(() => {
              votingInstance = sabVoting

              const action = {
                to: votingInstance.address,
                calldata: votingInstance.contract.newVote.getData(EMPTY_SCRIPT, 'Vote metadata')
              }
              createVoteScript = encodeCallScript([action])
            })

            for (const [account, name] of [[someone, 'someone'], [holder, 'holder'], [member1, 'sab member']]) {
              it(`does not allow ${name} to create votes directly`, async () => {
                await assertRoleNotGranted(acl, votingInstance, 'CREATE_VOTES_ROLE', { address: account })
                await assertRevert(votingInstance.newVote(EMPTY_SCRIPT, 'Vote metadata', { from: account }))
              })
            }

            for (const [account, name] of [[someone, 'someone'], [holder, 'holder']]) {
              it(`does not allow ${name} to create votes by forwarding through sab token manager`, async () => {
                assert.equal((await sabToken.balanceOf(account)).toString(), '0')
                assert.isFalse(await sabTokenManager.canForward(account, createVoteScript))
                await assertRevert(sabTokenManager.forward(createVoteScript, { from: account }))
              })
            }

            it('does not allow holder to create votes by forwarding through voting aggregator', async () => {
              assert.isTrue(await votingAggregator.canForward(holder, createVoteScript))
              // Even though holder can forward through the VotingAggregator, they can't create new votes
              await assertRevert(votingAggregator.forward(createVoteScript, { from: holder }))
            })

            it('sab member can create votes by forwarding through sab token manager', async () => {
              assert.isTrue(await sabTokenManager.canForward(member1, createVoteScript))
              await sabTokenManager.forward(createVoteScript, { from: member1 })

              assert.equal(await votingInstance.votesLength(), '1', 'a vote should exist')
            })

            it('allows a sab member to vote', async () => {
              await votingInstance.vote(0, true, false, { from: member1 })
            })

            for (const account of [someone, holder]) {
              it(`does not allow ${account === someone ? 'someone' : 'a MANA holder'} to vote`, async () => {
                await assertRevert(
                  votingInstance.vote(0, true, false, { from: account }),
                  'VOTING_CAN_NOT_VOTE'
                )
              })
            }
          })
        }

        itCostsUpTo({ expectedPrepareCost: 2.9e6, expectedFinalizeCost: 6.51e6 })
        itSetsUpDAOCorrectly()
        itSetsUpAgentCorrectly()
        itSetsUpFinanceCorrectly()
        itSetsUpCommunityVotingCorrectly()
        itSetsUpSabTokenManagerCorrectly()
        itSetsUpSabVotingCorrectly()
        itSetsUpTokenWrapperCorrectly()
        itSetsUpVotingAggregatorCorrectly()
        itOperatesCorrectly()
      })

      describe('when using configured finance period', () => {
        const daoId = randomId()
        const FINANCE_PERIOD = 60 * 60 * 24 * 15 // 15 days

        before('create dao', async () => {
          await createDAO(daoId, FINANCE_PERIOD)
        })

        const itSetsUpFinanceCorrectly = () => {
          it('should have finance app correctly setup', async () => {
            assert.isTrue(await finance.hasInitialized(), 'finance not initialized')

            assert.equal((await finance.getPeriodDuration()).toString(), FINANCE_PERIOD, 'finance period should be 30 days')

            await assertRole(acl, finance, sabVoting, 'CREATE_PAYMENTS_ROLE')
            await assertRole(acl, finance, sabVoting, 'EXECUTE_PAYMENTS_ROLE')
            await assertRole(acl, finance, sabVoting, 'MANAGE_PAYMENTS_ROLE')

            await assertMissingRole(acl, finance, 'CHANGE_PERIOD_ROLE')
            await assertMissingRole(acl, finance, 'CHANGE_BUDGETS_ROLE')
          })
        }

        itCostsUpTo({ expectedPrepareCost: 2.9e6, expectedFinalizeCost: 6.51e6 })
        itSetsUpFinanceCorrectly()
      })
    })

    describe('when not assigning id', () => {
      before('create dao', async () => {
        await createDAO('', DEFAULT_FINANCE_PERIOD) // use default finance period
      })

      const itSetsUpDAOCorrectly = () => {
        it('does not register a new DAO on ENS', async () => {
          const rawFinalizeReceipt = await web3.eth.getTransactionReceipt(finalizeReceipt.tx)
          const aragonIdClaimSubdomainEvent = decodeEventsOfType(rawFinalizeReceipt, FIFSResolvingRegistrar.abi, 'ClaimSubdomain')
          assert.equal(aragonIdClaimSubdomainEvent.length, 0, 'aragonId should not have emitted claim subdomain event')
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

      itCostsUpTo({ expectedPrepareCost: 2.9e6, expectedFinalizeCost: 6.41e6 })
      itSetsUpDAOCorrectly()
    })
  })
})
