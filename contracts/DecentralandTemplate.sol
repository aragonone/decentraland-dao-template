pragma solidity 0.4.24;

import "@aragon/templates-shared/contracts/TokenCache.sol";
import "@aragon/templates-shared/contracts/BaseTemplate.sol";

import "@aragon/token-wrapper/contracts/TokenWrapper.sol";


contract DecentralandTemplate is BaseTemplate, TokenCache {
    bytes32 constant internal TOKEN_WRAPPER_APP_ID = 0x84fda9a3c8655fa3cc349a8375729741fc6f4cacca230ed8bfb04b38e833a961;

    string constant private ERROR_BAD_VOTE_SETTINGS = "COMPANY_BAD_VOTE_SETTINGS";

    bool constant private TOKEN_TRANSFERABLE = false;
    uint8 constant private TOKEN_DECIMALS = uint8(18);
    uint256 constant private TOKEN_MAX_PER_ACCOUNT = uint256(0);

    constructor(DAOFactory _daoFactory, ENS _ens, MiniMeTokenFactory _miniMeFactory, IFIFSResolvingRegistrar _aragonID)
        BaseTemplate(_daoFactory, _ens, _miniMeFactory, _aragonID)
        public
    {
        _ensureAragonIdIsValid(_aragonID);
        _ensureMiniMeFactoryIsValid(_miniMeFactory);
    }

    function newToken(string memory _name, string memory _symbol) public returns (MiniMeToken) {
        MiniMeToken token = _createToken(_name, _symbol, TOKEN_DECIMALS);
        _cacheToken(token, msg.sender);
        return token;
    }

    function newInstance(string memory _id, ERC20 _mana, uint64[3] memory _votingSettings) public {
        // TODO: Uncomment when updated to @aragon/templates-shared 1.0.0-rc.2
        // _validateId(_id);
        _validateVotingSettings(_votingSettings);

        (Kernel dao, ACL acl) = _createDAO();
        Voting voting = _setupApps(dao, acl, _mana, _votingSettings);

        _transferRootPermissionsFromTemplateAndFinalizeDAO(dao, voting);
        _registerID(_id, dao);
    }

    function _setupApps(Kernel _dao, ACL _acl, ERC20 _mana, uint64[3] memory _votingSettings) internal returns (Voting) {
        MiniMeToken token = _popTokenCache(msg.sender);
        Agent agent = _installDefaultAgentApp(_dao);
        Voting voting = _installVotingApp(_dao, token, _votingSettings);
        TokenWrapper tokenWrapper = _installTokenWrapperApp(_dao, token, _mana);

        _setupPermissions(_acl, agent, voting, tokenWrapper);

        return voting;
    }

    function _setupPermissions( ACL _acl, Agent _agent, Voting _voting, TokenWrapper _tokenWrapper) internal {
        _createAgentPermissions(_acl, _agent, _voting, _voting);
        _createEvmScriptsRegistryPermissions(_acl, _voting, _voting);
        _createVotingPermissions(_acl, _voting, _voting, _tokenWrapper, _voting);
    }

    function _installTokenWrapperApp(Kernel _dao, MiniMeToken _token, ERC20 _mana) internal returns (TokenWrapper) {
        TokenWrapper tokenWrapper = TokenWrapper(_installNonDefaultApp(_dao, TOKEN_WRAPPER_APP_ID));
        _token.changeController(tokenWrapper);
        tokenWrapper.initialize(_token, _mana);
        return tokenWrapper;
    }

    function _validateVotingSettings(uint64[3] memory _votingSettings) internal {
        require(_votingSettings.length == 3, ERROR_BAD_VOTE_SETTINGS);
    }
}
