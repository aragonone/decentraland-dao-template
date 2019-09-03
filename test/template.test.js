const { hash: namehash } = require('eth-ens-namehash')
const { randomId } = require('@aragon/templates-shared/helpers/aragonId')
const { getEventArgument } = require('@aragon/test-helpers/events')
const { deployedAddresses } = require('@aragon/templates-shared/lib/arapp-file')(web3)

const ENS = artifacts.require('ENS')
const ACL = artifacts.require('ACL')
const Kernel = artifacts.require('Kernel')
const PublicResolver = artifacts.require('PublicResolver')
const DecentralandTemplate = artifacts.require('DecentralandTemplate')

contract('DecentralandTemplate', ([owner]) => {
  let dao, acl, template, ens, daoID

  before('fetch template and ENS', async () => {
    const { registry, address } = await deployedAddresses()
    ens = ENS.at(registry)
    template = DecentralandTemplate.at(address)
  })

  before('create and initialize DAO', async () => {
    daoID = randomId()
    const instanceReceipt = await template.newInstance(daoID)
    dao = Kernel.at(getEventArgument(instanceReceipt, 'DeployDao', 'dao'))
    acl = ACL.at(await dao.acl())
  })

  it('registers a new DAO on ENS', async () => {
    const aragonIdNameHash = namehash(`${daoID}.aragonid.eth`)
    const resolvedAddress = await PublicResolver.at(await ens.resolver(aragonIdNameHash)).addr(aragonIdNameHash)
    assert.equal(resolvedAddress, dao.address, 'aragonId ENS name does not match')
  })
})
