const { APPS } = require('@aragon/templates-shared/helpers/apps')
const deployTemplate = require('@aragon/templates-shared/scripts/deploy-template')

const TEMPLATE_NAME = 'decentraland-template'
const CONTRACT_NAME = 'DecentralandTemplateMock'

const apps = [
  ...APPS,
  { name: 'token-wrapper', contractName: 'TokenWrapper' }
]

module.exports = callback => {
  deployTemplate(web3, artifacts, TEMPLATE_NAME, CONTRACT_NAME, apps)
    .then(template => {
      console.log(template.address)
      callback()
    })
    .catch(callback)
}
