pragma solidity 0.4.24;

import "../../DecentralandTemplate.sol";


contract MockDecentralandTemplate is DecentralandTemplate {
    /*
    * ONLY FOR TESTING: use base aragonpm.eth namehashes because the test scaffolding doesn't
    * support adding apps from multiple aragonPM registries yet
    *
    * bytes32 constant internal TOKEN_WRAPPER_APP_ID = namehash("token-wrapper.aragonpm.eth");
    * bytes32 constant internal VOTING_AGGREGATOR_APP_ID = namehash('voting-aggregator.aragonpm.eth");
    */
    bytes32 constant private TOKEN_WRAPPER_APP_ID = 0x84fda9a3c8655fa3cc349a8375729741fc6f4cacca230ed8bfb04b38e833a961;
    bytes32 constant private VOTING_AGGREGATOR_APP_ID = 0x1ccd8033893dd34d6681897cca56b623b6498e79e57c2b1e489a3d6fc136cf1d;

    constructor(DAOFactory _daoFactory, ENS _ens, MiniMeTokenFactory _miniMeFactory, IFIFSResolvingRegistrar _aragonID)
        DecentralandTemplate(_daoFactory, _ens, _miniMeFactory, _aragonID)
        public
    {
        // solium-disable-previous-line no-empty-blocks
    }

    function _getTokenWrapperAppId() internal view returns (bytes32) {
        return TOKEN_WRAPPER_APP_ID;
    }

    function _getVotingAggregatorAppId() internal view returns (bytes32) {
        return VOTING_AGGREGATOR_APP_ID;
    }
}
