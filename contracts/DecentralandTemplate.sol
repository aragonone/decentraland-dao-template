pragma solidity 0.4.24;

import "@aragon/templates-shared/contracts/BaseTemplate.sol";

import "@aragon/os/contracts/lib/token/ERC20.sol";

import "@aragon/apps-agent/contracts/Agent.sol";
import "@aragon/apps-token-manager/contracts/TokenManager.sol";
import "@aragon/apps-voting/contracts/Voting.sol";
import "@aragon/apps-shared-minime/contracts/MiniMeToken.sol";

import "@aragonone/apps-token-wrapper/contracts/TokenWrapper.sol";
import "@aragonone/apps-voting-aggregator/contracts/VotingAggregator.sol";


contract DecentralandTemplate is BaseTemplate {
    string constant private ERROR_MISSING_CACHE = "DECENTRALAND_MISSING_CACHE";
    string constant private ERROR_BAD_EXTERNAL_TOKEN = "DECENTRALAND_BAD_EXTERNAL_TOKEN";
    string constant private ERROR_MISSING_SAB_MEMBERS = "DECENTRALAND_MISSING_SAB_MEMBERS";
    string constant private ERROR_BAD_VOTE_SETTINGS = "DECENTRALAND_BAD_VOTE_SETTINGS";

    /* Hardcoded constant to save gas
    * bytes32 constant internal TOKEN_WRAPPER_APP_ID = namehash("token-wrapper.hatch.aragonpm.eth");
    * bytes32 constant internal VOTING_AGGREGATOR_APP_ID = namehash('voting-aggregator.hatch.aragonpm.eth");
    */
    bytes32 constant private TOKEN_WRAPPER_APP_ID = 0xdab7adb04b01d9a3f85331236b5ce8f5fdc5eecb1eebefb6129bc7ace10de7bd;
    bytes32 constant private VOTING_AGGREGATOR_APP_ID = 0x818d8ea9df3dca764232c22548318a98f82f388b760b4b5abe80a4b40f9b2076;

    // Hardcoded settings
    uint8 constant private AGGREGATOR_DECIMALS = uint8(18);
    string constant private SAB_TOKEN_NAME = "Security Advisory Board Token";
    string constant private SAB_TOKEN_SYMBOL = "SAB";
    uint8 constant private SAB_TOKEN_DECIMALS = uint8(0);
    uint256 constant private SAB_TOKEN_MAX_PER_ACCOUNT = uint256(1);
    bool constant private SAB_TOKEN_TRANSFERABLE = false;

    struct Cache {
        address dao;
        address tokenWrapper;
        address votingAggregator;
    }

    mapping (address => Cache) internal cache;

    constructor(DAOFactory _daoFactory, ENS _ens, MiniMeTokenFactory _miniMeFactory, IFIFSResolvingRegistrar _aragonID)
        BaseTemplate(_daoFactory, _ens, _miniMeFactory, _aragonID)
        public
    {
        _ensureAragonIdIsValid(_aragonID);
        _ensureMiniMeFactoryIsValid(_miniMeFactory);
    }

    /**
    * @dev Create an incomplete DAO with its token connectors in place and cache it for later setup steps
    * @param _manaToWrap Address of external MANA token to wrap
    * @param _wrappedTokenName String to use as the name of the wrapped MANA token
    * @param _wrappedTokenSymbol String to use as the symbol of the wrapped MANA token
    * @param _aggregateTokenName String to use as the name of the aggregated voting token
    * @param _aggregateTokenSymbol String to use as the symbol of the aggregated voting token
    */
    function prepareInstanceWithVotingConnectors(
        ERC20 _manaToWrap,
        string _wrappedTokenName,
        string _wrappedTokenSymbol,
        string _aggregateTokenName,
        string _aggregateTokenSymbol
    )
        external
    {
        _validateExternalToken(_manaToWrap);

        // Create organization
        (Kernel dao, ACL acl) = _createDAO();

        // Install community voting apps
        TokenWrapper tokenWrapper = _installTokenWrapperApp(
            dao,
            _manaToWrap,
            _wrappedTokenName,
            _wrappedTokenSymbol
        );
        VotingAggregator votingAggregator = _installVotingAggregatorApp(
            dao,
            _aggregateTokenName,
            _aggregateTokenSymbol
        );
        _setupVotingAggregator(acl, votingAggregator, tokenWrapper);

        // Cache for next step
        _cachePreparedInstance(dao, tokenWrapper, votingAggregator);
    }

    /**
    * @dev Finalize a previously prepared DAO instance cached by the user
    * @param _id String with the name for org, will assign `[id].aragonid.eth`
    * @param _communityVotingSettings Array of [supportRequired, minAcceptanceQuorum, voteDuration] settings for the community Voting app
    * @param _sabMembers Array of initial security advisory board member addresses
    * @param _sabVotingSettings Array of [supportRequired, minAcceptanceQuorum, voteDuration] settings for the security advisory board Voting app
    */
    function finalizeInstance(
        string _id,
        uint64[3] _communityVotingSettings,
        address[] _sabMembers,
        uint64[3] _sabVotingSettings
    )
        external
    {
        _validateId(_id);
        _validateVotingSettings(_communityVotingSettings);
        _validateSabMembers(_sabMembers);
        _validateVotingSettings(_sabVotingSettings);

        (Kernel dao, TokenWrapper tokenWrapper, VotingAggregator votingAggregator) = _popCache();
        ACL acl = ACL(dao.acl());

        // Install and set up apps
        (TokenManager sabTokenManager, Voting sabVoting) = _setupSab(
            dao,
            acl,
            _sabMembers,
            _sabVotingSettings,
            tokenWrapper,
            votingAggregator
        );
        Voting communityVoting = _setupCommunityVoting(
            dao,
            acl,
            _communityVotingSettings,
            votingAggregator,
            sabTokenManager,
            sabVoting
        );
        _setupAgent(dao, acl, sabVoting, communityVoting);

        // Finalize org
        _transferRootPermissionsFromTemplateAndFinalizeDAO(dao, sabVoting);
        _registerID(_id, dao);
    }

    function _setupSab(
        Kernel _dao,
        ACL _acl,
        address[] memory _sabMembers,
        uint64[3] memory _sabVotingSettings,
        TokenWrapper _tokenWrapper,
        VotingAggregator _votingAggregator
    )
        internal
        returns (TokenManager, Voting)
    {
        // Install apps for security advisory board
        MiniMeToken sabToken = _createToken(SAB_TOKEN_NAME, SAB_TOKEN_SYMBOL, SAB_TOKEN_DECIMALS);
        Voting sabVoting = _installVotingApp(_dao, sabToken, _sabVotingSettings);
        TokenManager sabTokenManager = _installTokenManagerApp(
            _dao,
            sabToken,
            SAB_TOKEN_TRANSFERABLE,
            SAB_TOKEN_MAX_PER_ACCOUNT
        );
        _mintTokens(_acl, sabTokenManager, _sabMembers, 1);

        // Set permissions
        // TokenManager's will be assigned later as its permissions will be granted to the community voting app
        _createVotingPermissions(_acl, sabVoting, sabVoting, sabTokenManager, sabVoting);

        // Give permissions of already installed apps to SAB
        _createEvmScriptsRegistryPermissions(_acl, sabVoting, sabVoting);
        _createVotingAggregatorPermissions(_acl, _votingAggregator, sabVoting, sabVoting);

        // HACK: create a random permission on TokenWrapper so it is detected as an app
        // Set the manager to the SAB in case it ever needs to be uninstalled
        _acl.createPermission(address(-1), _tokenWrapper, bytes32(-1), sabVoting);

        return (sabTokenManager, sabVoting);
    }

    function _setupCommunityVoting(
        Kernel _dao,
        ACL _acl,
        uint64[3] memory _communityVotingSettings,
        VotingAggregator _votingAggregator,
        TokenManager _sabTokenManager,
        Voting _sabVoting
    )
        internal
        returns (Voting)
    {
        // Install community voting app using aggregator
        Voting communityVoting = _installVotingApp(
            _dao,
            // Pretend that the Voting Aggregator is a MiniMe
            MiniMeToken(_votingAggregator),
            _communityVotingSettings
        );

        // Set permissions
        _createVotingPermissions(_acl, communityVoting, _sabVoting, _sabTokenManager, _sabVoting);
        _createTokenManagerPermissions(_acl, _sabTokenManager, communityVoting, _sabVoting);

        return communityVoting;
    }

    function _setupAgent(Kernel _dao, ACL _acl, Voting _sabVoting, Voting _communityVoting) internal {
        Agent agent = _installDefaultAgentApp(_dao);

        // Set permissions
        bytes32 executeRole = agent.EXECUTE_ROLE();
        bytes32 runScriptRole = agent.RUN_SCRIPT_ROLE();

        // Initially set this template as the manager so we can grant additional permissions
        _acl.createPermission(_communityVoting, agent, executeRole, address(this));
        _acl.createPermission(_communityVoting, agent, runScriptRole, address(this));

        _acl.grantPermission(_sabVoting, agent, executeRole);
        _acl.grantPermission(_sabVoting, agent, runScriptRole);

        // Clean up permissions held by this template
        _acl.setPermissionManager(_sabVoting, agent, executeRole);
        _acl.setPermissionManager(_sabVoting, agent, runScriptRole);
    }

    function _installTokenWrapperApp(
        Kernel _dao,
        ERC20 _tokenToWrap,
        string memory _wrappedTokenName,
        string memory _wrappedTokenSymbol
    )
        internal returns (TokenWrapper)
    {
        bytes memory initializeData = abi.encodeWithSelector(TokenWrapper(0).initialize.selector, _tokenToWrap, _wrappedTokenName, _wrappedTokenSymbol);
        return TokenWrapper(_installNonDefaultApp(_dao, _getTokenWrapperAppId(), initializeData));
    }

    function _installVotingAggregatorApp(
        Kernel _dao,
        string memory _aggregateTokenName,
        string memory _aggregateTokenSymbol
    )
        internal returns (VotingAggregator)
    {
        bytes memory initializeData = abi.encodeWithSelector(VotingAggregator(0).initialize.selector, _aggregateTokenName, _aggregateTokenSymbol, AGGREGATOR_DECIMALS);
        return VotingAggregator(_installNonDefaultApp(_dao, _getVotingAggregatorAppId(), initializeData));
    }

    function _setupVotingAggregator(ACL _acl, VotingAggregator _votingAggregator, TokenWrapper _wrappedToken) internal {
        bytes32 addSourceRole = _votingAggregator.ADD_POWER_SOURCE_ROLE();

        // Add wrapped token as a power source with weight of 1
        _createPermissionForTemplate(_acl, _votingAggregator, addSourceRole);
        _votingAggregator.addPowerSource(address(_wrappedToken), VotingAggregator.PowerSourceType.ERC20WithCheckpointing, 1);
        _removePermissionFromTemplate(_acl, _votingAggregator, addSourceRole);
    }

    function _createVotingAggregatorPermissions(ACL _acl, VotingAggregator _votingAggregator, address _grantee, address _manager) internal {
        _acl.createPermission(_grantee, _votingAggregator, _votingAggregator.ADD_POWER_SOURCE_ROLE(), _manager);
        _acl.createPermission(_grantee, _votingAggregator, _votingAggregator.MANAGE_POWER_SOURCE_ROLE(), _manager);
        _acl.createPermission(_grantee, _votingAggregator, _votingAggregator.MANAGE_WEIGHTS_ROLE(), _manager);
    }

    function _cachePreparedInstance(
        Kernel _dao,
        TokenWrapper _tokenWrapper,
        VotingAggregator _votingAggregator
    )
        internal
    {
        Cache storage c = cache[msg.sender];
        c.dao = address(_dao);
        c.tokenWrapper = address(_tokenWrapper);
        c.votingAggregator = address(_votingAggregator);
    }

    function _popCache() internal returns (Kernel dao, TokenWrapper tokenWrapper, VotingAggregator votingAggregator) {
        Cache storage c = cache[msg.sender];

        dao = Kernel(c.dao);
        tokenWrapper = TokenWrapper(c.tokenWrapper);
        votingAggregator = VotingAggregator(c.votingAggregator);
        delete c.dao;
        delete c.tokenWrapper;
        delete c.votingAggregator;

        require(
            address(dao) != address(0) && address(tokenWrapper) != address(0) && address(votingAggregator) != address(0),
            ERROR_MISSING_CACHE
        );
    }

    function _getTokenWrapperAppId() internal view returns (bytes32) {
        return TOKEN_WRAPPER_APP_ID;
    }

    function _getVotingAggregatorAppId() internal view returns (bytes32) {
        return VOTING_AGGREGATOR_APP_ID;
    }

    function _validateExternalToken(ERC20 _token) private view {
        require(isContract(_token), ERROR_BAD_EXTERNAL_TOKEN);
    }

    function _validateSabMembers(address[] memory _sabMembers) private pure {
        require(_sabMembers.length > 0, ERROR_MISSING_SAB_MEMBERS);
    }

    function _validateVotingSettings(uint64[3] memory _votingSettings) private pure {
        require(_votingSettings.length == 3, ERROR_BAD_VOTE_SETTINGS);
    }
}
