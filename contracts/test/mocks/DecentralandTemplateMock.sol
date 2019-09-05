pragma solidity 0.4.24;

import "../../DecentralandTemplate.sol";


contract DecentralandTemplateMock is DecentralandTemplate {
    // Overriding token wrapper ID for testing purposes since we are publishing it under different APM repos
    bytes32 constant internal TOKEN_WRAPPER_APP_ID = apmNamehash("token-wrapper");

    constructor(DAOFactory _daoFactory, ENS _ens, MiniMeTokenFactory _miniMeFactory, IFIFSResolvingRegistrar _aragonID)
        DecentralandTemplate(_daoFactory, _ens, _miniMeFactory, _aragonID)
        public
    {}
}
