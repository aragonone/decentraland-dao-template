/* global web3 artifacts */

const { APPS } = require('@aragon/templates-shared/helpers/apps')
const deployTemplate = require('@aragon/templates-shared/scripts/deploy-template')

const TEMPLATE_NAME = 'decentraland-template'
const CONTRACT_NAME = 'MockDecentralandTemplate'

const apps = [
  ...APPS,
  // Use the base aragonPM instance for these two apps as the deployer doesn't support deploying
  // apps to multiple aragonPM registries yet
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
