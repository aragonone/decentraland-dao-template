/* global web3 artifacts */

const { APPS } = require('@aragon/templates-shared/helpers/apps')
const deployTemplate = require('@aragon/templates-shared/scripts/deploy-template')

const TEMPLATE_NAME = 'decentraland-template'
const CONTRACT_NAME = 'DecentralandTemplate'

const apps = [
  ...APPS,
  { name: 'token-wrapper', contractName: 'TokenWrapper' },
  { name: 'voting-aggregator', contractName: 'VotingAggregator' }
]

module.exports = callback => {
  deployTemplate(web3, artifacts, TEMPLATE_NAME, CONTRACT_NAME, apps)
    .then(() => {
      callback()
    })
    .catch(callback)
}
